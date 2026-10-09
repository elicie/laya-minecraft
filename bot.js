const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const readline = require('node:readline')
const biomeData=require('minecraft-data')(process.env.MC_VERSION||'1.21.1').biomes
const { classify, log, actions } = require('./decision')
const { correct } = require('./feedback')
const lastDecisions=new Map()
const {inventoryState}=require('./inventory-state')
const {createShelter}=require('./shelter')
const {createCampaign}=require('./campaign')
const {createAcquisition}=require('./acquisition')
const {createSurvivalSkills}=require('./survival-skills')
const {createWorldSkills}=require('./world-skills')
const {createStructures,designs}=require('./structures')
const {createMinimap}=require('./minimap')
const {createEndgame}=require('./endgame')
const {createMissions,parseKnownGoals}=require('./missions')
const {createExplorer}=require('./exploration')
const {createCollector}=require('./resource-collector')
const {createCrafting}=require('./crafting')
const {createSurvivalPolicy}=require('./survival-policy')
const {createActivityPolicy}=require('./activity-policy')
const {createDeathRecovery}=require('./death-recovery')
const {createThreatResponse}=require('./threat-response')
const {crossDoor,climbLadder}=require('./building-navigation')
const {isHomeRequest}=require('./home')
const {createVillageWorker}=require('./village-worker')
const villageProfile=process.env.BOT_VILLAGE_PROFILE?JSON.parse(process.env.BOT_VILLAGE_PROFILE):null
let villageWorker=null
const statePath=name=>require('node:path').join(process.env.BOT_LOG_DIR||__dirname+'/logs',name)
const foodPolicy=createSurvivalPolicy({experienceFile:statePath('policy-experiences.jsonl')})
const activityPolicy=createActivityPolicy({experienceFile:statePath('activity-experiences.jsonl')})
const campaign=createCampaign(statePath('campaign.json'))
let missions=null,skills=null,world=null,structures=null,endgame=null,acquisition=null,explorer=null,collector=null,deathRecovery=null,threatResponse=null
let shelter=null
function goalComplete(){return auto.target==='shelter'?shelter?.status().complete:count(auto.target)>0}
const {planNext,MODEL,resolveGoal,describeRoadmap}=require('./qwen-planner')
let planningController=null
const history=[]
const {buildRoadmap}=require('./survival-plan')
const auto={enabled:false,target:'stone_pickaxe',phase:'대기',failures:0,started:0,model:MODEL,reason:'',steps:0,lastResult:null,request:'',roadmap:null}
let autoRunning=false
const blocked=new Map()
const owners = new Set((process.env.MC_OWNERS || '').split(',').filter(Boolean))
const bot = mineflayer.createBot({host:process.env.MC_HOST || '127.0.0.1',port:Number(process.env.MC_PORT || 25565),version:process.env.MC_VERSION || '26.1',username:process.env.MC_USERNAME || 'LayaBot',auth:process.env.MC_AUTH || 'offline',profilesFolder:__dirname+'/auth'})
bot.loadPlugin(pathfinder)
let ready = false, busy = false, generation = 0, job = 'idle', observedDeaths=0
let viewerReady=false,botViewer=null
let lastAliveInventory=[]
let healthPausedGoal=null,previousHealth=null,activeCommand=null,followCommand=null
async function ensureDifficulty(token){
 if(gameDifficulty()!=='peaceful')return
 if(!process.connected)throw new Error('일반 난이도로 서버를 전환한 후 이어가기를 실행해 주세요.')
 const id='difficulty-'+Date.now();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(new Error('서버 난이도 전환 응답 시간 초과')),12000);function listener(message){if(message.type==='difficulty_result'&&message.id===id)finish(message.ok?null:new Error(message.error||'난이도 전환 실패'))}function finish(error){clearTimeout(timer);process.removeListener('message',listener);error?reject(error):resolve()}process.on('message',listener);process.send({type:'difficulty_request',id})});check(token)
}
function gameDifficulty(){if(bot.game?.difficulty)return bot.game.difficulty;try{return require('node:fs').readFileSync(__dirname+'/server-data/server.properties','utf8').match(/^difficulty=(.+)$/m)?.[1]||'unknown'}catch{return 'unknown'}}
function biomeName(){const biome=bot.entity&&bot.blockAt(bot.entity.position)?.biome;return biome?.name||biomeData[biome?.id]?.name||null}
const minimap=createMinimap(bot)
function sendState() {
  if(ready&&bot.health>0)lastAliveInventory=bot.inventory.slots.filter(Boolean).map(i=>({name:i.name,count:i.count}))
  if(process.connected) process.send({type:'state',village:villageWorker?.status(),minimap:ready?minimap.snapshot():null,mapMarkers:ready?minimap.markers():[],yaw:bot.entity?.yaw??0,buildingDimensions:Object.fromEntries(Object.entries(designs).map(([k,d])=>[k,{width:d.width,depth:d.depth}])),ready,busy,job,viewerReady,threatResponse:threatResponse?.status(),recovery:deathRecovery?.status(),buildings:structures?.allStatus(),farming:world?.farmStatus(),combat:skills?.combatStatus(),exploration:explorer?.status(),collection:collector?.status(),auto:missions?missions.view():auto,campaign:ready?campaign.snapshot({inventory:inventoryItems(),equipment:bot.inventory.slots.slice(5,9).filter(Boolean),dimension:bot.game.dimension,difficulty:gameDifficulty()}):null,health:bot.health??null,food:bot.food??null,position:bot.entity?.position??null,...inventoryState(bot),world:{dimension:bot.game?.dimension||null,timeOfDay:bot.time?.timeOfDay??null,day:bot.time?.day??null,biome:biomeName()},experience:bot.experience||null,players:Object.keys(bot.players||{}).filter(n=>n!==bot.username)})
}
if(process.send) setInterval(sendState,500).unref()
process.on('message',message=>{
 if(message?.type?.startsWith('village_')){try{villageWorker?.receive(message)}catch(error){villageWorker?.setActive(false);log({type:'village_error',error:error.message})}return}
 if(message?.type==='command' && typeof message.text==='string') void command(message.text,message.player||null)
})
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms))
const crafting=createCrafting(bot,{check,sleep})
const inventoryItems = () => (bot.currentWindow || bot.inventory).items()
const count = name => inventoryItems().filter(i=>i.name===name).reduce((a,i)=>a+i.count,0)
const logsCount = () => inventoryItems().filter(i=>i.name.endsWith('_log')).reduce((a,i)=>a+i.count,0)
function say(text) { console.log(text); if (ready) bot.chat(text.slice(0,240)); log({type:'message',text}) }
function check(token) { if (token !== generation || !ready) throw new Error('작업 중지됨') }
function cancelCurrentWork(){bot.deactivateItem();planningController?.abort();generation++;bot.pathfinder.setGoal(null);bot.stopDigging();bot.clearControlStates();if(bot.currentWindow)bot.closeWindow(bot.currentWindow);job='idle'}
function stop({keepRecovery=false,preserveIntent=false,preserveContinuous=false}={}) { if(!preserveIntent)villageWorker?.setActive(false);threatResponse?.cancel();followCommand=null;if(!preserveIntent)healthPausedGoal=null;if(!keepRecovery)deathRecovery?.cancel();missions?.stop({preserveIntent,preserveContinuous});auto.enabled=false;auto.phase='중지';cancelCurrentWork() }
async function near(position, range, token) {
  check(token)
  for(let i=0;i<3;i++){const crossing=structures?.doorCrossing(bot.entity.position,position);if(!crossing)break;await crossDoor(bot,crossing,token,{check,walk:gotoNear,sleep})}
  const ladder=structures?.ladderAccess(bot.entity.position,position);if(ladder)await climbLadder(bot,ladder,token,{check,walk:gotoNear,sleep})
  for(const p of bot.findBlocks({matching:b=>b.name.endsWith('_door')&&b.name!=='iron_door'&&b.getProperties().half==='lower'&&!b.getProperties().open,maxDistance:4,count:4})){check(token);await bot.activateBlock(bot.blockAt(p))}
  return gotoNear(position,range,token)
}
async function gotoNear(position,range,token){
  check(token)
  const timer=setTimeout(()=>bot.pathfinder.setGoal(null),20000)
  try { await bot.pathfinder.goto(new goals.GoalNear(position.x,position.y,position.z,range)); check(token) }
  finally { clearTimeout(timer) }
}
function findBlock(names, distance=48) { return bot.findBlock({matching:b=>names.includes(b.name),maxDistance:distance}) }
async function harvest(blockNames,itemNames,target,token){return collector.collect(blockNames,itemNames,target,token)}

async function gather(names,desired,token) {
 const have=inventoryItems().filter(i=>names.includes(i.name)).reduce((a,i)=>a+i.count,0)
 return harvest(names,names,have+desired,token)
}
async function collectDrop(names,item,target,token) {return harvest(names,[item],target,token)}
async function explore(token,options={}) {
 const mission=missions?.view(),kind=mission?.goals?.[mission.index]?.type
 const surface=['build','farm','survive','hunt','fight'].includes(kind)
 return explorer.explore(token,{mode:surface?'surface':'resource',...(surface?{resources:kind==='farm'?['water']:[]}:{}),...options})
}

function startAuto(target='stone_pickaxe',request=target) {
  if(busy||autoRunning) {say('진행 중인 작업을 먼저 중지해 주세요.');return}
  auto.roadmap=null;auto.request=request;history.length=0;auto.steps=0;auto.reason='';auto.lastResult=null;auto.enabled=true;auto.target=target;auto.failures=0;auto.started=Date.now();auto.phase='다음 작업 선택'
  say(`자동 준비 시작: ${target}. Qwen이 현재 상황을 보고 다음 행동을 선택합니다.`)
}
function observation() {
 const names=['stone','cobblestone','iron_ore','deepslate_iron_ore','crafting_table','furnace']
 const nearby=names.map(name=>{const b=findBlock([name],40);return b?{name,position:b.position,distance:Math.round(b.position.distanceTo(bot.entity.position))}:null}).filter(Boolean)
 return {target:auto.target,request:auto.request,shelter:shelter?.status(),health:bot.health,food:bot.food,position:bot.entity.position,inventory:inventoryItems().map(i=>({name:i.name,count:i.count})),nearby,terrain:[[-1,0],[1,0],[0,-1],[0,1]].map(([x,z])=>({dx:x,dz:z,blocks:[-1,0,1,2].map(y=>bot.blockAt(bot.entity.position.floored().offset(x,y,z))?.name)})),history:history.slice(-6)}
}
async function autoTick() {
 if(!auto.enabled||!ready||busy||autoRunning||missions?.isActive()||deathRecovery?.isActive()||threatResponse?.isActive())return
 autoRunning=true;const token=generation
 try {
  if(Date.now()-auto.started>15*60*1000||bot.health<8||auto.steps>=30){auto.enabled=false;auto.phase='상태 확인 필요';say('자동 진행 한도 또는 체력 상태를 확인해 주세요.');return}
  auto.roadmap={...buildRoadmap(observation()),summary:auto.roadmap?.summary||''}
  if(goalComplete()){auto.enabled=false;auto.phase='목표 완료';say('인벤토리에서 목표 도구를 확인했어요. 자동 진행 완료!');return}
  auto.phase='Qwen 판단 중';busy=true;job='planning';planningController=new AbortController()
  const state=observation(),start=Date.now();state.roadmap=auto.roadmap
  let plan
  try{if(!auto.roadmap.summary){auto.phase='전체 계획 수립 중';auto.roadmap=await describeRoadmap(state,{signal:planningController.signal});check(token);log({type:'roadmap',request:auto.request,roadmap:auto.roadmap});state.roadmap=auto.roadmap;auto.phase='Qwen 판단 중'}plan=await planNext(state,{signal:planningController.signal});check(token)}finally{planningController=null;busy=false;job='idle'}
  if(!auto.enabled)return
  auto.reason=plan.reason;auto.phase=plan.action;auto.steps++
  const id=log({type:'plan',model:plan.model,target:auto.target,action:plan.action,reason:plan.reason,observation:state,latency_ms:Date.now()-start})
  if(plan.action==='stop'){stop();say(plan.reason);return}
  if(plan.action==='done'){if(!goalComplete())throw new Error('목표 아이템 미확인');auto.enabled=false;auto.phase='목표 완료';return}
  const result=await command('!'+plan.action,null,true)
  if(token!==generation||!auto.enabled)return
  const outcome={action:plan.action,ok:!!result?.ok,error:result?.error||null,inventory:inventoryItems().map(i=>({name:i.name,count:i.count}))}
  history.push(outcome);if(history.length>6)history.shift()
  auto.lastResult=outcome.ok?'성공':outcome.error||'실패'
  log({type:'plan_result',plan_id:id,...outcome})
  auto.failures=outcome.ok?0:auto.failures+1
  if(auto.failures>=4){auto.enabled=false;auto.phase='경로 확인 필요';say('네 번 연속 실패해 중지했어요. 활동 기록을 확인해 주세요.')}
  else auto.phase='다음 작업 선택'
 } catch(e) {
  if(token===generation){auto.enabled=false;auto.phase='판단 오류';auto.lastResult=e.message;say(e.message)}
 } finally {autoRunning=false}
}
setInterval(()=>void autoTick().catch(e=>{auto.enabled=false;auto.phase='오류';say(e.message)}),2000).unref()
async function craft(name, crafts, table, token) {
  await crafting.craft(name,crafts,table,token)
}
async function wood(amount, token) {
  const names=Object.keys(bot.registry.blocksByName).filter(n=>n.endsWith('_log'))
  if(logsCount()<amount) await gather(names,amount-logsCount(),token)
}
async function planks(target,token) {
  const plankCount=()=>inventoryItems().filter(i=>i.name.endsWith('_planks')).reduce((a,i)=>a+i.count,0)
  while(plankCount()<target) {
    await wood(1,token)
    const logItem=inventoryItems().find(i=>i.name.endsWith('_log'))
    await craft(logItem.name.replace('_log','_planks'),1,null,token)
  }
}
async function place(name, token) {
  const existing=findBlock([name],5)
  if(existing) {await near(existing.position,2,token);return bot.blockAt(existing.position)}
  const item=inventoryItems().find(i=>i.name===name)
  if(!item) throw new Error(`${name} 아이템 없음`)
  const origin=bot.entity.position.floored()
  for(const offset of [new Vec3(1,-1,0),new Vec3(-1,-1,0),new Vec3(0,-1,1),new Vec3(0,-1,-1)]) {
    const ground=bot.blockAt(origin.plus(offset)), above=ground && bot.blockAt(ground.position.offset(0,1,0))
    if(ground?.boundingBox==='block' && above?.name!=='air' && above && bot.pathfinder.movements.safeToBreak(above) && bot.canDigBlock(above)) {
      check(token)
      const tool=inventoryItems().find(i=>i.name==='stone_pickaxe')||inventoryItems().find(i=>i.name==='wooden_pickaxe')
      if(tool)await bot.equip(tool,'hand')
      await bot.dig(above);check(token)
    }
    if(ground?.boundingBox==='block' && above && bot.blockAt(above.position)?.name==='air') {
      check(token);await bot.equip(item,'hand');await bot.placeBlock(ground,new Vec3(0,1,0));await sleep(300);check(token)
      return bot.blockAt(above.position)
    }
  }
  throw new Error(`${name}을 놓을 평평한 공간이 없어요.`)
}
async function table(token) {
  const existing=findBlock(['crafting_table'],16)
  if(existing) {await near(existing.position,2,token);return existing}
  if(!count('crafting_table')) {await planks(4,token);await craft('crafting_table',1,null,token)}
  return place('crafting_table',token)
}
async function sticks(token) {if(count('stick')<2) {await planks(2,token);await craft('stick',1,null,token)}}
async function smeltIron(target,token){
 const missing=target-count('iron_ingot');if(missing<=0)return
 if(count('raw_iron')<missing)throw new Error(`철 원석이 ${missing-count('raw_iron')}개 부족해요.`)
 await planks(Math.ceil(missing/1.5),token)
 let block=findBlock(['furnace'],40)
 if(block)await near(block.position,2,token)
 else block=await place('furnace',token)
 const furnace=await bot.openFurnace(block)
 try{
  check(token)
  if(furnace.outputItem())await furnace.takeOutput()
  const raw=inventoryItems().find(i=>i.name==='raw_iron'),fuel=inventoryItems().find(i=>i.name.endsWith('_planks'))
  const need=Math.max(0,target-count('iron_ingot'))
  if(need){await furnace.putFuel(fuel.type,null,Math.ceil(need/1.5));check(token);await furnace.putInput(raw.type,null,need)}
  const deadline=Date.now()+missing*12000+15000
  while(count('iron_ingot')<target&&Date.now()<deadline){check(token);if(furnace.outputItem())await furnace.takeOutput();await sleep(500)}
  if(count('iron_ingot')<target)throw new Error('철 제련 시간 초과')
 }finally{furnace.close()}
}
async function pickaxe(material,token) {
  if(count(material+'_pickaxe')) return
  say(`${material} 곡괭이 재료를 준비할게요.`)
  if(material==='wooden') {await planks(9,token);await sticks(token)}
  else if(material==='stone') {await pickaxe('wooden',token);await collectDrop(['stone','cobblestone'],'cobblestone',3,token);await sticks(token)}
  else {
    await pickaxe('stone',token)
    await collectDrop(['stone','cobblestone'],'cobblestone',8,token)
    if(!count('furnace')) await craft('furnace',1,await table(token),token)
    if(count('iron_ingot')<3) {
      await collectDrop(['iron_ore','deepslate_iron_ore'],'raw_iron',3-count('iron_ingot'),token)
      await planks(4,token)
      const block=await place('furnace',token)
      const furnace=await bot.openFurnace(block)
      try {
        check(token)
        const raw=inventoryItems().find(i=>i.name==='raw_iron')
        const fuel=inventoryItems().find(i=>i.name.endsWith('_planks') && i.count>=2)
        if(!raw || !fuel) throw new Error('제련 재료가 부족해요.')
        await furnace.putFuel(fuel.type,null,Math.min(fuel.count,4))
        await furnace.putInput(raw.type,null,3-count('iron_ingot'))
        const deadline=Date.now()+65000
        while(count('iron_ingot')<3 && Date.now()<deadline) {
          check(token);if(furnace.outputItem()) await furnace.takeOutput();await sleep(500)
        }
        if(count('iron_ingot')<3) throw new Error('철 제련 시간 초과')
      } finally {furnace.close()}
    }
    await sticks(token)
  }
  await craft(material+'_pickaxe',1,await table(token),token)
}
let pendingCommands=0
async function command(text,player=null,fromAuto=false){pendingCommands++;try{return await executeCommand(text,player,fromAuto)}finally{pendingCommands--}}
async function executeCommand(text, player=null, fromAuto=false) {
  if(/^(멈춰|중지|그만|stop|!stop|자동\s*(?:중지|정지|끄기))$/i.test(text.trim())) {stop();say('멈췄어요.');return}
  if(!ready) return console.log('서버 접속 대기 중')
  if(villageWorker&&!fromAuto&&/^(?:마을|village)\s*(?:시작|재개|start|resume)$/i.test(text.trim())){stop();villageWorker.setActive(true);say('마을 역할 작업을 재개합니다.');return}
  if(villageWorker&&!fromAuto){villageWorker.setActive(false);if(villageWorker.isRunning()){cancelCurrentWork();const until=Date.now()+5000;while(busy&&Date.now()<until)await sleep(50)}}
  if(!fromAuto&&followCommand){followCommand=null;cancelCurrentWork()}
  if(!fromAuto&&threatResponse?.isActive()){
    threatResponse.cancel('새 명령을 받아 이전 작업의 자동 재개를 취소했습니다.')
    missions?.stop({preserveContinuous:true});auto.enabled=false;followCommand=null;cancelCurrentWork()
    const until=Date.now()+5000;while((busy||missions?.isRunning())&&Date.now()<until)await sleep(50)
  }
  if(/^(?:자율생활|생활 활동)\s*(?:켜기|시작|on)$/i.test(text.trim())){missions?.setContinuous(true);say('목표 사이에도 자율생활을 이어갑니다.');return}
  if(/^(?:자율생활|생활 활동)\s*(?:끄기|중지|off)$/i.test(text.trim())){missions?.setContinuous(false);if(missions?.isMaintenanceRunning())cancelCurrentWork();say('자율생활을 중지했습니다.');return}
  const homeRequest=isHomeRequest(text.trim().replace(/^!auto\s+/i,''))
  if(!fromAuto&&homeRequest&&busy){stop({preserveIntent:true});const until=Date.now()+5000;while(busy&&Date.now()<until)await sleep(50)}
  if(!fromAuto&&missions?.isMaintenanceRunning()){cancelCurrentWork();const until=Date.now()+5000;while((busy||missions.isMaintenanceRunning())&&Date.now()<until)await sleep(50)}
  if(!fromAuto)healthPausedGoal=null
  const correction=text.match(/^(?:정답|correct)\s+(\S+)$/)
  if(correction) {
    try {const label=correct(lastDecisions.get(player||'terminal'),correction[1],player||'terminal');say(`정답 ${label} 저장했어요. 다음 학습에 반영합니다.`)}
    catch(e){say(e.message)}
    return
  }
  if(!fromAuto&&deathRecovery?.isActive()){
    if(busy){say('사망 후 복구 중이에요. 먼저 !stop으로 중지해 주세요.');return}
    deathRecovery.cancel('새 명령을 받아 이전 목표의 자동 복구를 취소했습니다.')
  }
  const autoMatch=text.trim().match(/^!auto(?:\s+([\s\S]+))?$/i)
  if(autoMatch||(!fromAuto&&homeRequest)||(!fromAuto&&/지어|지으|짓|만들|건축|세워/.test(text)&&parseKnownGoals(text,bot.registry)?.some(g=>g.design==='castle'))||/^(?:자동.*|.*알아서.*|.*살아남.*)$/.test(text.trim())) {
    if(missions){auto.enabled=false;try{await missions.start((autoMatch?.[1]||text).trim())}catch(e){say(e.message)}return}

    if(busy||autoRunning){say('진행 중인 작업을 먼저 중지해 주세요.');return}
    const request=(autoMatch?.[1]||text).trim()
    if(['wooden_pickaxe','stone_pickaxe','iron_pickaxe','iron_sword','shelter'].includes(request)){startAuto(request,request);return}
    if(autoMatch&&!autoMatch[1]){say('자동으로 진행할 목표를 입력해 주세요. 예: !auto 철곡괭이 만들어 줘');return}
    auto.enabled=false;auto.request=request;auto.phase='목표 해석 중';auto.reason='';auto.lastResult=null
    busy=true;const token=generation;planningController=new AbortController()
    try {
      const goal=await resolveGoal(request,{signal:planningController.signal});check(token)
      log({type:'goal',request,target:goal.target,reason:goal.reason,model:MODEL})
      if(goal.target==='unsupported'){auto.phase='지원하지 않는 목표';auto.reason=goal.reason;say(goal.reason);return}
      busy=false;startAuto(goal.target,request);auto.reason=goal.reason
    }catch(e){if(token===generation){auto.phase='목표 해석 오류';auto.reason=e.message;say(e.message)}}
    finally{planningController=null;busy=false}
    return
  }
  if(!fromAuto){auto.enabled=false;missions?.stop({preserveContinuous:true})}
  if(busy) {say('작업 중이에요. 먼저 !stop으로 중지해 주세요.');return}
  bot.pathfinder.setGoal(null)
  busy=true; const token=generation; const start=Date.now();activeCommand={text,player,fromAuto};followCommand=null
  try {
    const explicit=text.match(/^!(\w+)$/)
    const answer=explicit ? {choice:explicit[1],confidence:1,probabilities:{[explicit[1]]:1}} : await classify(text)
    check(token)
    if(answer.decision_id) lastDecisions.set(player||'terminal',answer.decision_id)
    const action=answer.choice
    if(!(action in actions)&&!(fromAuto&&['explore','gather_stone','prepare_furnace','gather_iron','smelt_iron','iron_sword','find_site','building_materials','build_shelter'].includes(action))) throw new Error('지원하지 않는 명령이에요.')
    const threshold = ['come','status','stop'].includes(action) ? 0.5 : 0.65
    if((answer.probabilities?.[action] || 0)<threshold || action==='unknown') {say('명령이 확실하지 않아요. !wood, !wooden_pickaxe, !stone_pickaxe, !iron_pickaxe를 사용할 수 있어요.');return}
    job=action
    configureMovement()
    log({type:'task_start',action,text,player,source:fromAuto?'qwen':explicit?'explicit':'laya',decision_id:answer.decision_id})
    if(action==='stop') stop()
    else if(action==='status') say(`체력 ${bot.health}, 음식 ${bot.food}. ${inventoryItems().map(i=>`${i.name} ${i.count}`).join(', ') || '빈 인벤토리'}`)
    else if(action==='come' || action==='follow') {
      const entity=player ? bot.players[player]?.entity : Object.values(bot.players).find(p=>p.username!==bot.username && p.entity)?.entity
      if(!entity) throw new Error('근처에 플레이어가 없어요.')
      if(action==='follow'){bot.pathfinder.setGoal(new goals.GoalFollow(entity,2),true);followCommand={text,player,fromAuto}}
      else await near(entity.position,2,token)
    } else if(action==='explore') await explore(token)
    else if(action==='gather_stone') await collectDrop(['stone','cobblestone'],'cobblestone',auto.roadmap?.stoneNeeded||3,token)
    else if(action==='prepare_furnace'){if(!count('furnace')&&!findBlock(['furnace'],40))await craft('furnace',1,await table(token),token)}
    else if(action==='gather_iron') await collectDrop(['iron_ore','deepslate_iron_ore'],'raw_iron',Math.max(0,(auto.target==='iron_sword'?2:3)-count('iron_ingot')),token)
    else if(action==='smelt_iron') await smeltIron(auto.target==='iron_sword'?2:3,token)
    else if(action==='iron_sword'){await sticks(token);await craft('iron_sword',1,await table(token),token)}
    else if(fromAuto&&action==='iron_pickaxe'){await sticks(token);await craft('iron_pickaxe',1,await table(token),token)}
    else if(action==='find_site') await shelter.findSite(token)
    else if(action==='building_materials') await shelter.materials(token)
    else if(action==='build_shelter') await shelter.build(token)
    else if(action==='wood') await wood(8,token)
    else await pickaxe(action.replace('_pickaxe',''),token)
    check(token);say(`${action} 완료${action==='follow'?' — 계속 따라갈게요.':'.'}`)
    log({type:'task_result',action,ok:true,elapsed_ms:Date.now()-start,inventory:inventoryItems().map(i=>({name:i.name,count:i.count}))})
    return {ok:true}
  } catch(e) {if(token===generation){say(e.message);log({type:'task_result',ok:false,job,error:e.message,elapsed_ms:Date.now()-start})}return {ok:false,error:e.message,interrupted:token!==generation}}
  finally {activeCommand=null;busy=false;if(job!=='follow') job='idle'}
}
bot.once('spawn',()=>{
  if(process.env.WEB_VIEWER==='1') {
    try {
      const viewerPort=Number(process.env.BOT_VIEWER_PORT||3008),viewerDistance=Number(process.env.BOT_VIEWER_DISTANCE||4),viewerPrefix=process.env.BOT_VIEWER_PREFIX||'/view'
      if(!Number.isInteger(viewerPort)||viewerPort<1024||viewerPort>65535||!Number.isInteger(viewerDistance)||viewerDistance<1||viewerDistance>8||!/^\/view(?:\/fleet\/[A-Za-z0-9_]{1,16})?$/.test(viewerPrefix))throw new Error('Invalid viewer configuration')
      botViewer=require('./viewer-compat').createBotViewer(bot,{port:{port:viewerPort,host:'127.0.0.1'},prefix:viewerPrefix,firstPerson:true,viewDistance:viewerDistance})
      viewerReady=true
    } catch(e) {log({type:'error',error:'Viewer: '+e.message})}
  }
})
function configureMovement() {
  const movement=new Movements(bot)
  movement.canDig=true;movement.allow1by1towers=false;movement.allowParkour=false;movement.maxDropDown=3;movement.entitiesToAvoid=new Set(['creeper','witch','blaze','wither_skeleton'])
  movement.exclusionAreasBreak.push(block=>structures?.protects(block.position)||villageWorker?.protects(block.position)?100:0)
  const pick=inventoryItems().some(i=>i.name.endsWith('_pickaxe'))
  const allowed=['dirt','grass_block','short_grass','tall_grass','vine','snow','gravel','sand',...(pick?['stone','cobblestone','andesite','diorite','granite','deepslate','tuff','coal_ore','iron_ore','deepslate_iron_ore','netherrack','end_stone']:[])]
  for(const block of Object.values(bot.registry.blocksByName)) {
    if(!block.name.endsWith('_leaves')&&!allowed.includes(block.name))movement.blocksCantBreak.add(block.id)
  }
  bot.pathfinder.thinkTimeout=10000;bot.pathfinder.searchRadius=45
  bot.pathfinder.setMovements(movement)
}
bot.on('spawn',()=>{
  configureMovement();shelter ||= createShelter(bot,{check,near,planks,log});ready=true;previousHealth=bot.health
  if(!missions){
    explorer=createExplorer(bot,{check,near,log},statePath('exploration.json'))
    collector=createCollector(bot,{check,near,sleep,log,protects:p=>structures?.protects(p)||villageWorker?.protects(p)||false,onResource:names=>explorer.setFocus(names)})
    skills=createSurvivalSkills(bot,{check,near,craft,table,place,planks,collectDrop,sleep,log,acquire:(...args)=>acquisition.acquire(...args),protectsAnimal:e=>villageWorker?.protectsAnimal(e)||false})
    acquisition=createAcquisition(bot,{check,collectDrop,craft,table,smelt:skills.smelt,huntMob:skills.huntMob,onResource:names=>explorer.setFocus(names),protects:p=>villageWorker?.protects(p)||false})
    world=createWorldSkills(bot,{check,near,acquire:acquisition.acquire,place,sleep,log,farmingArea:()=>villageWorker?.area()||null},statePath('farms.json'))
    structures=createStructures(bot,{check,near,planks,log,acquire:acquisition.acquire,sleep},statePath('structures.json'))
    endgame=createEndgame(bot,{check,near,acquire:acquisition.acquire,explore,huntMob:skills.huntMob,sleep,campaign},statePath('endgame.json'))
    missions=createMissions(bot,{continuous:!villageProfile,foodPlanner:villageProfile?null:require('./food-planner').createFoodPlanner(bot,{world,log}),commandPending:()=>pendingCommands>0,near,activityPolicy,foodPolicy,deaths:()=>observedDeaths,check,token:()=>generation,isBusy:()=>busy||!ready||deathRecovery?.isActive()||threatResponse?.isActive()||job==='follow',run:async fn=>{busy=true;job='mission';configureMovement();try{return await fn()}finally{busy=false;job=followCommand?'follow':'idle'}},acquire:acquisition.acquire,skills,world,structures,endgame,campaign,collector,explorer,planks,ensureDifficulty,difficulty:gameDifficulty,cancelPath:()=>bot.pathfinder.setGoal(null),explore,log,follow:async token=>{const e=Object.values(bot.players).find(p=>p.username!==bot.username&&p.entity)?.entity;if(!e)throw new Error('주변 플레이어가 없습니다.');check(token);bot.pathfinder.setGoal(new goals.GoalFollow(e,2),true);followCommand={text:'!follow',player:e.username||null,fromAuto:false}}},statePath('mission.json'))
    if(villageProfile)villageWorker=createVillageWorker(bot,{check,token:()=>generation,isReady:()=>ready,isBusy:()=>busy||pendingCommands>0||deathRecovery?.isActive()||threatResponse?.isActive(),near,structures,world,skills,acquire:acquisition.acquire,food:missions.recoverFood,sleep,log,send:message=>{if(process.connected)process.send(message)},file:statePath('village-role.json'),run:async fn=>{busy=true;job='village';configureMovement();try{return await fn()}finally{busy=false;job='idle'}}},villageProfile)
    const savedGoal=()=>{const m=missions.view();return (villageWorker?.isActive()?{kind:'village',request:'마을 역할',index:0}:null)||missions.deathCheckpoint()||(m.continuous?{kind:'routine',request:'자율생활',index:0}:auto.request?{kind:'legacy',request:auto.request,index:0}:null)}
    deathRecovery=createDeathRecovery(bot,{check,token:()=>generation,isReady:()=>ready,isBusy:()=>busy,stopWork:()=>stop({keepRecovery:true,preserveIntent:true}),goal:savedGoal,log,say,food:missions.recoverFood,recover:world.recover,retreat:skills.retreat,run:async fn=>{busy=true;job='recover';configureMovement();try{return await fn()}finally{busy=false;job='idle'}},resume:async(previous,token)=>{check(token);if(previous.kind==='village')villageWorker?.setActive(true);else if(previous.kind==='mission')await missions.start('이어가기');else if(previous.kind==='routine')missions.setContinuous(true);else{auto.enabled=true;auto.started=Date.now();auto.failures=0;auto.phase='다음 작업 선택'}}},statePath('death-recovery.json'))
    threatResponse=createThreatResponse(bot,{
      check,token:()=>generation,isReady:()=>ready,isBusy:()=>busy||autoRunning||missions.isRunning()||villageWorker?.isRunning(),
      hasWork:()=>!deathRecovery.isActive()&&(!!activeCommand||!!followCommand||auto.enabled||missions.wantsWork()||villageWorker?.isActive()),
      suspend:()=>{const checkpoint={mission:missions.suspendForThreat(),village:villageWorker?.isActive(),command:activeCommand||followCommand,legacy:auto.enabled};auto.enabled=false;followCommand=null;return checkpoint},
      interrupt:cancelCurrentWork,skills,food:missions.recoverFood,log,
      run:async fn=>{busy=true;job='defend';configureMovement();try{return await fn()}finally{busy=false;job='idle'}},
      resume:checkpoint=>{
        if(checkpoint.village&&villageWorker?.isActive())return true
        if(checkpoint.command&&!checkpoint.legacy){
          missions.resumeAfterThreat(checkpoint.mission)
          const token=generation,commandToResume=checkpoint.command
          setImmediate(()=>{if(ready&&token===generation&&!busy&&!deathRecovery.isActive())void command(commandToResume.text,commandToResume.player,commandToResume.fromAuto)})
          return true
        }
        if(checkpoint.legacy){auto.enabled=true;auto.phase='다음 작업 선택';auto.started=Date.now()}
        return missions.resumeAfterThreat(checkpoint.mission)||checkpoint.legacy
      }
    })
    setInterval(()=>void threatResponse.tick().catch(e=>log({type:'error',error:e.message})),200).unref()
    setInterval(()=>void deathRecovery.tick().catch(e=>log({type:'error',error:e.message})),1000).unref()
    setInterval(()=>void (villageWorker?.isActive()?villageWorker.tick():missions.tick()).catch(e=>log({type:'error',error:e.message})),2000).unref()
  }
  if(!deathRecovery?.spawned())say('Laya 준비됐어요. 채팅: laya 나무 캐 줘 / laya 따라와 / laya 철곡괭이 만들어 / !stop')
  if(process.env.BOT_ONCE) command(process.env.BOT_ONCE).finally(()=>{bot.quit();setTimeout(()=>process.exit(0),500)})
})
bot.on('chat',(username,message)=>{
  if(username===bot.username || !owners.has(username)) return
  if(message==='!stop') return void command(message,username)
  const escapedUsername=bot.username.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const match=message.match(new RegExp('^(?:'+escapedUsername+'|laya|라야)\\s+(.+)$','i'))
  if(match) void command(match[1],username)
})
bot.on('health',()=>{if(previousHealth!==null&&bot.health>0&&bot.health<previousHealth)threatResponse?.damage();previousHealth=bot.health})
bot.on('entityHurt',entity=>{if(entity.id===bot.entity?.id)threatResponse?.damage()})
bot.on('death',()=>{
 const recovery=deathRecovery?.status(),previous=(villageWorker?.isActive()?{kind:'village',request:'마을 역할',index:0}:null)||missions?.deathCheckpoint()|| (missions?.view().continuous?{kind:'routine',request:'자율생활',index:0}:auto.enabled?{kind:'legacy',request:auto.request,index:0}:healthPausedGoal||(recovery?.active&&recovery.resumeRequested?recovery.resume:null))
 const inventory=bot.inventory.slots.filter(Boolean).map(i=>({name:i.name,count:i.count}))
 observedDeaths++;ready=false
 campaign.record('death',{position:bot.entity.position,dimension:bot.game.dimension,inventory:inventory.length?inventory:lastAliveInventory,goal:previous})
 deathRecovery?.died({position:bot.entity.position,dimension:bot.game.dimension,inventory:inventory.length?inventory:lastAliveInventory,resume:previous})
 if(!deathRecovery)stop()
 sendState()
})
bot.on('entityDead',entity=>{if(entity.name==='ender_dragon'&&bot.game.dimension.includes('the_end')){campaign.record('dragon',{source:'server_entity_dead',entityId:entity.id,position:entity.position});log({type:'message',text:'서버의 엔더드래곤 사망 이벤트를 확인했습니다.'})}})
bot.on('kicked',reason=>{ready=false;threatResponse?.cancel('서버 연결이 종료되었습니다.');console.error('kicked',reason);log({type:'kicked',reason})})
bot.on('error',e=>{console.error(e);log({type:'error',error:e.message})})
bot.on('end',()=>{ready=false;threatResponse?.cancel('서버 연결이 종료되었습니다.');viewerReady=false;sendState();botViewer?.close();console.log('연결 종료');if(process.send)setTimeout(()=>process.exit(1),100);else if(!process.env.BOT_ONCE)process.exitCode=1})
readline.createInterface({input:process.stdin}).on('line',text=>void command(text))
function shutdown(){stop({preserveIntent:true});botViewer?.close();bot.quit();setTimeout(()=>process.exit(0),300)}
process.on('SIGINT',shutdown)
process.on('SIGTERM',shutdown)
