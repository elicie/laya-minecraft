const {domains,normalizeObservation,labels,allowedActions}=require('./activity-policy')
const {CROPS}=require('./farming'),{HOSTILES}=require('./combat'),{toolLife}=require('./resource-collector')
const RESOURCE_BLOCKS={cobblestone:['stone','cobblestone'],raw_iron:['iron_ore','deepslate_iron_ore'],coal:['coal_ore','deepslate_coal_ore'],sand:['sand'],dirt:['dirt','grass_block']}
function createActivityManager(bot,hooks){
 const {policy,check,acquire,skills,world,structures,explore,execute,food}=hooks
 const sleep=hooks.sleep||((ms)=>new Promise(r=>setTimeout(r,ms))),blocked=new Map(),cache=new Map();let latest=null
 const items=()=>bot.inventory.items(),count=name=>items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
 const goalKey=g=>[g.type,g.design,g.crop,g.resource,g.target].join(':')
 function blockNames(resource){return resource==='logs'||resource==='planks'?Object.keys(bot.registry.blocksByName).filter(n=>n.endsWith('_log')):RESOURCE_BLOCKS[resource]||[]}
 function positions(names){
  if(!names.length||!bot.findBlocks)return []
  const p=bot.entity.position,key=bot.game.dimension+':'+Math.floor(p.x/8)+':'+Math.floor(p.y/8)+':'+Math.floor(p.z/8)+':'+names.join(','),old=cache.get(key)
  if(old&&old.until>Date.now()&&(!bot.blockAt||old.value.every(p=>names.includes(bot.blockAt(p)?.name))))return old.value
  if(cache.size>256)cache.clear()
  const value=bot.findBlocks({matching:b=>names.includes(b.name),maxDistance:48,count:16});cache.set(key,{until:Date.now()+2500,value});return value
 }
 function inspect(g,context={}){
  const needs=[],threats=Object.values(bot.entities||{}).filter(e=>e.type!=='player'&&!e.username&&(HOSTILES.has(e.name)||e.name==='spider'&&bot.time?.timeOfDay>=13000)&&e.position?.distanceTo(bot.entity.position)<20).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))
  const farm=(world.farmStatus?.().farms||[]).find(f=>f.crop===(g.crop||'wheat')),crop=CROPS[g.crop||'wheat']
  let construction=null,sources=0,toolReady=true,seedAvailable=true,farmPlaceKnown=true,have=0,goalDone=false,found=false
  const need=(item,target)=>{const have=count(item);if(have<target)needs.push({item,need:target,have,missing:target-have})}
  if(g.type==='build'){construction=structures.status(g.design);if(construction.origin)needs.push(...structures.pendingMaterials(g.design).filter(m=>m.missing>0));goalDone=construction.complete}
  if(g.type==='farm'){
   if(!items().some(i=>i.name.endsWith('_hoe')&&toolLife(i)>2))need('stone_hoe',count('stone_hoe')+1)
   seedAvailable=count(crop.seed)>0||!!farm?.planted||positions([crop.block]).length>0
   if(!farm&&crop.seed==='wheat_seeds'&&count(crop.seed)<8){need(crop.seed,8);seedAvailable=true}
   farmPlaceKnown=!!farm||positions(['water']).length>0&&positions(['dirt','grass_block','farmland']).length>0
   goalDone=g.mode==='setup'?!!farm?.complete&&!farm.unloaded:g.mode==='harvest'?(farm?.harvested||0)-(g.harvestStart??(farm?.harvested||0))>=g.quantity:false
  }
  if(g.type==='collect'){
   const names=g.resource==='logs'?Object.keys(bot.registry.itemsByName).filter(n=>n.endsWith('_log')):g.resource==='planks'?Object.keys(bot.registry.itemsByName).filter(n=>n.endsWith('_planks')):[g.resource]
   have=items().filter(i=>names.includes(i.name)).reduce((sum,i)=>sum+i.count,0);sources=positions(blockNames(g.resource)).length
   if(g.resource==='planks'&&items().some(i=>i.name.endsWith('_log')))sources=Math.max(1,sources)
   const pick=g.resource==='raw_iron'?'stone_pickaxe':['cobblestone','coal'].includes(g.resource)?'wooden_pickaxe':null
   if(pick){const tiers=pick==='stone_pickaxe'?['stone','iron','diamond','netherite']:['wooden','stone','iron','golden','diamond','netherite'];toolReady=items().some(i=>tiers.some(t=>i.name===t+'_pickaxe')&&toolLife(i)>2);if(!toolReady)need(pick,count(pick)+1)}
   goalDone=have>=g.quantity
  }
  if(g.type==='explore'){found=(g.resources||[]).length>0&&positions(g.resources).length>0;goalDone=g.mode!=='continuous'&&((g.resources||[]).length?found:(hooks.explorer?.status().visited||0)>(g.visitStart??Infinity))}
  const targetEnemies=g.target?threats.filter(e=>e.name===g.target):threats,weaponReady=!!require('./combat').usableWeapon(bot)
  if(g.type==='fight'){if(targetEnemies.length&&!weaponReady){const weapon=require('./combat').weaponRecipe(bot);need(weapon,count(weapon)+1)}goalDone=g.mode!=='continuous'&&(g.killed||0)>=g.quantity}
  const flags=[...(blocked.get(goalKey(g))||new Map())].filter(([,until])=>until>Date.now()).map(([action])=>action)
  const observation=normalizeObservation({domain:g.type,mode:g.mode||'once',health:bot.health,hunger:bot.food,bagFull:bot.inventory.slots.slice(9,45).filter(Boolean).length===36,goalDone,siteKnown:!!construction?.origin,suppliesMissing:needs.length>0,farmPlaceKnown,seedAvailable,ripe:farm?.ripe||0,growing:!!farm?.complete&&!farm.ripe,checkDue:Date.now()>=(context.nextTickAt||0),have,target:g.quantity||1,sources,toolReady,found,threats:g.type==='fight'?targetEnemies.length:threats.length,closeThreats:threats.filter(e=>e.position.distanceTo(bot.entity.position)<8).length,creeperClose:threats.some(e=>e.name==='creeper'&&e.position.distanceTo(bot.entity.position)<8),bowReady:count('bow')>0&&count('arrow')>0,weaponReady,built:construction?.built||0,harvested:farm?.harvested||0,visited:hooks.explorer?.status().visited||0,kills:g.killed||0,failures:context.failures||0,blocked:flags})
  return {observation,needs,threats,farm,construction}
 }
 async function step(g,token,context={}){
  check(token)
  if(g.type==='farm'&&g.mode==='harvest'&&g.harvestStart==null)g.harvestStart=(world.farmStatus?.().farms||[]).find(f=>f.crop===g.crop)?.harvested||0
  if(g.type==='explore'&&g.visitStart==null)g.visitStart=hooks.explorer?.status().visited||0
  const before=inspect(g,context),inventoryBefore=items().map(i=>({name:i.name,count:i.count})),decision=await policy.decide(before.observation);check(token);latest={decision,preparation:before.needs,observation:before.observation}
  const details=()=>({goal:{...g},preparation:before.needs,inventoryBefore,inventoryAfter:items().map(i=>({name:i.name,count:i.count}))})
  let result={action:decision.action,complete:false,reason:(decision.source==='laya'?'Laya 선택: ':'기본 복구 선택: ')+labels[decision.action]}
  try{
   const now=inspect(g,context)
   if(!allowedActions(now.observation).includes(decision.action))throw new Error('판단 후 관측 상태가 바뀌어 이 행동을 실행할 수 없습니다.')
   if(decision.action==='food'){const work=await food(token,1,true);result.nextCheck=work.waiting?work.nextCheck:Date.now()+2000}
   else if(decision.action==='pause'){result.paused=true;result.reason=now.observation.health<8?'체력이 낮아 회복과 주변 확인이 필요합니다.':now.observation.bagFull?'가방이 가득 찼습니다. 상자에 보관한 후 이어가기를 실행해 주세요.':'허용된 행동 경로를 확인하지 못했습니다. 주변 상황을 확인하고 이어가 주세요.'}
   else if(decision.action==='finish'){if(!now.observation.goalDone)throw new Error('실제 달성 상태를 확인하지 못했습니다.');result.complete=true}
   else if(decision.action==='wait'){result.nextCheck=g.type==='farm'?(context.nextTickAt>Date.now()?context.nextTickAt:Date.now()+30000):Date.now()+5000}
   else if(decision.action==='survey')await structures.site(g.design,token)
   else if(decision.action==='gather'){const required=now.needs[0];if(!required)throw new Error('확보할 준비물이 없습니다.');await acquire(required.item,required.need,token)}
   else if(decision.action==='retreat'){const enemy=now.threats[0];if(!enemy)throw new Error('퇴각할 적대 몹을 관측하지 못했습니다.');await skills.retreat(enemy,token);result.nextCheck=Date.now()+2000}
   else if(decision.action==='search'&&g.type!=='explore'){
    const item=now.needs[0]?.item,resources=g.type==='collect'?blockNames(g.resource):g.type==='farm'?(item==='wheat_seeds'?['short_grass','tall_grass']:now.observation.farmPlaceKnown?[CROPS[g.crop||'wheat'].block]:['water']):item?.endsWith('_planks')||item?.endsWith('_log')?blockNames('logs'):item==='glass_pane'?['sand']:item==='cobblestone'?RESOURCE_BLOCKS.cobblestone:[]
    hooks.explorer?.setFocus(resources);await explore(token,{mode:g.type==='collect'?'resource':'surface',resources});blocked.delete(goalKey(g));result.nextCheck=Date.now()+2000
   }else if(['farm','build','collect','search','fight'].includes(decision.action)){await execute(g,token);check(token);await sleep(150);result.complete=inspect(g,context).observation.goalDone}
   else throw new Error('등록되지 않은 행동 판단입니다.')
   check(token);policy.outcome(decision,true,inspect(g,{...(hooks.context?.()||context),...(result.nextCheck?{nextTickAt:result.nextCheck}:{})}).observation,null,details());return result
  }catch(error){
   check(token)
   const key=goalKey(g);if(error.code!=='COLLECTION_PROGRESS'){if(!blocked.has(key))blocked.set(key,new Map());blocked.get(key).set(decision.action,Date.now()+180000)}
   policy.outcome(decision,false,inspect(g,context).observation,error.message,details());check(token);throw error
  }
 }
 function observe(g,context={}){return inspect(g,context).observation}
 const previews={farm:{type:'farm',crop:'wheat',mode:'continuous',quantity:1},build:{type:'build',design:'cabin',quantity:1},collect:{type:'collect',resource:'logs',quantity:16},explore:{type:'explore',resources:['iron_ore','deepslate_iron_ore'],mode:'once',quantity:1},fight:{type:'fight',mode:'continuous',quantity:1}}
 function view(g,context={}){return {...latest,observation:domains.includes(g?.type)?observe(g,context):null,previews:Object.fromEntries(domains.map(d=>[d,observe(g?.type===d?g:previews[d],g?.type===d?context:{})]))}}
 function waitNeedsDecision(g,context){if(g?.type!=='farm'||latest?.decision.action==='wait')return false;const s=observe(g,context);return s.growing&&!s.ripe&&!s.checkDue}
 return {step,observe,view,waitNeedsDecision,resetRecovery:()=>{blocked.clear();cache.clear()},supports:g=>domains.includes(g?.type)}
}
module.exports={createActivityManager,RESOURCE_BLOCKS}
