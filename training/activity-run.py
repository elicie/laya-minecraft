"""Separately supervised mission policy. Fixed evaluation never enters training."""
import argparse,collections,gc,hashlib,json,time
from pathlib import Path
import torch,laya
from laya.train import TrainConfig,finetune
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--name',default='minecraft-activity-v1');p.add_argument('--epochs',type=int,default=8);args=p.parse_args()
torch.set_num_threads(4)
base=ROOT/'checkpoints/upstream/multilingual';out=ROOT/'checkpoints'/args.name;run=ROOT/'training/runs'/args.name
if out.exists() or run.exists():raise SystemExit('Use a new run name; preserve existing model and report.')
directory=ROOT/'training/data/activity';rows=[json.loads(line) for line in (directory/'train.jsonl').read_text().splitlines()];tests=[json.loads(line) for line in (directory/'eval.jsonl').read_text().splitlines()]
reviewed=directory/'reviewed.jsonl'
if reviewed.exists():
 for line in reviewed.read_text().splitlines():
  if not line.strip():continue
  row=json.loads(line);evidence=(ROOT/row['evidence_file']).resolve()
  assert evidence.is_relative_to(ROOT) and row.get('review_reason') and row.get('reviewer'),'Review metadata required'
  assert hashlib.sha256(evidence.read_bytes()).hexdigest()==row['evidence_sha256'],'Review evidence changed'
  rows.append(row)
corrections=directory/'corrections.jsonl'
if corrections.exists():rows.extend(json.loads(line) for line in corrections.read_text().splitlines() if line.strip())
assert all(r['source'] in ('assistant_authored_synthetic','assistant_reviewed_gameplay','human_correction') for r in rows)
rows=list({r['state']:r for r in rows}.values());assert not {r['state'] for r in rows}&{r['state'] for r in tests},'Evaluation contamination'
run.mkdir(parents=True);data=run/'train.jsonl';data.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
def evaluate(checkpoint):
 agent=laya.load(str(checkpoint),device='cuda',compile=False);results=[]
 for row in tests:
  started=time.perf_counter();result=agent.predict(row['state'],row['questions'],max_len=896,head_max_len=448);answer=result['answers']['activity_action']
  results.append({'id':row['id'],'domain':row['observation']['domain'],'expected':row['expected']['activity_action'],'actual':answer['choice'],'probabilities':answer['probabilities'],'truncated':bool(result.get('usage',{}).get('truncated')),'latency_ms':round((time.perf_counter()-started)*1000,2)})
 classes=collections.defaultdict(lambda:[0,0]);domains=collections.defaultdict(lambda:[0,0])
 for r in results:
  for group,key in ((classes,r['expected']),(domains,r['domain'])):group[key][0]+=int(r['actual']==r['expected']);group[key][1]+=1
 summary={'correct':sum(r['actual']==r['expected'] for r in results),'total':len(results),'per_class':dict(classes),'per_domain':dict(domains),'truncated':sum(r['truncated'] for r in results),'results':results};summary['accuracy']=summary['correct']/summary['total']
 del agent;gc.collect();torch.cuda.empty_cache();return summary
before=evaluate(base);(run/'before.json').write_text(json.dumps(before,indent=2));print('BASELINE',before['correct'],'/',before['total'],flush=True)
config=TrainConfig(epochs=args.epochs,micro_batch=4,grad_accum=2,loss='soft-ce',shuffle_options=('choice',),calib_frac=.2,seed=42,max_len=896,head_max_len=448,log_every=30)
training=finetune(str(data),str(base),str(out),config,device='cuda');(run/'training.json').write_text(json.dumps(training,indent=2));gc.collect();torch.cuda.empty_cache()
after=evaluate(out);(run/'after.json').write_text(json.dumps(after,indent=2))
report={'task':'activity_action','method':'supervised soft cross-entropy; no reinforcement learning','checkpoint':str(out),'base':str(base),'epochs':args.epochs,'training_rows':len(rows),'eval_rows':len(tests),'before_accuracy':before['accuracy'],'after_accuracy':after['accuracy'],'per_class':after['per_class'],'per_domain':after['per_domain'],'truncated':after['truncated'],'training_sha256':hashlib.sha256(data.read_bytes()).hexdigest(),'eval_sha256':hashlib.sha256((directory/'eval.jsonl').read_bytes()).hexdigest(),'note':'Authored synthetic state-action evaluation; not autonomous Minecraft completion or survival success rate.'}
(run/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)
