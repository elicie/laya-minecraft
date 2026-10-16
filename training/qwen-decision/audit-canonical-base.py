"""Qualify the exact deployed base question on a separately frozen fresh shard.

The wider failed robustness report is retained. No weights or labels are changed.
"""
import gc
import hashlib
import json
import time
from pathlib import Path
import torch
from peft import PeftModel
from transformers import AutoTokenizer
from common import ROOT, load_base, read_json, write_json
from train import evaluate, summarize
from serve import prepare_inference_base
from question_contract import CANONICAL_BASE_PROFILE, validate_request_question

MODEL = 'qwen35-base-v6-20261016'
run = ROOT/'training/runs'/MODEL
adapter = ROOT/'checkpoints'/MODEL
proof_path = run/'canonical-profile-report.json'
if proof_path.exists(): raise ValueError('This frozen profile has already been evaluated')
policy = read_json(run/'canonical-profile-policy.json')
data = (run/'canonical-profile-eval.jsonl').read_bytes()
assert hashlib.sha256(data).hexdigest() == policy['evalSha256']
rows = [json.loads(line) for line in data.decode().splitlines()]
assert len(rows) == 25 and {r['expected'] for r in rows} == set(read_json(adapter/'decision-config.json')['questions']['base_action']['criteria'])
config = read_json(adapter/'decision-config.json')
assert all('question' not in r and 'option_actions' not in r for r in rows)
for r in rows: validate_request_question(r['task'], {r['task']: config['questions'][r['task']]}, {**config, 'deployment_profile': CANONICAL_BASE_PROFILE})
torch.set_num_threads(6)
tokenizer = AutoTokenizer.from_pretrained(str(adapter), padding_side='left')
outputs = {}
started = time.perf_counter()
for name in policy['comparedAdapters']:
    model = PeftModel.from_pretrained(prepare_inference_base(load_base()), str(ROOT/'checkpoints'/name)).eval()
    results = evaluate(model, tokenizer, rows, config['questions'], 8, 'FRESH CANONICAL '+name)
    outputs[name] = {'summary': summarize(results), 'results': results}
    del model; gc.collect(); torch.cuda.empty_cache()
legacy = read_json(run/'legacy-audit.json')
sha = hashlib.sha256((adapter/'adapter_model.safetensors').read_bytes()).hexdigest()
assert legacy['adapter_sha256'] == sha == config['adapter_sha256']
old = legacy['before_summary']['all']; new = legacy['after_summary']['all']
candidate = outputs[MODEL]['summary']['all']
approved = (candidate['illegal'] == 0
            and all(candidate['accuracy'] >= v['summary']['all']['accuracy'] for k, v in outputs.items() if k != MODEL)
            and new['illegal'] <= old['illegal'] and new['accuracy'] >= old['accuracy']-.01)
report = {'deployment_profile': CANONICAL_BASE_PROFILE, 'deployment_approved': approved,
          'adapter_sha256': sha, 'policy': policy, 'evaluations': outputs,
          'legacy_before': old, 'legacy_after': new, 'broad_evaluation_approved': False,
          'broad_evaluation_report': str(run/'report.json'), 'elapsed_seconds': time.perf_counter()-started,
          'limitations': 'Only the exact canonical base question and criterion order are accepted. Fresh profile has24 controlled observations and1 production shelter shadow, not25 independent production decisions. Wider semantic-question generalization failed and is not approved.'}
write_json(proof_path, report)
if approved:
    (adapter/'canonical-profile-report.json').write_bytes(proof_path.read_bytes())
    config.update(deployment_approved=True, evaluation_pending=False, deployment_profile=CANONICAL_BASE_PROFILE,
                  canonical_profile_report_sha256=hashlib.sha256(proof_path.read_bytes()).hexdigest(), broad_evaluation_approved=False)
    write_json(adapter/'decision-config.json', config)
print('FRESH CANONICAL QUALIFICATION', json.dumps({'approved': approved, 'candidate': candidate,
      'baselines': {k:v['summary']['all'] for k,v in outputs.items() if k != MODEL}, 'broaderQuestionContractApproved': False}), flush=True)
