"""Train and evaluate an actual Qwen3.5-9B LoRA decision adapter."""
import argparse
import collections
import hashlib
import importlib.metadata
import json
import math
import random
import time
from pathlib import Path
import torch
import torch.nn.functional as F
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import AutoTokenizer
from transformers.utils import logging
from common import BASE, ROOT, code_ids, load_base, predict, read_json, score_batch, tokenize, write_json


def load_rows(run, split, manifest):
    content = (run / (split+'.jsonl')).read_bytes()
    if hashlib.sha256(content).hexdigest() != manifest['split_sha256'][split]:
        raise ValueError('Prepared data changed: '+split)
    return [json.loads(line) for line in content.splitlines()]


def evaluate(model, tokenizer, rows, questions, batch_size, label):
    model.eval()
    results = []
    for offset in range(0, len(rows), batch_size):
        group = rows[offset:offset+batch_size]
        started = time.perf_counter()
        scores = score_batch(model, tokenizer, group, questions)
        elapsed = round((time.perf_counter()-started)*1000/len(group), 2)
        for row, (values, tokens) in zip(group, scores):
            if 'option_actions' in row:
                order = row['option_actions']
                values = [values[order.index(action)] for action in questions[row['task']]['criteria']]
            answer = predict(values, row['task'], questions)
            results.append({'id': row['id'], 'task': row['task'], 'domain': row['observation'].get('domain'), 'phase':row.get('phase','legacy'),
                            'expected': row['expected'], 'actual': answer['choice'], 'allowed': row['allowed'],
                            'variant': row['variant'] if isinstance(row.get('variant'), str) else 'original',
                            'original_id': row.get('original_id', row['id']),
                            'logits': values, 'tokens': tokens, 'amortized_latency_ms': elapsed})
        if offset % (batch_size*8) == 0:
            print(label, len(results), '/', len(rows), flush=True)
    return results


def summarize(results):
    groups = collections.defaultdict(lambda: {'correct': 0, 'total': 0, 'illegal': 0})
    for row in results:
        for key in ('all', row['task'], row['task']+':'+row['expected'], 'phase:'+row.get('phase','legacy')):
            group = groups[key]
            group['total'] += 1
            group['correct'] += row['actual'] == row['expected']
            group['illegal'] += row['actual'] not in row['allowed']
    for group in groups.values():
        group['accuracy'] = group['correct']/group['total']
    return dict(groups)


def calibrate(results, questions):
    temperatures = {}
    for task in questions:
        group = [row for row in results if row['task'] == task]
        logits = torch.tensor([row['logits'] for row in group], dtype=torch.float32)
        actions = list(questions[task]['criteria'])
        labels = torch.tensor([actions.index(row['expected']) for row in group])
        candidates = [0.1*(100**(i/100)) for i in range(101)]
        losses = [F.cross_entropy(logits/t, labels).item() for t in candidates]
        best = min(range(len(losses)), key=losses.__getitem__)
        temperatures[task] = {'temperature': candidates[best], 'items': len(group),
                              'negative_log_likelihood': losses[best], 'before_nll': F.cross_entropy(logits, labels).item()}
    return temperatures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--name', required=True)
    parser.add_argument('--epochs', type=int, default=1)
    parser.add_argument('--batch-size', type=int, default=2)
    parser.add_argument('--grad-accum', type=int, default=4)
    parser.add_argument('--eval-batch-size', type=int, default=4)
    parser.add_argument('--rank', type=int, default=8)
    parser.add_argument('--lr', type=float, default=0.0002)
    args = parser.parse_args()
    if min(args.epochs, args.batch_size, args.grad_accum, args.eval_batch_size, args.rank) < 1:
        raise ValueError('Training sizes must be positive')
    run = ROOT / 'training/runs' / args.name
    manifest = read_json(run/'manifest.json')
    output = Path(manifest['adapter'])
    if output.exists() or (run/'training.json').exists():
        raise ValueError('Use a fresh run name; refusing to overwrite training')
    questions = manifest['questions']
    train, calibration, evaluation = [load_rows(run, split, manifest) for split in ('train', 'calibration', 'eval')]
    torch.set_num_threads(6)
    logging.disable_progress_bar()
    torch.manual_seed(42)
    random.seed(42)
    tokenizer = AutoTokenizer.from_pretrained(str(BASE), padding_side='left')
    tokenizer.pad_token = tokenizer.pad_token or tokenizer.eos_token
    model = load_base()
    started = time.perf_counter()
    before = evaluate(model, tokenizer, evaluation, questions, args.eval_batch_size, 'BASELINE')
    write_json(run/'before.json', {'summary': summarize(before), 'results': before})
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True,
                                           gradient_checkpointing_kwargs={'use_reentrant': False})
    # PEFT upcasts frozen embeddings to float32. BF16 saves 4GB; layer norms stay float32.
    model.get_input_embeddings().to(torch.bfloat16)
    model.get_output_embeddings().to(torch.bfloat16)
    config = LoraConfig(r=args.rank, lora_alpha=args.rank*2, lora_dropout=0.05, bias='none', task_type='CAUSAL_LM',
                        target_modules=['q_proj','k_proj','v_proj','o_proj','in_proj_qkv','out_proj','gate_proj','up_proj','down_proj'])
    model = get_peft_model(model, config)
    trainable = [param for param in model.parameters() if param.requires_grad]
    trainable_count = sum(param.numel() for param in trainable)
    model.print_trainable_parameters()
    optimizer = torch.optim.AdamW(trainable, lr=args.lr, weight_decay=0.01)
    codes = torch.tensor(code_ids(tokenizer, 12), device='cuda')
    encoded = {row['fingerprint']: tokenize(tokenizer, row['task'], row['state'], questions) for row in train}
    total_steps = math.ceil(math.ceil(len(train)/args.batch_size)/args.grad_accum)*args.epochs
    optimizer_steps = 0
    history = []
    for epoch in range(args.epochs):
        model.train()
        shuffled = list(train)
        random.shuffle(shuffled)
        batches = [shuffled[i:i+args.batch_size] for i in range(0, len(shuffled), args.batch_size)]
        for start in range(0, len(batches), args.grad_accum):
            group = batches[start:start+args.grad_accum]
            optimizer.zero_grad(set_to_none=True)
            mean_loss = 0.0
            for batch in group:
                inputs = tokenizer.pad({'input_ids': [encoded[row['fingerprint']] for row in batch]},
                                       padding=True, return_tensors='pt').to('cuda')
                targets = torch.tensor([list(questions[row['task']]['criteria']).index(row['expected']) for row in batch], device='cuda')
                with torch.autocast('cuda', dtype=torch.bfloat16):
                    logits = model(**inputs, use_cache=False, logits_to_keep=1).logits[:, -1, codes].float()
                    valid = torch.tensor([[i < len(questions[row['task']]['criteria']) for i in range(12)] for row in batch], device='cuda')
                    loss = F.cross_entropy(logits.masked_fill(~valid, -10000), targets)
                if not torch.isfinite(loss):
                    raise ValueError('Non-finite training loss')
                (loss/len(group)).backward()
                mean_loss += loss.item()/len(group)
            norm = torch.nn.utils.clip_grad_norm_(trainable, 1.0, error_if_nonfinite=True)
            progress = optimizer_steps / max(1, total_steps)
            factor = min(1.0, (optimizer_steps+1)/max(1, int(total_steps*0.03))) * (0.1+0.9*(1+math.cos(math.pi*progress))/2)
            for pg in optimizer.param_groups:
                pg['lr'] = args.lr*factor
            optimizer.step()
            optimizer_steps += 1
            row = {'epoch': epoch+1, 'step': optimizer_steps, 'total_steps': total_steps, 'loss': round(mean_loss, 6),
                   'gradient_norm': round(norm.item(), 4), 'elapsed_seconds': round(time.perf_counter()-started, 1)}
            history.append(row)
            with (run/'progress.jsonl').open('a') as file:
                file.write(json.dumps(row)+'\n')
            if optimizer_steps == 1 or optimizer_steps % 8 == 0:
                print('TRAIN', json.dumps(row), flush=True)
    adapter_change = sum(param.detach().float().square().sum().item() for name, param in model.named_parameters() if 'lora_B' in name)
    if not adapter_change > 0:
        raise ValueError('LoRA B weights did not change')
    model.save_pretrained(str(output))
    tokenizer.save_pretrained(str(output))
    calibration_scores = evaluate(model, tokenizer, calibration, questions, args.eval_batch_size, 'CALIBRATION')
    temperature = calibrate(calibration_scores, questions)
    after = evaluate(model, tokenizer, evaluation, questions, args.eval_batch_size, 'AFTER')
    write_json(run/'calibration.json', {'temperatures': temperature, 'results': calibration_scores})
    write_json(run/'after.json', {'summary': summarize(after), 'results': after})
    versions = {package: importlib.metadata.version(package) for package in ('torch','transformers','peft','bitsandbytes','accelerate')}
    write_json(run/'training.json', {'parameters': vars(args), 'optimizer_steps': optimizer_steps,
                                    'trainable_parameters': trainable_count, 'lora_B_squared_norm_after': adapter_change,
                                    'peak_allocated_MiB': torch.cuda.max_memory_allocated()/1024**2, 'versions': versions, 'history': history})
    write_json(output/'decision-config.json', {'version': 1, 'name': args.name, 'base': manifest['base'],
                                              'revision': manifest['revision'], 'questions': questions,
                                              'temperatures': temperature, 'max_tokens': 1024})
    report = {'model': manifest['base'], 'revision': manifest['revision'], 'adapter': str(output),
              'method': '4-bit NF4 QLoRA; supervised next-token option classification with candidate cross entropy',
              'counts': manifest['counts'], 'optimizer_steps': optimizer_steps, 'trainable_parameters': trainable_count,
              'before': summarize(before), 'after': summarize(after), 'temperatures': temperature,
              'elapsed_seconds': round(time.perf_counter()-started, 1), 'versions': versions,
              'split_sha256': manifest['split_sha256'], 'note': manifest['note']}
    write_json(run/'report.json', report)
    print('COMPLETE', json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
