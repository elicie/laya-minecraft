const {safeFoods}=require('./campaign'),{HOSTILES}=require('./combat'),{toolLife}=require('./resource-collector')
function createRoutine(bot,hooks){
  const {check,skills,world,structures,acquire,collector,explorer,explore,near,food,log=()=>{},now=Date.now}=hooks
 const cooldowns=new Map();let state={phase:'생활 준비',action:null,reason:'목표 사이에도 생존과 주변 관리를 이어갑니다.',steps:0,failures:0,nextCheck:0,lastResult:null},running=false,lastSurvey=0
 const items=()=>bot.inventory.items(),count=n=>items().filter(i=>i.name===n).reduce((s,i)=>s+i.count,0)
 const available=()=>items().filter(i=>safeFoods.has(i.name)).reduce((s,i)=>s+i.count,0),ready=id=>(cooldowns.get(id)||0)<=now()
 function choose(){
  const threats=Object.values(bot.entities||{}).filter(e=>e.type!=='player'&&!e.username&&(HOSTILES.has(e.name)||e.name==='spider'&&bot.time?.timeOfDay>=13000)&&e.position.distanceTo(bot.entity.position)<16).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))
  const options=[],add=(id,title,reason,work)=>options.push({id,title,reason,work})
  if(threats.length){if(skills.defend&&require('./combat').canEngage(bot,threats))add('defend','생활 거점 방어','허기·체력과 무기를 확인해 감당할 수 있는 가까운 적을 상대합니다.',t=>skills.defend(t,{target:threats[0].name}));add('retreat','주변 위험 회피','생활 활동보다 주변 적과 거리 확보를 먼저 처리합니다.',t=>skills.retreat(threats[0],t))}
  if(bot.food<20&&available())add('eat','식량 섭취','실제 보유한 식량을 먹고 체력 회복을 준비합니다.',t=>skills.eat(t))
  if(bot.food<18&&!available()&&!threats.length){add('food','허기 회복 우선','식량을 확보해 먹을 때까지 도구·건축·목재 작업을 미룹니다.',t=>food(t,{target:1,urgent:true}));return options.find(o=>ready(o.id))||{id:'survey',title:'식량 경로 재확인',reason:'식량 확보 경로를 곧 다시 확인합니다.',work:async t=>{check(t);return {hunger:bot.food}}}}
  if(bot.health<12&&bot.food>=18&&!threats.length)add('heal','회복 관리','체력 회복을 확인하며 장비와 주변 위험을 점검합니다.',async t=>{await skills.equip(t);check(t);return {health:bot.health,hunger:bot.food}})
  const base=(structures?.allStatus?.()||[]).find(b=>['house','cabin'].includes(b.kind)&&b.origin)?.origin
  if(base&&near&&(bot.entity.position.y<base.y-3||bot.entity.position.distanceTo(base)>40))add('home','생활 거점 복귀','지하 또는 거점에서 멀어진 위치를 벗어나 생활 거점으로 돌아갑니다.',t=>near(new (require('vec3').Vec3)(base.x-2,base.y,base.z-2),3,t))
  if(bot.health>=12&&!threats.length){
   if(available()<4)add('food','식량 비축','먹을 식량 네 개를 목표로 사냥·조리·농사·식량 탐색을 이어갑니다.',t=>food(t,{target:4,urgent:bot.food<18}))
   if(skills.prepareWeapon&&!require('./combat').usableWeapon(bot))add('weapon','생활 무기 준비','보유 재료로 검을 제작하고 장착해 사냥과 거점 방어에 사용합니다.',t=>skills.prepareWeapon(t))
   if(!items().some(i=>['stone_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe'].includes(i.name)&&toolLife(i)>4))add('tool','채굴 도구 준비','돌곡괭이 이상을 준비하고 닳은 도구를 교체합니다.',t=>acquire('stone_pickaxe',count('stone_pickaxe')+1,t))
   const ripe=(world.farmStatus?.().farms||[]).find(f=>f.ripe>0&&!f.unloaded)
   if(ripe)add('farm','농장 수확·재파종','작물 성장 시간에는 다른 활동을 하고, 실제로 익은 작물이 생기면 수확합니다.',t=>world.farm(t,{crop:ripe.crop}))
   const wood=items().filter(i=>i.name.endsWith('_log')).reduce((s,i)=>s+i.count,0)
   if(wood<4&&collector)add('wood','생활 목재 확보','도구·연료·건축에 사용할 원목을 네 개 이상 비축합니다.',t=>{const names=Object.keys(bot.registry.blocksByName).filter(n=>n.endsWith('_log'));return collector.collect(names,names,4,t)})
   const drop=Object.values(bot.entities||{}).find(e=>e.name==='item'&&e.position.distanceTo(bot.entity.position)<6)
   if(drop&&near)add('pickup','주변 자원 회수','주변에 실제로 떨어진 자원을 인벤토리로 회수합니다.',t=>near(drop.position,0,t))
   if(bot.time?.timeOfDay>=13000&&bot.findBlock?.({matching:b=>b.name.endsWith('_bed'),maxDistance:32}))add('sleep','수면·밤 대비','관측한 침대에서 수면을 시도합니다.',t=>world.sleepInBed(t))
  }
  if(!threats.length&&bot.health>=12)add('explore','생활권 탐색','접근 가능한 지형과 자원을 관측하고 새 경로를 찾습니다.',t=>explore(t,{mode:'surface',resources:[],maxRadius:16}))
  const selected=options.find(o=>ready(o.id))
  return selected||{id:'survey',title:'주변·경로 재점검',reason:threats.length?'회피 경로와 주변 적을 다시 확인합니다.':bot.health<12?'체력과 식량 상태를 계속 확인합니다.':'막힌 경로의 재확인 시간을 관리하며 주변 자원을 관측합니다.',work:async t=>{check(t);if(now()-lastSurvey>=5000){explorer?.observe([]);lastSurvey=now()}return {health:bot.health,hunger:bot.food,threats:threats.length}}}
 }
 async function step(token){
  if(running||now()<state.nextCheck)return {skipped:true}
  running=true;const action=choose(),before={inventory:items().map(i=>({name:i.name,count:i.count})),position:{...bot.entity.position}},start=now()
  state={...state,phase:action.title,action:action.id,reason:action.reason,steps:state.steps+1}
  log({type:'routine_action',action:action.id,reason:action.reason,before})
  try{check(token);const result=await action.work(token);check(token);state.lastResult=result?.waiting?action.title+' 확인 · 성장 중':result?.ready===false?action.title+' 진행 · 식량 추가 확보 필요':action.title+' 수행';state.nextCheck=now()+2000;cooldowns.set(action.id,result?.waiting&&result.nextCheck>now()?result.nextCheck:now()+(action.id==='food'&&bot.food<18?500:({heal:4000,survey:5000,food:5000,home:10000,eat:1000}[action.id]||15000)));log({type:'routine_result',action:action.id,ok:true,result,before,after:{inventory:items().map(i=>({name:i.name,count:i.count})),position:{...bot.entity.position}},elapsed_ms:now()-start});return {ok:true,action:action.id}}
  catch(error){check(token);state.failures++;state.lastResult=error.message;state.reason=action.title+' 경로를 다시 확인합니다: '+error.message;state.nextCheck=now()+2000;cooldowns.set(action.id,now()+(action.id==='food'&&bot.food<18?5000:30000));log({type:'routine_result',action:action.id,ok:false,error:error.message,elapsed_ms:now()-start});return {ok:false,action:action.id,error:error.message}}
  finally{running=false}
 }
 return {step,status:()=>({...state,running}),reset:()=>{state.nextCheck=0},isRunning:()=>running}
}
module.exports={createRoutine}
