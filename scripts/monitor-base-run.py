"""Read-only continuous-world-time survival audit; never sends Minecraft commands."""
import datetime,hashlib,json,pathlib,sqlite3,sys,time
ROOT=pathlib.Path(__file__).resolve().parents[1]
BOT='68e42c0c-a1b6-4c8f-9a32-2edbf2812e3a'
OUT=ROOT/'runtime/validation-runs'/sys.argv[1]
OUT.mkdir(parents=True,exist_ok=False)
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def write(name,value):
 p=OUT/name;t=p.with_suffix(p.suffix+'.tmp');t.write_text(json.dumps(value,ensure_ascii=False,indent=2));t.replace(p)
def state():
 with sqlite3.connect(f'file:{ROOT}/runtime/control.sqlite?mode=ro',uri=True) as c:
  s=json.loads(c.execute("select value from state where key='checkpoint'").fetchone()[0]);seq=c.execute('select coalesce(max(seq),0) from events').fetchone()[0]
 return s,seq
def agent(s):return next(a for a in s['agents'] if a['id']==BOT)
s,seq=state();a=agent(s);r=a['session']['report'];assert a['session']['state']=='ready' and r['ready'] and r['health']==20 and r['food']>=18
farms=[o for o in s['observations'] if o.get('kind')=='farm' or o.get('type')=='farm']
source=hashlib.sha256()
for base in ['packages','apps/server/src']:
 for p in sorted((ROOT/base).rglob('*')):
  if p.is_file() and p.suffix in ['.ts','.json']:source.update(str(p.relative_to(ROOT)).encode()+p.read_bytes())
start={'startedAt':stamp(),'startedAtMs':int(time.time()*1000),'botId':BOT,'botName':a['config']['name'],'sessionId':a['session']['id'],'controllerEpoch':s['controllerEpoch'],'startWorldAge':r['worldAge'],'requiredWorldAgeDelta':72000,'startSeq':seq,'source_sha256':source.hexdigest(),'initialReport':r,'initialFarmFacts':farms,'secondaryMainInitiallyOffline':True,'administrativeWorldChanges':False}
write('start.json',start);lastseq=seq;lastage=r['worldAge'];completed=set();attempts=set();failures=set();deaths=[];minhp=r['health'];minfood=r['food'];lastsig=None;changed=time.monotonic();stalls=[];samples=0;seen_goals=set();elapsed=0
print(json.dumps({'started':str(OUT),'worldAge':lastage}),flush=True)
while True:
 time.sleep(3);s,seq=state();a=agent(s);session=a.get('session',{});r=session.get('report',{});now=int(time.time()*1000);reason=None
 if s['controllerEpoch']!=start['controllerEpoch']:reason='controller restarted'
 elif session.get('id')!=start['sessionId']:reason='primary session changed'
 elif session.get('state')!='ready' or not r.get('ready'):reason='primary disconnected'
 elif now-session.get('lastReportAt',0)>20000:reason='primary report stale'
 age=r.get('worldAge',lastage)
 if age<lastage:reason='worldAge moved backwards'
 elapsed=age-start['startWorldAge'];lastage=age;minhp=min(minhp,r.get('health',20));minfood=min(minfood,r.get('food',20));samples+=1
 with sqlite3.connect(f'file:{ROOT}/runtime/control.sqlite?mode=ro',uri=True) as c:
  events=[json.loads(p) for _,p in c.execute('select seq,payload from events where seq>? and seq<=? order by seq',(lastseq,seq))]
 lastseq=seq
 with (OUT/'events.jsonl').open('a') as f:
  for e in events:
   if e.get('type') in ['scheduler.decision','task.completed','task.failed','goal.completed','bot.death','death.recorded'] or ('death' in e.get('type','') or e.get('type')=='bot.died'):
    f.write(json.dumps(e,ensure_ascii=False)+'\n')
   if ('death' in e.get('type','') or e.get('type')=='bot.died') and e.get('botId')==BOT:deaths.append(e)
 for t in s['tasks']:
  if t.get('state')=='completed' and t.get('updatedAt',0)>=start['startedAtMs']:completed.add(t['id'])
 for at in s['attempts']:
  if at.get('botId')==BOT and at.get('assignedAt',0)>=start['startedAtMs']:
   attempts.add(at['id'])
   if at.get('state')=='failed':failures.add(at['id'])
 for g in s['goals']:
  if g.get('state')=='completed' and g.get('updatedAt',0)>=start['startedAtMs']:seen_goals.add(g['id'])
 active=[{'id':t['id'],'kind':t['kind'],'state':t['state'],'reason':t.get('reason'),'waitingFor':t.get('waitState',{}).get('waitingFor')} for t in s['tasks'] if t.get('affinityBotId')==BOT and t.get('state') not in ['completed','cancelled'] and any(g['id']==t['goalId'] and g['generation']==t['generation'] and g['state'] not in ['completed','cancelled'] for g in s['goals'])]
 latestfarm=next((o['data'] for o in reversed(s['observations']) if o.get('kind')=='farm' and o.get('botId')==BOT),None)
 sig=json.dumps([{k:round(v*4)/4 for k,v in r.get('position',{}).items()},r.get('inventory'),len(completed)],sort_keys=True)
 if sig!=lastsig:changed=time.monotonic();lastsig=sig
 expected=('야간' in r.get('action','') or '성장' in str(active) or 'GROW' in str(active) or not active and latestfarm is not None and latestfarm.get('planted',0)>0 and latestfarm.get('ripe',0)==0)
 stall=time.monotonic()-changed
 if stall>120 and not expected and not any(x.get('end') is None for x in stalls):stalls.append({'start':stamp(),'worldAge':age,'action':r.get('action'),'reason':r.get('reason'),'active':active,'end':None})
 if (stall<120 or expected) and stalls and stalls[-1]['end'] is None:stalls[-1]['end']=stamp()
 with (OUT/'samples.jsonl').open('a') as f:f.write(json.dumps({'at':stamp(),'worldAge':age,'runDay':min(3,elapsed//24000+1),'report':r,'active':active,'expectedWait':expected,'unchangedSeconds':round(stall,1)},ensure_ascii=False)+'\n')
 status={'updatedAt':stamp(),'state':'invalid' if reason else 'complete' if elapsed>=72000 else 'running','invalidReason':reason,'elapsedWorldTicks':elapsed,'requiredWorldTicks':72000,'elapsedGameDays':elapsed/24000,'minHealth':minhp,'minFood':minfood,'deaths':len(deaths),'completedTasks':len(completed),'completedGoals':len(seen_goals),'attempts':len(attempts),'failedAttempts':len(failures),'taskCompletionRatio':sum(1 for at in s['attempts'] if at.get('id') in attempts and at.get('state')=='completed')/len(attempts) if attempts else None,'unexpectedStallEpisodes':len(stalls),'samples':samples,'lastReport':{k:r.get(k) for k in ['health','food','action','reason','position','worldAge','timeOfDay','mode','inventory']}}
 write('status.json',status)
 if reason or elapsed>=72000:
  write('result.json',{**status,'start':start,'completedTaskIds':sorted(completed),'completedGoalIds':sorted(seen_goals),'attemptIds':sorted(attempts),'failedAttemptIds':sorted(failures),'deathEvents':deaths,'unexpectedStalls':stalls,'scope':'Primary farming worker only; main worker joins as a separately reported secondary when food is available. Growth/night waits are classified, not counted as work completion.'});print(json.dumps(status,ensure_ascii=False),flush=True);break
