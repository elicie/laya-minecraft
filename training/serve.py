"""Loopback-only, single-worker inference for a separately trained checkpoint."""
import argparse,json,os,time
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
import torch,laya
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--checkpoint',required=True);p.add_argument('--port',type=int,default=8082);p.add_argument('--max-state-chars',type=int,default=500);args=p.parse_args()
torch.set_num_threads(4)
agent=laya.load(args.checkpoint,device='cuda',compile=False)
questions=json.loads((Path(args.checkpoint)/'questions.json').read_text())
class Handler(BaseHTTPRequestHandler):
 def reply(self,status,data):
  encoded=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(encoded)));self.end_headers();self.wfile.write(encoded)
 def do_GET(self):
  self.reply(200 if self.path=='/health' else 404,{'checkpoint':args.checkpoint,'ready':True})
 def do_POST(self):
  if self.path!='/api/decide':return self.reply(404,{'error':'Not found'})
  try:
   size=int(self.headers.get('Content-Length','0'))
   if not 0<size<=16384:return self.reply(413,{'error':'Invalid request size'})
   body=json.loads(self.rfile.read(size));state=body.get('state')
   if not isinstance(state,str) or not state.strip() or len(state)>args.max_state_chars:return self.reply(400,{'error':f'State must be 1..{args.max_state_chars} characters'})
   if body.get('questions',questions)!=questions:return self.reply(400,{'error':'Checkpoint only supports its trained question schema'})
   start=time.perf_counter();result=agent.predict(state,questions)
   result.update(model=Path(args.checkpoint).name,total_duration=int((time.perf_counter()-start)*1e9),state_truncated=bool(result.get('usage',{}).get('truncated')))
   self.reply(200,result)
  except (ValueError,TypeError,KeyError) as e:self.reply(400,{'error':str(e)})
  except Exception as e:
   print('inference error',repr(e),flush=True);self.reply(500,{'error':'Inference failed'})
print('Serving',args.checkpoint,'on 127.0.0.1:'+str(args.port),flush=True)
HTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
