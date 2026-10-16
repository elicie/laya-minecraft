"""Prepare a separately observed, assistant-reviewed base workflow experiment.
No prior failed evaluation record is added to training. Fresh evaluation is
sealed before optimization, grouped by scene episode before augmentation.
"""
import argparse,json,hashlib,collections
from pathlib import Path
from common import ROOT,read_json,write_json
from robustness import VARIANTS,variant


def main():
 p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--name',required=True);a=p.parse_args()
 parent=ROOT/'training/runs/qwen35-base-v6-20261016';original=read_json(parent/'manifest.json');questions=original['questions'];rows=[json.loads(x) for x in Path(a.input).read_text().splitlines() if x.strip()]
 assert len(rows)==72 and len({r['episode_id'] for r in rows})==72
 shards=collections.defaultdict(list)
 for r in rows:
  action=r['evidence']['sceneRequest'];o=r['evidence']['observation'];inv={x['name']:x['count'] for x in o['inventory']};stock={x['name']:x['count'] for x in o['warehouse']['items']};facts=r['evidence']['cropFacts']
  assert r['source']=='validation' and r['world']=='127.0.0.1:25566' and r['evidence']['fixturePrepared'] is True and not r['evidence']['actionExecuted']
  assert action in o['candidates'][0]['action'] and hashlib.sha256(r['state'].encode()).hexdigest()==r['state_sha256']
  if action=='seed_supply':assert stock.get('wheat_seeds',0)==0 and o['targets']['seeds']>inv.get('wheat_seeds',0)
  if action=='wood_supply':assert stock.get('oak_log',0)==0 and stock['wheat_seeds']>=o['targets']['seeds']
  if action in ['farm_setup','farm_harvest']:assert inv['wooden_hoe']==1 and inv['wheat_seeds']>=3
  if action=='farm_setup':assert all(f['name']=='air' for f in facts)
  if action=='farm_harvest':assert all(f['name']=='wheat' and f['age']==7 for f in facts)
  if action=='bake_food':assert inv['wheat']>=3 and r['evidence']['actualWorktable']=='crafting_table'
  if action=='warehouse_store' or action=='base_return':assert inv['wheat_seeds']>0
  if action=='warehouse_take':assert inv.get('wheat_seeds',0)==0 and stock['wheat_seeds']>0
  if action=='tool_craft':assert inv['oak_planks']>=2 and inv['stick']>=2
  if action=='shelter':assert o['timeOfDay']>=14000 and r['evidence']['actualShelterDoor']['open'] is False
  if action=='wait':assert all(f['age']==0 for f in facts)
  reviewed={**r,'expected':action,'allowed':[c['action'] for c in o['candidates']],'reviewed':True,'reviewer':'Codex assistant review of observed fixture facts; not human labels','rationale':r['evidence']['reviewGuidance']+' Requested workflow family remains authoritative across collect/store/home sub-actions.','observation':{'domain':'base','source':'validation'},'phase':'fresh_operations_'+r['evidence']['split'],'fingerprint':r['state_sha256']}
  shards[r['evidence']['split']].append(reviewed)
 assert [len(shards[k]) for k in ['train','calibration','eval']]==[36,12,24]
 # Reject any reuse of historical held-out states/episodes, even by variant ID.
 for name in ['qwen35-base-v5-20261016','qwen35-base-v6-20261016']:
  for split in ['train','calibration','eval','canonical-profile-eval']:
   path=ROOT/'training/runs'/name/(split+'.jsonl')
   if not path.exists():continue
   old=[json.loads(x) for x in path.read_text().splitlines() if x.strip()]
   hashes={r.get('state_sha256',hashlib.sha256(r['state'].encode()).hexdigest()) for r in old};episodes={r.get('episode_id') for r in old}
   assert not any(r['state_sha256'] in hashes or r['episode_id'] in episodes for group in shards.values() for r in group)
 for left,right in [('train','calibration'),('train','eval'),('calibration','eval')]:
  assert not ({r['state_sha256'] for r in shards[left]}&{r['state_sha256'] for r in shards[right]})
 run=ROOT/'training/runs'/a.name;output=ROOT/'checkpoints'/a.name;assert not run.exists() and not output.exists();run.mkdir(parents=True)
 old_train=[json.loads(x) for x in (parent/'train.jsonl').read_text().splitlines()]
 old_cal=[json.loads(x) for x in (parent/'calibration.jsonl').read_text().splitlines() if json.loads(x)['task']!='base_action']
 legacy_eval=[json.loads(x) for x in (ROOT/'training/runs/qwen35-decision-v3/eval.jsonl').read_text().splitlines()]
 sets={'train':old_train+shards['train']+[variant(r,questions,n) for r in shards['train'] for n in VARIANTS], 'calibration':old_cal+shards['calibration'], 'eval':legacy_eval+shards['eval']+[variant(r,questions,n) for r in shards['eval'] for n in VARIANTS]}
 digests={}
 for split,group in sets.items():
  content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in group).encode();(run/(split+'.jsonl')).write_bytes(content);digests[split]=hashlib.sha256(content).hexdigest()
 for split,group in shards.items():(run/('reviewed-new-'+split+'.jsonl')).write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in group))
 manifest={**original,'adapter':str(output),'parent_adapter':str(ROOT/'checkpoints/qwen35-base-v6-20261016'),'counts':{k:len(v) for k,v in sets.items()},'split_sha256':digests,'eval_sealed':True,'base_training_sources':{'historical_production':10,'historical_controlled':22,'new_controlled':36},'reviewers':['Codex assistant evidence review; not human annotations'],'fresh_originals':{k:len(v) for k,v in shards.items()},'deployment_policy':{'rawIllegalChoices':0,'baseAccuracyAtLeastParent':True,'legacyAccuracyDegradationAtMost':0.01},'note':'New controlled observations only; 24 fresh evaluation originals and their question variants are not independent production decisions. No old failed eval is training data. Code repairs and weights are separate.'}
 write_json(run/'manifest.json',manifest);print(json.dumps({'run':str(run),'counts':manifest['counts'],'fresh':manifest['fresh_originals'],'trained':False}))
if __name__=='__main__':main()
