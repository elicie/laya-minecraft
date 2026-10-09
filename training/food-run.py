"""Supervised Laya food-state policy; never trains on its held-out evaluation set."""
import argparse,collections,gc,hashlib,json,time
from pathlib import Path
import torch,laya
from laya.train import TrainConfig,finetune
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--name',default='minecraft-food-v1');p.add_argument('--epochs',type=int,default=8);args=p.parse_args()
torch.set_num_threads(4)
base=ROOT/'checkpoints/upstream/multilingual';out=ROOT/'checkpoints'/args.name;run=ROOT/'training/runs'/args.name
if out.exists() or run.exists():raise SystemExit('Choose a new run name; preserve previous checkpoints and reports.')
data_dir=ROOT/'training/data/food';rows=[json.loads(s) for s in (data_dir/'train.jsonl').read_text().splitlines()];tests=[json.loads(s) for s in (data_dir/'eval.jsonl').read_text().splitlines()]
corrections=data_dir/'corrections.jsonl'
if corrections.exists():rows += [json.loads(s) for s in corrections.read_text().splitlines() if s.strip()]
assert all(r['source'] in ('assistant_authored_synthetic','human_correction') for r in rows)
rows=list({r['state']:r for r in rows}.values())
assert not {r['state'] for r in rows}&{r['state'] for r in tests},'Held-out evaluation contamination'
run.mkdir(parents=True);data=run/'train.jsonl';data.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
config=TrainConfig(epochs=args.epochs,micro_batch=4,grad_accum=2,loss='soft-ce',shuffle_options=('choice',),calib_frac=.2,seed=42,max_len=768,head_max_len=320,log_every=20)
def evaluate(checkpoint):
 agent=laya.load(str(checkpoint),device='cuda',compile=False);results=[]
 for row in tests:
  started=time.perf_counter();result=agent.predict(row['state'],row['questions'],max_len=768,head_max_len=320);answer=result['answers']['food_action']
  results.append({'id':row['id'],'expected':row['expected']['food_action'],'actual':answer['choice'],'probabilities':answer['probabilities'],'truncated':bool(result.get('usage',{}).get('truncated')),'latency_ms':round((time.perf_counter()-started)*1000,2)})
 classes=collections.defaultdict(lambda:[0,0])
 for r in results:classes[r['expected']][0]+=int(r['expected']==r['actual']);classes[r['expected']][1]+=1
 summary={'correct':sum(r['expected']==r['actual'] for r in results),'total':len(results),'per_class':dict(classes),'results':results,'truncated':sum(r['truncated'] for r in results)};summary['accuracy']=summary['correct']/summary['total']
 del agent;gc.collect();torch.cuda.empty_cache();return summary
before=evaluate(base);(run/'before.json').write_text(json.dumps(before,indent=2));print('BASELINE',before['correct'],'/',before['total'],flush=True)
summary=finetune(str(data),str(base),str(out),config,device='cuda');(run/'training.json').write_text(json.dumps(summary,indent=2));gc.collect();torch.cuda.empty_cache()
after=evaluate(out);(run/'after.json').write_text(json.dumps(after,indent=2))
report={'task':'food_action','method':'supervised soft cross-entropy; not online reinforcement learning','base':str(base),'checkpoint':str(out),'training_rows':len(rows),'eval_rows':len(tests),'before_accuracy':before['accuracy'],'after_accuracy':after['accuracy'],'per_class':after['per_class'],'truncated':after['truncated'],'training_sha256':hashlib.sha256(data.read_bytes()).hexdigest(),'eval_sha256':hashlib.sha256((data_dir/'eval.jsonl').read_bytes()).hexdigest(),'note':'Small authored synthetic state scenarios; these scores are not Minecraft survival or gameplay success rates.'}
(run/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)
