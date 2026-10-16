"""Activate the approved scorer after a completed uninterrupted survival run."""
import hashlib,json,os,pathlib,signal,subprocess,time,urllib.request,uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
RUN=ROOT/'runtime/validation-runs/base-three-days-20261016-0941'
MODEL='qwen35-base-v6-20261016'
FARMER='68e42c0c-a1b6-4c8f-9a32-2edbf2812e3a';MAIN='1fc42dac-b69a-4345-a825-3fb81c0cd778'
def get(path):return json.load(urllib.request.urlopen('http://127.0.0.1:3001/api/v1'+path,timeout=3))
def call(bot,action):
 request=urllib.request.Request(f'http://127.0.0.1:3001/api/v1/bots/{bot}/{action}',data=b'{}',headers={'Content-Type':'application/json','X-Laya-Control':'1','Idempotency-Key':str(uuid.uuid4())},method='POST')
 return json.load(urllib.request.urlopen(request,timeout=10))
result=json.loads((RUN/'result.json').read_text());audit=json.loads((RUN/'audit.json').read_text())
assert result['state']=='complete' and result['invalidReason'] is None and audit['continuousTimeComplete']
start=json.loads((RUN/'start.json').read_text());source_hash=hashlib.sha256()
for base in ['packages','apps/server/src']:
 for p in sorted((ROOT/base).rglob('*')):
  if p.is_file() and p.suffix in ['.ts','.json']:source_hash.update(str(p.relative_to(ROOT)).encode()+p.read_bytes())
assert source_hash.hexdigest()==start['source_sha256'],'Controller source changed during the run'
postrun=ROOT/'runtime/validation-proofs/base-20261016/post-run-v38.json'
postrun_proof=json.loads(postrun.read_text())
assert postrun_proof['testsPassed'] and postrun_proof['typecheckPassed'] and postrun_proof['physicalVersions']==['1.21.1','26.1']
patch=ROOT/'runtime/validation-proofs/base-20261016/protected-walk-v38.patch'
assert hashlib.sha256(patch.read_bytes()).hexdigest()==postrun_proof['patchSha256']
subprocess.run(['git','apply','--check',str(patch)],cwd=ROOT,check=True)
model_root=pathlib.Path('/home/elicie/Dev/minecraft')
report=json.loads((model_root/'training/runs'/MODEL/'canonical-profile-report.json').read_text())
config=json.loads((model_root/'checkpoints'/MODEL/'decision-config.json').read_text())
assert report['deployment_approved'] is True and config['deployment_approved'] is True and config['evaluation_pending'] is False
assert report['deployment_profile']==config['deployment_profile']=='canonical-base-v1'
health=json.load(urllib.request.urlopen('http://127.0.0.1:8086/health',timeout=3));assert health['model']==MODEL
old=json.loads(pathlib.Path('/tmp/laya-base-controller-v37.json').read_text())['pid']
assert os.readlink(f'/proc/{old}/cwd')==str(ROOT)
assert b'apps/server/src/main.ts' in pathlib.Path(f'/proc/{old}/cmdline').read_bytes().split(b'\0')
source=ROOT/'deployment/systemd/laya-minecraft-controller.service';destination=pathlib.Path.home()/'.config/systemd/user'/source.name
destination.parent.mkdir(parents=True,exist_ok=True)
if destination.exists() and destination.read_bytes()!=source.read_bytes():raise RuntimeError('Existing user service differs; refusing to overwrite')
destination.write_bytes(source.read_bytes());subprocess.run(['systemd-analyze','--user','verify',str(destination)],check=True)
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
receipt={'startedAtMs':int(time.time()*1000),'oldPid':old,'modelHealth':health,'adapterSha256':report['adapter_sha256'],'completedRun':str(RUN),'measuredControllerVersion':37,'sourceSha256':source_hash.hexdigest(),'postRunFixProof':str(postrun),'administrativeMinecraftCommands':False,'commands':[]}
receipt_path=ROOT/'runtime/base-qwen-deployment-proof.json'
def save():receipt_path.write_text(json.dumps(receipt,ensure_ascii=False,indent=2))
snapshot=get('/snapshot');main=next(a for a in snapshot['agents'] if a['id']==MAIN)
if main.get('session',{}).get('state')=='stopped' and main['config']['enabled']:
 receipt['commands'].append(call(MAIN,'pause'))
receipt['commands'].append(call(FARMER,'pause'));time.sleep(1);save()
env_file=ROOT/'.env';lines=env_file.read_text().splitlines();settings={'LAYA_AUTO_CONNECT':'true','QWEN_DECISION_URL':'http://127.0.0.1:8086'};written=set();new=[]
for line in lines:
 key=line.split('=',1)[0].strip() if '=' in line else ''
 if key in settings:
  if key not in written:new.append(key+'='+settings[key]);written.add(key)
 else:new.append(line)
new.extend(k+'='+v for k,v in settings.items() if k not in written)
temporary=env_file.with_name('.env.base-deploy-'+uuid.uuid4().hex);temporary.write_text('\n'.join(new)+'\n');temporary.chmod(env_file.stat().st_mode&0o777);temporary.replace(env_file)
receipt['changedEnvironmentKeys']=list(settings);save()
os.kill(old,signal.SIGTERM)
for _ in range(300):
 if not pathlib.Path(f'/proc/{old}').exists():break
 time.sleep(.1)
else:raise RuntimeError('Previous controller did not exit; refusing a duplicate')
subprocess.run(['git','apply',str(patch)],cwd=ROOT,check=True)
deployed_hash=hashlib.sha256()
for base in ['packages','apps/server/src']:
 for p in sorted((ROOT/base).rglob('*')):
  if p.is_file() and p.suffix in ['.ts','.json']:deployed_hash.update(str(p.relative_to(ROOT)).encode()+p.read_bytes())
assert deployed_hash.hexdigest()==postrun_proof['plannedSourceSha256'],'Post-run fix differs from the tested source'
receipt.update(deployedControllerVersion=38,deployedSourceSha256=deployed_hash.hexdigest(),postRunFixIncluded=True);save()
subprocess.run(['systemctl','--user','enable','--now',destination.name],check=True)
for _ in range(200):
 try:
  snapshot=get('/snapshot')
  if snapshot['controllerEpoch']!=start['controllerEpoch']:break
 except (OSError,ValueError):pass
 time.sleep(.1)
else:raise RuntimeError('Service controller did not become ready')
receipt['commands'].append(call(FARMER,'resume'))
receipt.update(completedAtMs=int(time.time()*1000),controllerEpoch=snapshot['controllerEpoch'],newPid=int(subprocess.check_output(['systemctl','--user','show','-p','MainPID','--value',destination.name],text=True)),service=destination.name,autoConnectEnabled=True,newModelEnabled=True)
save();print(json.dumps({k:v for k,v in receipt.items() if k!='commands'},ensure_ascii=False))
