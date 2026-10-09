"""Train on authored/reviewed rows; untouched evaluation set never enters training."""
import argparse, collections, gc, hashlib, json, os, random, subprocess, time
from pathlib import Path
import torch
import laya
from laya.train import TrainConfig, finetune
ROOT=Path(__file__).resolve().parents[1]
torch.set_num_threads(4)
p=argparse.ArgumentParser();p.add_argument('--base',default=str(ROOT/'checkpoints/upstream/multilingual'));p.add_argument('--epochs',type=int,default=10);p.add_argument('--name',default='minecraft-ko-v1');args=p.parse_args()
out=ROOT/'checkpoints'/args.name
if out.exists(): raise SystemExit('Output already exists. Choose a new --name to preserve checkpoints.')
rows=[json.loads(s) for s in (ROOT/'training/data/train.jsonl').read_text().splitlines()]
tests=[json.loads(s) for s in (ROOT/'training/data/eval.jsonl').read_text().splitlines()]
corrections=ROOT/'training/data/corrections.jsonl'
if corrections.exists(): rows += [json.loads(s) for s in corrections.read_text().splitlines() if s.strip()]
assert not {r['state'] for r in rows}&{r['state'] for r in tests}, 'Evaluation contamination'
for r in rows:
 assert r.get('source') in ('assistant_authored_synthetic','human_correction')
# Deduplicate corrected commands, keeping latest reviewed label.
rows=list({r['state']:r for r in rows}.values())
run=ROOT/'training/runs'/args.name;run.mkdir(parents=True,exist_ok=False)
data=run/'train.jsonl';data.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
config=TrainConfig(epochs=args.epochs,micro_batch=4,grad_accum=2,loss='soft-ce',shuffle_options=('choice',),calib_frac=0.2,seed=42,max_len=512,head_max_len=256,log_every=20)

def evaluate(model):
 agent=laya.load(str(model),device='cuda',compile=False)
 results=[]
 for row in tests:
  start=time.perf_counter();answer=agent.predict(row['state'],row['questions'])['answers']['action']
  results.append({'id':row['id'],'state':row['state'],'expected':row['expected']['action'],'actual':answer['choice'],'probabilities':answer['probabilities'],'latency_ms':round((time.perf_counter()-start)*1000,2)})
 counts=collections.defaultdict(lambda:[0,0])
 for r in results:
  counts[r['expected']][0]+=int(r['expected']==r['actual']);counts[r['expected']][1]+=1
 summary={'correct':sum(r['expected']==r['actual'] for r in results),'total':len(results),'per_class':dict(counts),'results':results}
 summary['accuracy']=summary['correct']/summary['total']
 del agent;gc.collect();torch.cuda.empty_cache()
 return summary

print('Evaluating baseline on raw commands (no normalization)',flush=True)
before=evaluate(args.base);(run/'before.json').write_text(json.dumps(before,ensure_ascii=False,indent=2));print('BASELINE',before['correct'], '/',before['total'],flush=True)
summary=finetune(str(data),args.base,str(out),config,device='cuda')
(run/'training.json').write_text(json.dumps(summary,indent=2))
gc.collect();torch.cuda.empty_cache()
print('Evaluating final checkpoint',flush=True)
after=evaluate(out);(run/'after.json').write_text(json.dumps(after,ensure_ascii=False,indent=2))
report={'base':args.base,'checkpoint':str(out),'training_rows':len(rows),'eval_rows':len(tests),'before_accuracy':before['accuracy'],'after_accuracy':after['accuracy'],'training_sha256':hashlib.sha256(data.read_bytes()).hexdigest(),'eval_sha256':hashlib.sha256((ROOT/'training/data/eval.jsonl').read_bytes()).hexdigest(),'upstream_commit':subprocess.check_output(['git','-C',str(ROOT/'vendor/laya'),'rev-parse','HEAD'],text=True).strip(),'torch':torch.__version__,'note':'Small assistant-authored synthetic pilot; not gameplay success or independently validated Korean accuracy. No online reinforcement learning.'}
(run/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)
