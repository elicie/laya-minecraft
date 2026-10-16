"""Resume the previously stopped main worker once actual bread and early day exist.
Uses ordinary bot control API only; never writes the DB or Minecraft admin state."""
import datetime,json,pathlib,sqlite3,time,urllib.request,uuid
root=pathlib.Path(__file__).resolve().parents[1];bot='1fc42dac-b69a-4345-a825-3fb81c0cd778';farmer='68e42c0c-a1b6-4c8f-9a32-2edbf2812e3a';out=root/'runtime/base-main-bread-resume.json'
if out.exists():raise RuntimeError('A main resume receipt already exists')
while True:
 with sqlite3.connect(f'file:{root}/runtime/control.sqlite?mode=ro',uri=True) as c:s=json.loads(c.execute("select value from state where key='checkpoint'").fetchone()[0])
 a=next(a for a in s['agents'] if a['id']==bot);f=next(a for a in s['agents'] if a['id']==farmer);r=f.get('session',{}).get('report',{});day=r.get('timeOfDay',24000);now=int(time.time()*1000)
 stocks=[o for o in s['observations'] if o.get('kind')=='container' and o.get('controllerEpoch')==s['controllerEpoch'] and o['world']=='infra:25565' and o['data']['container']['id']==s['rules']['warehouse']['id'] and now-o['observedAt']<=s['rules']['observationMaxAgeMs']]
 stock=max(stocks,key=lambda o:o['observedAt']) if stocks else None;bread=sum(i['count'] for i in stock['data']['items'] if i['name']=='bread') if stock else 0
 if bread>=1 and 0<=day<=3000 and f.get('session',{}).get('state')=='ready' and a.get('session',{}).get('state')=='stopped':
  key=str(uuid.uuid4());record={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'botId':bot,'actualBreadObserved':bread,'warehouseObservation':stock,'timeOfDay':day,'idempotencyKey':key,'administrativeFixture':False};out.write_text(json.dumps(record,ensure_ascii=False,indent=2))
  request=urllib.request.Request('http://127.0.0.1:3001/api/v1/bots/'+bot+'/resume',data=b'{}',headers={'Content-Type':'application/json','X-Laya-Control':'1','Idempotency-Key':key},method='POST')
  record['receipt']=json.load(urllib.request.urlopen(request,timeout=10));out.write_text(json.dumps(record,ensure_ascii=False,indent=2));print(json.dumps({'mainResumed':True,'bread':bread,'timeOfDay':day}),flush=True);break
 time.sleep(3)
