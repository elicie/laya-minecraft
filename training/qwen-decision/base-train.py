"""Continue real LoRA training, then evaluate a separately sealed blind shard.

Training may run during the third live day; that day's records are never loaded
by the training phase. All model changes use stock Transformers/PEFT APIs.
"""
import argparse
import collections
import gc
import hashlib
import json
import math
import random
import time
from pathlib import Path
import torch
import torch.nn.functional as F
from peft import PeftModel, prepare_model_for_kbit_training
from transformers import AutoTokenizer
from transformers.utils import logging
from common import BASE, ROOT, code_ids, load_base, read_json, tokenize, write_json
from train import load_rows, evaluate, summarize
from metrics import probability_metrics, robustness_metrics
from serve import prepare_inference_base


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def temperatures(results, questions):
    answer = {}
    for task in questions:
        group = [r for r in results if r['task'] == task]
        if not group:
            raise ValueError('No independent calibration records for '+task)
        logits = torch.tensor([r['logits'] for r in group], dtype=torch.float32)
        actions = list(questions[task]['criteria'])
        labels = torch.tensor([actions.index(r['expected']) for r in group])
        # Sparse Minecraft calibration must not sharpen confidence artificially.
        grid = [10**(i/50) for i in range(51)]
        losses = [F.cross_entropy(logits/t, labels).item() for t in grid]
        best = min(range(len(grid)), key=losses.__getitem__)
        answer[task] = {'temperature': grid[best], 'items': len(group),
                        'negative_log_likelihood': losses[best],
                        'before_nll': F.cross_entropy(logits, labels).item()}
    return answer


def train(args, run, manifest):
    output = Path(manifest['adapter'])
    if output.exists() or (run/'training.json').exists():
        raise ValueError('Use a fresh experiment; trained weights are immutable')
    questions = manifest['questions']
    rows = load_rows(run, 'train', manifest)
    calibration = load_rows(run, 'calibration', manifest)
    tokenizer = AutoTokenizer.from_pretrained(str(BASE), padding_side='left')
    tokenizer.pad_token = tokenizer.pad_token or tokenizer.eos_token
    base = prepare_model_for_kbit_training(load_base(), use_gradient_checkpointing=True,
                                           gradient_checkpointing_kwargs={'use_reentrant': False})
    base.get_input_embeddings().to(torch.bfloat16)
    base.get_output_embeddings().to(torch.bfloat16)
    model = PeftModel.from_pretrained(base, manifest['parent_adapter'], is_trainable=True)
    parameters = [p for p in model.parameters() if p.requires_grad]
    initial = {name: p.detach().float().cpu().clone() for name, p in model.named_parameters() if p.requires_grad}
    encoded = {row['id']: tokenize(tokenizer, row['task'], row['state'],
                                    {row['task']: row['question']} if 'question' in row else questions) for row in rows}
    codes = torch.tensor(code_ids(tokenizer, 12), device='cuda')
    optimizer = torch.optim.AdamW(parameters, lr=args.lr, weight_decay=.01)
    total_steps = math.ceil(math.ceil(len(rows)/args.batch_size)/args.grad_accum)*args.epochs
    if not total_steps:
        raise ValueError('There are no reviewed training examples')
    started = time.perf_counter(); history = []; step = 0
    for epoch in range(args.epochs):
        shuffled = list(rows); random.shuffle(shuffled)
        batches = [shuffled[i:i+args.batch_size] for i in range(0, len(shuffled), args.batch_size)]
        model.train()
        for start in range(0, len(batches), args.grad_accum):
            group = batches[start:start+args.grad_accum]; optimizer.zero_grad(set_to_none=True); mean_loss = 0.
            for batch in group:
                inputs = tokenizer.pad({'input_ids': [encoded[r['id']] for r in batch]}, padding=True, return_tensors='pt').to('cuda')
                orders = [r.get('option_actions', list(questions[r['task']]['criteria'])) for r in batch]
                labels = torch.tensor([order.index(r['expected']) for order, r in zip(orders, batch)], device='cuda')
                valid = torch.tensor([[i < len(order) for i in range(12)] for order in orders], device='cuda')
                with torch.autocast('cuda', dtype=torch.bfloat16):
                    logits = model(**inputs, use_cache=False, logits_to_keep=1).logits[:, -1, codes].float()
                    loss = F.cross_entropy(logits.masked_fill(~valid, -10000), labels)
                if not torch.isfinite(loss):
                    raise ValueError('Non-finite training loss')
                (loss/len(group)).backward(); mean_loss += loss.item()/len(group)
            norm = torch.nn.utils.clip_grad_norm_(parameters, 1., error_if_nonfinite=True)
            factor = min(1., (step+1)/4)*(.2+.8*(1+math.cos(math.pi*step/total_steps))/2)
            for pg in optimizer.param_groups: pg['lr'] = args.lr*factor
            optimizer.step(); step += 1
            record = {'epoch': epoch+1, 'step': step, 'total_steps': total_steps,
                      'loss': round(mean_loss, 6), 'gradient_norm': round(norm.item(), 4),
                      'elapsed_seconds': round(time.perf_counter()-started, 1)}
            history.append(record)
            with (run/'progress.jsonl').open('a') as file: file.write(json.dumps(record)+'\n')
            if step == 1 or step % 8 == 0: print('TRAIN', json.dumps(record), flush=True)
    delta = sum((p.detach().float().cpu()-initial[name]).square().sum().item()
                for name, p in model.named_parameters() if name in initial)
    if step == 0 or not delta > 0:
        raise ValueError('No actual adapter weights changed')
    model.save_pretrained(str(output)); tokenizer.save_pretrained(str(output))
    weight_hash = file_hash(output/'adapter_model.safetensors')
    write_json(run/'training.json', {'optimizer_steps': step, 'epochs': args.epochs, 'lr': args.lr,
                                    'batch_size': args.batch_size, 'grad_accum': args.grad_accum,
                                    'trainable_parameters': sum(p.numel() for p in parameters),
                                    'weight_squared_delta_from_parent': delta, 'adapter_sha256': weight_hash,
                                    'train_split_sha256': manifest['split_sha256']['train'], 'history': history})
    model.eval()
    scores = evaluate(model, tokenizer, calibration, questions, args.eval_batch_size, 'INDEPENDENT CALIBRATION')
    fitted = temperatures(scores, questions)
    write_json(run/'calibration.json', {'temperatures': fitted, 'results': scores})
    write_json(output/'decision-config.json', {'version': 3, 'name': args.name, 'base': manifest['base'],
                                              'revision': manifest['revision'], 'questions': questions,
                                              'temperatures': fitted, 'max_tokens': 1024,
                                              'deployment_approved': False, 'evaluation_pending': True,
                                              'adapter_sha256': weight_hash,
                                              'contract': 'Reviewed Minecraft base workflow scoring; bounded fixed action set'})
    print('WEIGHTS TRAINED; BLIND EVALUATION STILL REQUIRED', json.dumps({'steps': step, 'delta': delta}), flush=True)


def audit(args, run, manifest):
    legacy_only = args.phase == 'legacy-eval'
    cache_path = run/'legacy-audit.json'
    if legacy_only and cache_path.exists():
        raise ValueError('The frozen legacy audit has already been run')
    if not legacy_only and (not manifest.get('eval_sealed') or (run/'report.json').exists()):
        raise ValueError('Seal fresh blind evaluation records before the single final audit')
    output = Path(manifest['adapter']); training = read_json(run/'training.json')
    if file_hash(output/'adapter_model.safetensors') != training['adapter_sha256']:
        raise ValueError('Saved training weights changed')
    questions = manifest['questions']
    parent_run = ROOT/'training/runs/qwen35-decision-v3'
    parent_manifest = read_json(parent_run/'manifest.json')
    legacy = load_rows(parent_run, 'eval', parent_manifest)
    rows = legacy if legacy_only else load_rows(run, 'eval', manifest)
    cache = None
    if not legacy_only and cache_path.exists():
        cache = read_json(cache_path)
        if (cache['adapter_sha256'] != training['adapter_sha256']
                or cache['parent_adapter_sha256'] != file_hash(Path(manifest['parent_adapter'])/'adapter_model.safetensors')
                or cache['legacy_eval_sha256'] != parent_manifest['split_sha256']['eval']
                or cache['eval_batch_size'] != args.eval_batch_size
                or cache['questions'] != questions
                or {r['id'] for r in rows if r['task'] != 'base_action'} != {r['id'] for r in legacy}):
            raise ValueError('Frozen legacy audit provenance differs from final evaluation')
        rows = [r for r in rows if r['task'] == 'base_action']
    tokenizer = AutoTokenizer.from_pretrained(str(BASE), padding_side='left')
    tokenizer.pad_token = tokenizer.pad_token or tokenizer.eos_token
    model = PeftModel.from_pretrained(prepare_inference_base(load_base()), manifest['parent_adapter'], is_trainable=False)
    started = time.perf_counter()
    before = evaluate(model, tokenizer, rows, questions, args.eval_batch_size, 'PARENT ON BLIND EVAL')
    model.load_adapter(str(output), adapter_name='candidate', is_trainable=False); model.set_adapter('candidate')
    after = evaluate(model, tokenizer, rows, questions, args.eval_batch_size, 'NEW WEIGHTS ON IDENTICAL BLIND EVAL')
    if legacy_only:
        write_json(cache_path, {'adapter_sha256': training['adapter_sha256'],
                               'parent_adapter_sha256': file_hash(Path(manifest['parent_adapter'])/'adapter_model.safetensors'),
                               'legacy_eval_sha256': parent_manifest['split_sha256']['eval'],
                               'eval_batch_size': args.eval_batch_size, 'questions': questions,
                               'before': before, 'after': after,
                               'before_summary': summarize(before), 'after_summary': summarize(after),
                               'note': 'Frozen candidate selected using calibration. One paired legacy audit, cached without reuse for training; final audit adds the future third-day shard.'})
        print('FROZEN LEGACY AUDIT COMPLETE', json.dumps({'before': summarize(before)['all'], 'after': summarize(after)['all']}), flush=True)
        return
    if cache:
        before = cache['before']+before; after = cache['after']+after
    before_summary, after_summary = summarize(before), summarize(after)
    old = [r for r in before if r['task'] != 'base_action']; new = [r for r in after if r['task'] != 'base_action']
    old_s, new_s = summarize(old)['all'], summarize(new)['all']
    approved = (after_summary['base_action']['illegal'] == 0
                and after_summary['base_action']['accuracy'] >= before_summary['base_action']['accuracy']
                and new_s['illegal'] <= old_s['illegal'] and new_s['accuracy'] >= old_s['accuracy']-.01)
    config = read_json(output/'decision-config.json')
    report = {'base': manifest['base'], 'parent_adapter': manifest['parent_adapter'], 'adapter': str(output),
              'method': 'Continued NF4 QLoRA; supervised next-token choice scoring with reviewed gameplay, labeled controlled observations, and legacy replay',
              'counts': manifest['counts'], 'base_training_sources': manifest['base_training_sources'],
              'reviewers': manifest['reviewers'], 'optimizer_steps': training['optimizer_steps'],
              'trainable_parameters': training['trainable_parameters'],
              'weight_squared_delta_from_parent': training['weight_squared_delta_from_parent'],
              'adapter_sha256': training['adapter_sha256'], 'before': before_summary, 'after': after_summary,
              'robustness_before': robustness_metrics(before), 'robustness_after': robustness_metrics(after),
              'held_out_probability_metrics': probability_metrics(after, questions, config['temperatures'], threshold=.55),
              'split_sha256': manifest['split_sha256'], 'deployment_approved': approved,
              'evaluation_seconds': round(time.perf_counter()-started, 1), 'note': manifest['note']}
    write_json(run/'before.json', {'summary': before_summary, 'results': before})
    write_json(run/'after.json', {'summary': after_summary, 'results': after})
    write_json(run/'report.json', report)
    config.update(deployment_approved=approved, evaluation_pending=False); write_json(output/'decision-config.json', config)
    print('BLIND EVALUATION COMPLETE', json.dumps({'approved': approved, 'before': before_summary['base_action'], 'after': after_summary['base_action']}), flush=True)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--name', required=True)
    parser.add_argument('--phase', choices=('train', 'legacy-eval', 'eval'), required=True)
    parser.add_argument('--epochs', type=int, default=1); parser.add_argument('--lr', type=float, default=.0001)
    parser.add_argument('--batch-size', type=int, default=2); parser.add_argument('--grad-accum', type=int, default=4)
    parser.add_argument('--eval-batch-size', type=int, default=4); args = parser.parse_args()
    if min(args.epochs, args.batch_size, args.grad_accum, args.eval_batch_size) < 1: raise ValueError('Positive batch sizes required')
    torch.set_num_threads(6); torch.manual_seed(42); random.seed(42); logging.disable_progress_bar()
    run = ROOT/'training/runs'/args.name; manifest = read_json(run/'manifest.json')
    (train if args.phase == 'train' else audit)(args, run, manifest)


if __name__ == '__main__':
    main()
