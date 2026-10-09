const {safeFoods}=require('./campaign')
const RAW_FOODS=new Set(['beef','porkchop','chicken','mutton','rabbit','cod','salmon','potato'])

function createFoodManager(bot,{check,skills,world,acquire,explore,log=()=>{},progress=()=>{},policy=null,planner=null,goal=()=> 'survive',deaths=()=>0,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const items=()=> (bot.currentWindow||bot.inventory).items()
 const count=name=>items().filter(i=>i.name===name).reduce((sum,i)=>sum+i.count,0)
 const available=()=>items().filter(i=>safeFoods.has(i.name)).reduce((sum,i)=>sum+i.count,0)
 let state={phase:'대기',reason:'',source:null,target:0,nextCheck:0,decision:null},nearby={until:0,key:'',farm:false}
 const blocked=new Map(),animals=new Set(['cow','pig','sheep','chicken','rabbit'])
 function observe(options={}){
  const farms=(world.farmStatus?.().farms||[]).filter(f=>!f.unloaded),position=bot.entity?.position
  const key=position?`${Math.floor(position.x/8)},${Math.floor(position.y/8)},${Math.floor(position.z/8)}`:''
  if(bot.findBlock&&(nearby.until<Date.now()||nearby.key!==key)){
   nearby={key,until:Date.now()+1500,farm:!!bot.findBlock({matching:b=>b.name==='water',maxDistance:24})&&!!bot.findBlock({matching:b=>['short_grass','tall_grass'].includes(b.name),maxDistance:24})}
  }
  const prey=Object.values(bot.entities||{}).filter(e=>e.type!=='player'&&animals.has(e.name)&&e.position&&position&&e.position.distanceTo(position)<=32).length
  return {version:1,goal:goal(),health:bot.health,hunger:bot.food,urgent:options.urgent??bot.food<18,target:options.target??(state.target||16),safe:available(),raw:items().filter(i=>RAW_FOODS.has(i.name)).reduce((sum,i)=>sum+i.count,0),wheat:count('wheat'),prey,ripe:farms.reduce((sum,f)=>sum+(f.ripe||0),0),growing:farms.some(f=>(f.complete||f.planted>0)&&!f.ripe),checkDue:Date.now()>=(options.nextCheck??state.nextCheck),farmReady:farms.length>0||nearby.farm||items().some(i=>['wheat_seeds','beetroot_seeds','carrot','potato','beetroot'].includes(i.name)),deaths:deaths(),blocked:[...blocked].filter(([,until])=>until>Date.now()).map(([action])=>action)}
 }
 function status(){return {...state,available:available(),observation:observe(),plan:planner?.status()||null}}
 function update(phase,reason,source=null){state={...state,phase,reason,source,nextCheck:0};progress(status());log({type:'message',text:reason})}
 function result(extra={}){return {...status(),ready:available()>=state.target,...extra}}
 async function relocate(token,error,options){
  check(token);update('식량 탐색',`${error.message} 식량 확보를 위한 다른 경로를 찾습니다.`)
  await explore(token,options);check(token);return result({ready:false})
 }
 async function farm(token,crop='wheat',urgent=false){
  update('농사·수확','사냥 대신 농장을 확인하고 익은 작물을 수확합니다.',crop)
  const ripe=(world.farmStatus?.().farms||[]).some(f=>f.crop===crop&&f.ripe>0&&!f.unloaded)
  const work=await world.farm(token,{crop,forFood:true,produceTarget:crop==='wheat'?3:1,...(urgent&&ripe?{harvestOnly:true}:{})});check(token)
  if(work.waiting&&!available()&&count('wheat')<3){
   state.phase='작물 성장 대기';state.reason='작물이 자라는 동안 기다립니다. 익으면 수확·조리 후 기존 목표를 이어갑니다.'
   state.nextCheck=work.nextCheck||Date.now()+30000;progress(status())
   return result({ready:false,waiting:true})
  }
  return result()
 }
 async function legacyStep(token,{target=16,urgent=false}={}){
  check(token);state.target=target;const waitUntil=state.nextCheck
  // Eating is called only after inspecting actual edible inventory.
  if(urgent&&available()){
   update('섭취','허기가 낮아 확보한 식량을 먹고 기존 목표를 이어갑니다.')
   await skills.eat(token);check(token);state.phase='섭취 완료'
   return result({ate:true,ready:bot.food>=18})
  }
  if(available()>=target){state.phase='식량 준비됨';state.nextCheck=0;return result()}
  const raw=items().find(i=>RAW_FOODS.has(i.name))
  if(raw){
   update('조리',`${raw.name} ${raw.count}개를 조리합니다. 화로·연료가 부족하면 먼저 확보합니다.`,raw.name)
   try{await skills.cook(token,{urgent});check(token);return result()}
   catch(error){check(token);return relocate(token,error,{mode:'resource'})}
  }
  if(count('wheat')>=3){
   const make=Math.min(Math.floor(count('wheat')/3),Math.max(1,target-available()))
   update('빵 제작',`보유한 밀로 빵 ${make}개를 제작합니다.`,'wheat')
   await acquire('bread',count('bread')+make,token);check(token);return result()
  }
  try{
   if(await skills.recoverCookedFood?.(token)){check(token);update('조리 결과 회수','화로에 남아 있던 조리된 식량을 회수했습니다.');return result()}
  }catch(error){check(token);log({type:'message',text:'화로 식량 회수 경로 변경: '+error.message})}
  const farms=world.farmStatus?.().farms||[]
  const ripe=farms.find(f=>f.ripe>0&&!f.unloaded)
  if(ripe){try{return await farm(token,ripe.crop,urgent)}catch(error){check(token);return relocate(token,error,{mode:'surface',resources:[]})}}
  update('사냥','먹을 식량이 없어 사냥 가능한 동물을 찾습니다.')
  try{await skills.hunt(token);check(token);state.phase='드롭 확보';return result({ready:false})}
  catch(error){check(token);log({type:'message',text:'식량 사냥 경로 변경: '+error.message})}
  const growing=farms.find(f=>(f.complete||f.planted>0)&&!f.unloaded&&f.ripe===0)
  if(growing&&waitUntil>Date.now()){state.phase='작물 성장 대기';state.reason='작물이 아직 자라는 중입니다. 수확 시간이 되면 다시 확인합니다.';state.nextCheck=waitUntil;progress(status());return result({ready:false,waiting:true})}
  try{return await farm(token,growing?.crop||'wheat')}
  catch(error){check(token);return relocate(token,error,{mode:'surface',resources:[]})}
 }
 async function policyStep(token,options){
  check(token);state.target=options.target??16;const waitUntil=state.nextCheck;let lastError
  for(let attempt=0;attempt<3;attempt++){
   const observation=observe({...options,nextCheck:waitUntil}),plan=planner?.pick(observation)
   const decision=await policy.decide(observation,{plan});check(token);state.decision=decision
   const action=decision.action;state.phase='식량 판단';state.reason=decision.source==='qwen'?`Qwen 식량 계획: ${plan.reason}`:decision.source==='laya'?`Laya가 ${require('./survival-policy').labels[action]} 행동을 선택했습니다.`:`식량 복구 경로를 사용합니다: ${decision.error}`;progress(status())
   try{
    let work
    if(action==='stop')throw new Error('체력이 낮아 회복과 주변 확인이 필요합니다.')
    if(action==='continue'){state.phase='식량 준비됨';state.nextCheck=0;work=result({ready:true})}
    else if(action==='eat'){update('섭취','확보한 식량을 먹고 기존 목표를 이어갑니다.');await skills.eat(token);check(token);state.phase='섭취 완료';work=result({ate:true,ready:bot.food>=18})}
    else if(action==='cook'){const raw=items().find(i=>RAW_FOODS.has(i.name)&&(!plan?.input||i.name===plan.input));update('조리',`${raw?.name||'식재료'}를 조리합니다. 화로와 연료가 부족하면 확보합니다.`,raw?.name);await skills.cook(token,{urgent:options.urgent,input:plan?.action==='cook'?plan.input:undefined});check(token);work=result()}
    else if(action==='bread'){const make=Math.min(Math.floor(count('wheat')/3),Math.max(1,state.target-available()));update('빵 제작',`보유한 밀로 빵 ${make}개를 제작합니다.`,'wheat');await acquire('bread',count('bread')+make,token);check(token);work=result()}
    else if(action==='hunt'){update('사냥','관측한 동물을 사냥해 식량 재료를 확보합니다.',plan?.target);if(plan?.action==='hunt'&&plan.target)await skills.huntMob(plan.target,token);else await skills.hunt(token);check(token);work=result({ready:false})}
    else if(action==='farm'){const farms=(world.farmStatus?.().farms||[]).filter(f=>!f.unloaded);work=await farm(token,(plan?.action==='farm'?plan.crop:null)||(farms.find(f=>f.ripe>0)||farms[0])?.crop||'wheat',options.urgent)}
    else if(action==='wait'){state.phase='작물 성장 대기';state.reason='Laya가 작물 성장 대기를 선택했습니다. 식량이 생기면 먼저 먹습니다.';state.nextCheck=waitUntil>Date.now()?waitUntil:Date.now()+30000;work=result({ready:false,waiting:true});progress(status())}
    else if(action==='explore'){update('식량 탐색','Laya가 식량 또는 조리 재료를 찾기 위해 탐색을 선택했습니다.');await explore(token,decision.observation.raw?{mode:'resource'}:{mode:'surface',resources:[]});check(token);work=result({ready:false})}
    else throw new Error('상황 판단의 실행 행동이 올바르지 않습니다.')
    // Inventory/health packets may arrive just after a public skill resolves.
    if(!['continue','wait'].includes(action)){await sleep(150);check(token)}
    policy.outcome(decision,action,true,observe(options));return {...work,...status(),ready:action==='eat'?bot.food>=18:work.ready}
   }catch(error){
    check(token);policy.outcome(decision,action,false,observe(options),error.message);lastError=error
    if(action==='stop'||action==='eat')throw error
    blocked.set(action,Date.now()+180000);log({type:'message',text:`${action} 실행 실패를 다음 Laya 판단에 반영합니다: ${error.message}`})
   }
  }
  throw lastError||new Error('식량 확보 경로를 확인하지 못했습니다.')
 }
 async function step(token,options={}){
  if(!policy)return legacyStep(token,options)
  check(token)
  if(available()<(options.target??16))planner?.request({target:options.target??16})
  // Recover already-cooked leftovers before forming the next observation.
  if(!available()&&!items().some(i=>RAW_FOODS.has(i.name))&&count('wheat')<3&&!observe(options).ripe){
   try{await skills.recoverCookedFood?.(token);check(token)}catch(error){check(token);log({type:'message',text:'화로 식량 회수 경로 변경: '+error.message})}
  }
  return policyStep(token,options)
 }
 return {step,status,available,observe}
}
module.exports={createFoodManager,RAW_FOODS}
