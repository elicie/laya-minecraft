const fs=require('node:fs'),path=require('node:path')
const {HOSTILES}=require('./combat')

function createDeathRecovery(bot,hooks,file=path.join(__dirname,'logs/death-recovery.json')){
 const {check,token:currentToken,isReady,isBusy,stopWork,run,recover,retreat,resume,goal,food,log=()=>{},say=()=>{},now=Date.now}=hooks
 let state={version:1,active:false,phase:'대기',reason:'사망하면 리스폰 후 주변을 확인하고 아이템 회수와 목표 재개를 시도합니다.',death:null,resume:null,resumeRequested:false,attempts:0,retreats:0,recentDeaths:[],nextCheck:0,cooldownUntil:0,safeSince:0},running=false
 try{const saved=JSON.parse(fs.readFileSync(file));if(saved.version===1)state={...state,...saved}}catch{}
 const persist=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(state,null,2));fs.renameSync(file+'.tmp',file)}
 function update(phase,reason,extra={}){state={...state,phase,reason,...extra};persist();log({type:'death_recovery',phase,reason,active:state.active,attempts:state.attempts,death:state.death,resumeRequested:state.resumeRequested})}
 function cancel(reason='사용자가 사망 후 복구를 중지했습니다.'){
  if(!state.active)return
  update('복구 중지',reason,{active:false,resumeRequested:false})
 }
 function died({position,dimension,inventory=[],resume:previous=null}={}){
  const time=now(),recentDeaths=[...state.recentDeaths.filter(t=>time-t<120000),time],repeated=recentDeaths.length>=3
  state={...state,active:true,death:{time:new Date(time).toISOString(),position:{x:position.x,y:position.y,z:position.z},dimension,inventory:inventory.map(i=>({name:i.name,count:i.count}))},resume:previous,resumeRequested:!!previous,attempts:0,retreats:0,recentDeaths,nextCheck:0,safeSince:0,cooldownUntil:repeated?time+Math.min(120000,30000*(recentDeaths.length-2)):0}
  stopWork()
  update('리스폰 대기',repeated?'반복 사망해 목표를 보존하고 안전 대기합니다. 위험이 사라지면 기존 작업을 이어갑니다.':'사망 위치와 소지품, 진행 중이던 목표를 저장했습니다. 리스폰을 기다립니다.')
  say(state.reason)
 }
 function spawned(){
  if(!state.active)return false
  update('주변 확인','리스폰했습니다. 주변 위험을 확인한 뒤 회수 가능한 아이템과 기존 목표를 처리합니다.',{nextCheck:now()+1500})
  say(state.reason);return true
 }
 function enemies(){return Object.values(bot.entities||{}).filter(e=>e.type!=='player'&&!e.username&&(HOSTILES.has(e.name)||e.name==='spider'&&bot.time?.timeOfDay>=13000))}
 function pointDistance(p,q){return Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)}
 function finishRecovery(reason){update('목표 재개 준비',reason,{nextCheck:now()+500})}
 async function tick(){
  if(!state.active||running||!isReady()||isBusy()||bot.health<=0||state.phase==='리스폰 대기'||now()<state.nextCheck)return
  running=true;const token=currentToken()
  try{
   check(token)
   const close=enemies().filter(e=>pointDistance(e.position,bot.entity.position)<(e.name==='skeleton'?12:8)).sort((a,b)=>pointDistance(a.position,bot.entity.position)-pointDistance(b.position,bot.entity.position))
   if(close.length){
    if(state.retreats>=3){update('안전 대기','주변 적이 남아 있어 기존 목표를 보존하고 기다립니다. 위험이 사라지면 다시 확인합니다.',{safeSince:0,nextCheck:now()+5000});return}
    update('리스폰 주변 위험 회피','주변 적과 먼저 거리를 확보합니다.',{retreats:state.retreats+1,safeSince:0})
    try{await run(()=>retreat(close[0],token));check(token);update('주변 확인','주변 적과 거리를 확보했습니다. 회수 조건을 다시 확인합니다.',{nextCheck:now()+1000})}
    catch(error){check(token);update('주변 확인','위험 회피 경로를 다시 확인합니다: '+error.message,{nextCheck:now()+2000})}
    return
   }
   if(bot.health<12&&bot.food<18&&food){
    update('리스폰 후 식사·회복','주변 적이 없는 것을 확인했습니다. 저장된 목표를 보존하고 회복에 필요한 식량을 확보합니다.')
    try{await run(()=>food(token));check(token);update('주변 확인','식사 결과와 체력 회복을 확인합니다.',{nextCheck:now()+1000})}
    catch(error){check(token);update('안전 대기','회복할 식량 경로를 다시 확인합니다: '+error.message,{nextCheck:now()+2000})}
    return
   }
   if(state.cooldownUntil>now()||state.retreats>=3||bot.health<12){
    if(!state.safeSince)state.safeSince=now()
    if(state.cooldownUntil>now()||bot.health<12||now()-state.safeSince<5000){update('안전 대기',`기존 목표를 저장했습니다. 주변 위험·체력 확인 중${state.cooldownUntil>now()?' · 재개까지 최소 '+Math.ceil((state.cooldownUntil-now())/1000)+'초':''}`,{nextCheck:now()+2000});return}
   }
   if(state.phase==='목표 재개 준비'){
    const saved=state.resume,current=goal(),same=saved&&current&&saved.kind===current.kind&&saved.request===current.request&&saved.index===current.index
    if(!state.resumeRequested){update('복구 완료 · 목표 대기','사망 후 복구를 마쳤습니다. 진행 중이던 자동 목표는 없어 새 지시를 기다립니다.',{active:false});say(state.reason);return}
    if(!same){update('복구 완료 · 목표 확인','목표가 바뀌었거나 완료되어 이전 목표를 자동으로 재개하지 않습니다.',{active:false,resumeRequested:false});say(state.reason);return}
    update('기존 목표 재개','아이템 회수 결과를 반영하고 사망 전에 진행하던 목표를 이어갑니다.',{active:false})
    check(token);await resume(saved,token);check(token);say(state.reason);return
   }
   const death=state.death,age=now()-Date.parse(death.time),distance=pointDistance(bot.entity.position,death.position)
   if(!death.inventory.length){finishRecovery('사망 전에 소지한 아이템이 없어 회수를 생략합니다.');return}
   if(death.dimension!==bot.game.dimension){finishRecovery('사망 위치가 다른 차원에 있어 자동 회수를 생략합니다. 현재 소지품으로 기존 목표를 다시 준비합니다.');return}
   if(age>=270000){finishRecovery('사망 후 시간이 지나 드롭 소실 가능성이 높아 회수를 생략합니다.');return}
   if(distance>96){finishRecovery('사망 위치가 96블록보다 멀어 자동 회수를 생략합니다. 장거리 회수는 별도 목표로 지정할 수 있습니다.');return}
   if(state.recentDeaths.length>=3){finishRecovery('반복 사망 지점 재진입을 생략합니다. 현재 소지품을 기준으로 기존 목표를 다시 계획합니다.');return}
   if(enemies().some(e=>pointDistance(e.position,death.position)<10)){finishRecovery('사망 지점에 적이 남아 있어 회수를 생략합니다. 다시 준비한 뒤 접근해야 합니다.');return}
   update('사망 아이템 회수','저장된 사망 지점으로 이동해 소지품 회수를 확인합니다.',{attempts:state.attempts+1})
   try{
    const result=await run(()=>recover(death,token));check(token)
    finishRecovery(`사망 아이템 ${result?.recovered||0}개를 인벤토리에서 확인했습니다.`)
   }catch(error){
    check(token)
    if(state.attempts>=2||['DEATH_EMPTY','DEATH_DANGER','DEATH_EXPIRED','DEATH_OTHER_DIMENSION'].includes(error.code))finishRecovery('아이템 회수를 마치지 못했습니다: '+error.message+' 기존 목표의 준비물을 다시 확인합니다.')
    else update('회수 재시도','회수 경로를 한 번 더 확인합니다: '+error.message,{nextCheck:now()+2000})
   }
  }catch(error){
   if(token!==currentToken()||!isReady())return
   update('복구 확인 필요',error.message,{active:false,resumeRequested:false});say(state.reason)
  }finally{running=false}
 }
 return {died,spawned,tick,cancel,isActive:()=>state.active,status:()=>({...state,running})}
}
module.exports={createDeathRecovery}
