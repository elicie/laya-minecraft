const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{fork,execFile}=require('node:child_process')
const {classify,log}=require('./decision'),{correct}=require('./feedback')
const {createSurvivalPolicy}=require('./survival-policy'),{correctPolicy}=require('./policy-feedback')
const {createActivityPolicy,domains}=require('./activity-policy'),{correctActivity}=require('./activity-feedback')
const policyTest=createSurvivalPolicy()
const activityTest=createActivityPolicy()
const root=__dirname,port=Number(process.env.WEB_PORT||3000)
const addresses=['127.0.0.1',process.env.WEB_HOST||'100.82.139.118']
const allowedHosts=new Set([...addresses,'gti12-1'].map(a=>`${a}:${port}`))
const textures=path.join(root,'node_modules/prismarine-viewer/public/textures/1.21.1')
const itemIcons=new Map()
const aliases={furnace:'furnace_front',crafting_table:'crafting_table_front'}
for(const item of require('minecraft-data')('1.21.1').itemsArray){
 const candidates=[path.join(textures,'items',item.name+'.png'),path.join(textures,'blocks',(aliases[item.name]||item.name)+'.png'),path.join(textures,'blocks',item.name+'_side.png')]
 const found=candidates.find(p=>fs.existsSync(p));if(found)itemIcons.set(item.name,found)
}
let child=null,wanted=false,retry=null,state={ready:false,busy:false,job:'idle',viewerReady:false,inventory:[],players:[]},model={ready:false},activityModel={ready:false}
const eventsPath=path.join(root,'logs/events.jsonl')
function events(){
 if(!fs.existsSync(eventsPath))return []
 const fd=fs.openSync(eventsPath,'r');try{const size=fs.fstatSync(fd).size,offset=Math.max(0,size-128*1024),buf=Buffer.alloc(size-offset);fs.readSync(fd,buf,0,buf.length,offset);const lines=buf.toString('utf8').split('\n');if(offset)lines.shift();return lines.filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}).slice(-70)}finally{fs.closeSync(fd)}
}
function connect(){
 wanted=true;if(child)return
 state={...state,ready:false,viewerReady:false,status:'connecting',error:null}
 child=fork(path.join(root,'bot.js'),[],{cwd:root,env:{...process.env,WEB_VIEWER:'1'},stdio:['ignore','pipe','pipe','ipc']})
 child.on('message',m=>{if(m.type==='state')state={...m,status:m.ready?'online':'connecting'}
  if(m.type==='difficulty_request'&&typeof m.id==='string'&&m.id.length<80){
   const requester=child,reply=(ok,error)=>{if(requester?.connected)requester.send({type:'difficulty_result',id:m.id,ok,error})}
   const equipped=state.campaign?.stages?.find(s=>s.id==='equipment')?.ready
   if(!equipped||state.health<16||(state.campaign?.food||0)<8)return reply(false,'일반 난이도 전환 전 철 장비, 체력 16, 식량 8개가 필요합니다.')
   execFile('docker',['exec','minecraft-laya-server','rcon-cli','difficulty normal'],{timeout:10000},(error,stdout)=>{log({type:'message',text:error?'난이도 전환 실패: '+error.message:'전투 장비 확인 후 서버 난이도를 일반으로 전환했습니다. '+stdout.trim()});reply(!error,error?.message)})
  }
 })
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>console.log(b.toString().trim()))
 child.on('error',e=>{state.error=e.message})
 child.on('exit',()=>{child=null;state={...state,ready:false,busy:false,viewerReady:false,status:wanted?'waiting':'offline'};if(wanted)retry=setTimeout(connect,15000)})
}
function disconnect(){wanted=false;clearTimeout(retry);child?.kill('SIGTERM');state={...state,ready:false,viewerReady:false,status:'offline'}}
async function checkModel(){const endpoints=[process.env.LAYA_ENDPOINT||'http://127.0.0.1:8082/api/decide',process.env.LAYA_ACTIVITY_ENDPOINT||'http://127.0.0.1:8084/api/decide'];const results=await Promise.allSettled(endpoints.map(async endpoint=>{const url=new URL(endpoint);url.pathname=url.pathname.replace(/\/api\/decide\/?$/,'/health');const r=await fetch(url,{signal:AbortSignal.timeout(1500)});return {ready:r.ok,...await r.json()}}));[model,activityModel]=results.map(r=>r.status==='fulfilled'?r.value:{ready:false})}
checkModel();setInterval(checkModel,5000).unref()
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
async function body(req){let s='';for await(const b of req){s+=b;if(s.length>4096)throw new Error('요청이 너무 깁니다.')}return JSON.parse(s||'{}')}
function proxy(req,res){const upstream=http.request({hostname:'127.0.0.1',port:3008,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});upstream.on('error',()=>{if(!res.headersSent)json(res,503,{error:'봇이 서버에 접속하면 관전 화면이 열립니다.'});else res.end()});req.pipe(upstream)}
async function handler(req,res){
 if(!allowedHosts.has(req.headers.host))return json(res,403,{error:'허용되지 않은 호스트'})
 if(req.url.startsWith('/view/'))return proxy(req,res)
 try {
  if(req.method==='GET'&&req.url==='/api/buildings/designs'){const {designs,designPreview}=require('./structures');return json(res,200,Object.keys(designs).map(designPreview))}
  const catalog=req.url.match(/^\/api\/items\/([a-z0-9_]+)$/)
  if(req.method==='GET'&&catalog){const item=require('./catalog').itemInfo(catalog[1]);return json(res,item?200:404,item||{error:'Unknown item'})}
  const icon=req.url.match(/^\/item-icons\/([a-z0-9_]+)\.png$/)
  if(req.method==='GET'&&icon){const file=itemIcons.get(icon[1]);if(!file)return json(res,404,{error:'Icon unavailable'});res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'});return fs.createReadStream(file).pipe(res)}
  if(req.method==='GET' && req.url==='/api/state'){
   const recent=events();let report=null;try{report=JSON.parse(fs.readFileSync(path.join(root,'training/runs/minecraft-ko-v1/report.json')))}catch{}
   let corrections=0;try{corrections=fs.readFileSync(path.join(root,'training/data/corrections.jsonl'),'utf8').trim().split('\n').filter(Boolean).length}catch{}
   let policyReport=null,policyCorrections=0
   try{policyReport=JSON.parse(fs.readFileSync(path.join(root,'training/runs/minecraft-food-v1/report.json')))}catch{}
   try{policyCorrections=fs.readFileSync(path.join(root,'training/data/food/corrections.jsonl'),'utf8').trim().split('\n').filter(Boolean).length}catch{}
   let activityReport=null,activityCorrections=0,activityReviewed=0;try{activityReport=JSON.parse(fs.readFileSync(path.join(root,'training/runs/minecraft-activity-v1/report.json')))}catch{}
   try{activityCorrections=fs.readFileSync(path.join(root,'training/data/activity/corrections.jsonl'),'utf8').trim().split('\n').filter(Boolean).length}catch{}
   try{activityReviewed=fs.readFileSync(path.join(root,'training/data/activity/reviewed.jsonl'),'utf8').trim().split('\n').filter(Boolean).length}catch{}
   return json(res,200,{...state,wanted,model,report,corrections,policyReport,policyCorrections,activityModel,activityReport,activityCorrections,activityReviewed,events:recent,server:`${process.env.MC_HOST||'127.0.0.1'}:${process.env.MC_PORT||25565}`})
  }
  if(req.method==='POST' && req.url.startsWith('/api/')){
   if(req.headers['x-laya-control']!=='1' || (req.headers.origin && req.headers.origin!==`http://${req.headers.host}`))return json(res,403,{error:'화면에서 요청해 주세요.'})
   const data=await body(req)
   if(req.url==='/api/connect'){connect();return json(res,200,{ok:true})}
   if(req.url==='/api/disconnect'){disconnect();return json(res,200,{ok:true})}
   if(req.url==='/api/correct'){
    const label=correct(data.id,data.label,'web-user');log({type:'correction',event_id:data.id,label});return json(res,200,{ok:true,label})
   }
   if(req.url==='/api/policy/correct'){return json(res,200,{ok:true,label:correctPolicy(data.id,data.label)})}
   if(req.url==='/api/policy/analyze'){
    if(!state.ready||!state.auto?.nutrition?.observation)return json(res,409,{error:'봇 접속 후 실제 상황을 관측할 수 있습니다.'})
    return json(res,200,{ok:true,decision:await policyTest.decide(state.auto.nutrition.observation)})
   }
   if(req.url==='/api/activity/correct')return json(res,200,{ok:true,label:correctActivity(data.id,data.label)})
   if(req.url==='/api/activity/analyze'){
    if(!domains.includes(data.domain))return json(res,400,{error:'농사·건축·채집·탐색·전투 중 하나를 선택해 주세요.'})
    const observation=state.auto?.activity?.previews?.[data.domain]
    if(!state.ready||!observation)return json(res,409,{error:'봇 접속 후 실제 상황을 관측할 수 있습니다.'})
    return json(res,200,{ok:true,decision:await activityTest.decide(observation,{preview:true})})
   }
   if(['/api/command','/api/analyze'].includes(req.url)){
    if(typeof data.text!=='string'||!data.text.trim()||data.text.length>500)return json(res,400,{error:'명령을 1~500자로 입력해 주세요.'})
    if(req.url==='/api/analyze')return json(res,200,{answer:await classify(data.text)})
    const stopRequest=/^(멈춰|중지|그만|stop|!stop|자동\s*(?:중지|정지|끄기))$/i.test(data.text.trim())
    if(!child?.connected||(!state.ready&&!stopRequest))return json(res,409,{error:'먼저 마크 서버를 켜고 봇을 연결해 주세요.'})
    if(data.player && !state.players.includes(data.player))return json(res,400,{error:'해당 플레이어가 접속해 있지 않습니다.'})
    child.send({type:'command',text:data.text,player:data.player||null});return json(res,200,{ok:true})
   }
   return json(res,404,{error:'없는 기능입니다.'})
  }
  const files={'/':'index.html','/app.js':'app.js','/minimap.js':'minimap.js','/build-preview.js':'build-preview.js','/style.css':'style.css'}
  if(req.method==='GET'&&files[req.url]){
   const name=files[req.url];res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'"});return fs.createReadStream(path.join(root,'web',name)).pipe(res)
  }
  json(res,404,{error:'Not found'})
 }catch(e){json(res,400,{error:e.message})}
}
const servers=addresses.map(host=>{
 const server=http.createServer(handler)
 server.on('upgrade',(req,socket,head)=>{
  if(!allowedHosts.has(req.headers.host)||!req.url.startsWith('/view/socket.io')||(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`))return socket.destroy()
  const upstream=http.request({host:'127.0.0.1',port:3008,path:req.url,headers:req.headers})
  upstream.on('upgrade',(r,s,upHead)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(r.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');if(upHead.length)socket.write(upHead);if(head.length)s.write(head);s.pipe(socket);socket.pipe(s);s.on('error',()=>socket.destroy());socket.on('error',()=>s.destroy());socket.on('close',()=>s.destroy())})
  upstream.on('response',()=>socket.destroy());upstream.on('error',()=>socket.destroy());upstream.end()
 })
 server.listen(port,host,()=>console.log(`Laya Lab: http://${host}:${port}`));return server
})
process.on('SIGTERM',()=>{disconnect();servers.forEach(s=>s.close());setTimeout(()=>process.exit(0),700)})
