"""Read-only durable proof of real production harvest, bread and meals."""
import datetime,json,pathlib,sqlite3,time
root=pathlib.Path(__file__).resolve().parents[1];out=root/'runtime/base-food-production-proof.json';proof={'world':'infra:25565','administrativeFixture':False,'trainedByThisObserver':False,'harvests':[],'breadCrafts':[],'breadStores':[],'meals':[]};seen=set()
if out.exists():raise RuntimeError('Fresh proof path required')
while True:
 with sqlite3.connect(f'file:{root}/runtime/control.sqlite?mode=ro',uri=True) as c:s=json.loads(c.execute("select value from state where key='checkpoint'").fetchone()[0])
 changed=False;tasks={t['id']:t for t in s['tasks']}
 for a in s['attempts']:
  t=tasks.get(a['taskId']);r=a.get('result',{})
  if not t or a['state']!='completed' or a['id'] in seen or a.get('assignedAt',0)<1792119029000:continue
  if t.get('params',{}).get('id')not in ['laya-shore-wheat-01','laya-inland-wheat-02'] and not any(g['id']==t['goalId'] and g['input']['params'].get('baseSupplyId')in ['laya-shore-wheat-01','laya-inland-wheat-02'] for g in s['goals']):continue
  if not any(o.get('world')=='infra:25565' for o in r.get('observations',[])):continue
  if t['kind']=='farm' and t.get('params',{}).get('mode')=='harvest' and any(o['kind']=='farm' and o['data'].get('harvested',0)>0 and not o['data'].get('sampleOnly') for o in r.get('observations',[])):kind='harvests'
  elif t['kind']=='craft' and t['params'].get('item')=='bread':kind='breadCrafts'
  elif t['kind']=='store' and t['params'].get('item')=='bread':kind='breadStores'
  else:continue
  seen.add(a['id']);proof[kind].append({'attemptId':a['id'],'taskId':t['id'],'goalId':t['goalId'],'botId':a['botId'],'controllerEpoch':a['controllerEpoch'],'assignedAt':a['assignedAt'],'state':a['state'],'result':{k:v for k,v in r.items() if k!='checkpoint'},'farmCheckpoint':r.get('checkpoint',{}).get('farm')});changed=True
 for a in s['agents']:
  r=a.get('session',{}).get('report',{})
  for recovery in [a.get('survivalRecovery'),r.get('survivalRecovery')]:
   for meal in (recovery or {}).get('checkpoint',{}).get('foodMeals',[]):
    if meal.get('world')!='infra:25565' or meal['observedAt']<1792119029000:continue
    key=(a['id'],meal['observedAt'])
    if key not in seen:
     seen.add(key);proof['meals'].append({'botId':a['id'],'name':a['config']['name'],'meal':meal,'report':{k:r.get(k) for k in ['position','health','food','inventory','timeOfDay','worldAge']}});changed=True
 if changed:
  proof['updatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();p=out.with_suffix('.tmp');p.write_text(json.dumps(proof,ensure_ascii=False,indent=2));p.replace(out);print(json.dumps({k:len(proof[k]) for k in ['harvests','breadCrafts','breadStores','meals']}),flush=True)
 time.sleep(2)
