"""Install only the evaluated base adapter as its own local user service."""
import hashlib,json,pathlib,subprocess,time,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[2]
MODEL='qwen35-base-v6-20261016'
run=ROOT/'training/runs'/MODEL;adapter=ROOT/'checkpoints'/MODEL
config=json.loads((adapter/'decision-config.json').read_text())
report=json.loads((run/'canonical-profile-report.json').read_text())
assert config.get('deployment_approved') is True and config.get('evaluation_pending') is False
assert report.get('deployment_approved') is True
assert report.get('deployment_profile') == config.get('deployment_profile') == 'canonical-base-v1'
assert json.loads((run/'report.json').read_text())['deployment_approved'] is False
assert hashlib.sha256((adapter/'adapter_model.safetensors').read_bytes()).hexdigest()==report['adapter_sha256']==config['adapter_sha256']
source=ROOT/'training/qwen-decision/systemd/minecraft-qwen-base.service'
destination=pathlib.Path.home()/'.config/systemd/user'/source.name
destination.parent.mkdir(parents=True,exist_ok=True)
if destination.exists() and destination.read_bytes()!=source.read_bytes():raise RuntimeError('Existing user service differs; refusing to overwrite')
destination.write_bytes(source.read_bytes())
subprocess.run(['systemd-analyze','--user','verify',str(destination)],check=True)
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now',destination.name],check=True)
for _ in range(180):
 try:
  health=json.load(urllib.request.urlopen('http://127.0.0.1:8086/health',timeout=2))
  if health.get('model')==MODEL:
   result={'installedService':destination.name,'model':MODEL,'adapterSha256':report['adapter_sha256'],'health':health,'otherModelServicesStopped':False,'deploymentProfile':'canonical-base-v1','broaderSemanticQuestionEvaluationApproved':False}
   (run/'service-deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));break
 except (OSError,ValueError):pass
 time.sleep(1)
else:raise RuntimeError('Approved model service did not become healthy')
