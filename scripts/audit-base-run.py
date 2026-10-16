"""Audit the saved continuous samples against the durable coordinator journal."""
import datetime,json,pathlib,sqlite3,sys,math
root=pathlib.Path(__file__).resolve().parents[1];run=root/'runtime/validation-runs'/sys.argv[1]
start=json.loads((run/'start.json').read_text());samples=[json.loads(l) for l in (run/'samples.jsonl').read_text().splitlines()];last=samples[-1];bot=start['botId']
with sqlite3.connect(f'file:{root}/runtime/control.sqlite?mode=ro',uri=True) as c:
 s=json.loads(c.execute("select value from state where key='checkpoint'").fetchone()[0]);events=[json.loads(p) for p, in c.execute('select payload from events where seq>? and time<=? order by seq',(start['startSeq'],int(datetime.datetime.fromisoformat(last['at']).timestamp()*1000)))]
ours=[e for e in events if e.get('botId')==bot];assigned={e['attemptId'] for e in ours if e['type']=='task.assigned'};completed={e['attemptId'] for e in ours if e['type']=='task.completed'};failed={e['attemptId'] for e in ours if e['type']=='task.failed'}
attempts=[a for a in s['attempts'] if a['id'] in assigned];taskmap={t['id']:t for t in s['tasks']};deaths=[e for e in ours if e['type']=='bot.died'];disconnects=[e for e in ours if e['type'] in ['bot.stopped','bot.abnormal']]
assigned_tasks={a['taskId'] for a in attempts};completed_tasks={e['taskId'] for e in ours if e['type']=='task.completed' and e.get('taskId')};completed_new=completed_tasks&assigned_tasks
proof=[]
for a in attempts:
 t=taskmap.get(a['taskId'],{});result=a.get('result',{});observations=result.get('observations',[])
 if t.get('kind') in ['farm','craft','store','take','home'] and a['state']=='completed':
  proof.append({'attemptId':a['id'],'taskId':a['taskId'],'kind':t.get('kind'),'item':t.get('params',{}).get('item'),'assignedAt':a['assignedAt'],'result':{'outcome':result.get('outcome'),'reason':result.get('reason'),'observations':observations},'checkpointEvidence':{k:v for k,v in result.get('checkpoint',{}).items() if k in ['farm','basePassage','foodMeals','transfer','transfers','recipe','craft']}})
ages=[v['worldAge'] for v in samples];gaps=[(datetime.datetime.fromisoformat(b['at'])-datetime.datetime.fromisoformat(a['at'])).total_seconds() for a,b in zip(samples,samples[1:])]
# Measure net progress so jump oscillations cannot hide a stationary route delay.
anchor=None;held=None;since=None;movement_stalls=[];open_stall=None
for sample in samples:
 at=datetime.datetime.fromisoformat(sample['at']);p=sample['report']['position'];items=sample['report'].get('inventory')
 moved=anchor is not None and math.dist([p[k] for k in ['x','y','z']],[anchor[k] for k in ['x','y','z']])>=2
 if anchor is None or sample['expectedWait'] or items!=held or moved:
  if open_stall is not None:
   open_stall['endedAt']=sample['at'];open_stall['seconds']=(at-datetime.datetime.fromisoformat(open_stall['startedAt'])).total_seconds();open_stall=None
  anchor=p;held=items;since=at
 elif (at-since).total_seconds()>120 and open_stall is None:
  open_stall={'startedAt':since.isoformat(),'endedAt':None,'position':anchor,'action':sample['report']['action'],'reason':sample['report']['reason']};movement_stalls.append(open_stall)
answer={'auditedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'botId':bot,'startWorldAge':start['startWorldAge'],'lastWorldAge':ages[-1],'elapsedWorldTicks':ages[-1]-start['startWorldAge'],'requiredWorldTicks':72000,'continuousTimeComplete':ages[-1]-start['startWorldAge']>=72000 and not disconnects,'samples':len(samples),'limitedProgressEpisodes':movement_stalls,'limitedProgressDefinition':'More than120seconds without2m net travel, inventory change or an expected night/growth wait; includes bounded route recovery delays.','maximumSampleGapSeconds':max(gaps,default=0),'monotonicWorldAge':all(b>=a for a,b in zip(ages,ages[1:])),'deaths':len(deaths),'deathEvents':deaths,'disconnectEvents':disconnects,'minimumHealth':min(x['report']['health'] for x in samples),'minimumFood':min(x['report']['food'] for x in samples),'assignedAttempts':len(assigned),'completedAttempts':len(completed&assigned),'failedAttempts':len(failed&assigned),'completedCarryoverAttempts':len(completed-assigned),'attemptCompletionRatio':len(completed&assigned)/len(assigned) if assigned else None,'distinctAssignedTasks':len(assigned_tasks),'distinctCompletedAssignedTasks':len(completed_new),'distinctTaskCompletionRatio':len(completed_new)/len(assigned_tasks) if assigned_tasks else None,'completedCarryoverTaskIds':sorted(completed_tasks-assigned_tasks),'verifiedCompletions':proof,'note':'Read-only audit; expected growth and night waits are separate in the sampler. Attempt retries and distinct task completion are reported separately. This does not label an interrupted maintenance interval as three continuous days.'}
(run/'audit.json').write_text(json.dumps(answer,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in answer.items() if k not in ['verifiedCompletions','deathEvents','disconnectEvents']},ensure_ascii=False))
