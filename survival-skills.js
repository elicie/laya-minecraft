const {safeFoods}=require('./campaign')
function createSurvivalSkills(bot,{check,near,craft,table,place,planks,collectDrop,sleep,acquire,log,protectsAnimal=()=>false}){
 const items=()=> (bot.currentWindow||bot.inventory).items()
 const count=n=>items().filter(i=>i.name===n).reduce((a,i)=>a+i.count,0)
 async function equip(token){
  const grades=['netherite','diamond','iron','chainmail','golden','leather']
  for(const [kind,slot,index]of [['helmet','head',5],['chestplate','torso',6],['leggings','legs',7],['boots','feet',8]]){
   check(token);const worn=bot.inventory.slots[index],available=[...items(),...(worn?[worn]:[])].filter(i=>i.name.endsWith('_'+kind))
   available.sort((a,b)=>grades.indexOf(a.name.split('_')[0])-grades.indexOf(b.name.split('_')[0])||(b.maxDurability-(b.durabilityUsed||0))-(a.maxDurability-(a.durabilityUsed||0)))
   if(available[0]&&available[0]!==worn)await bot.equip(available[0],slot)
  }
  if(bot.inventory.slots[45]?.name!=='shield'){const shield=items().find(i=>i.name==='shield');if(shield)await bot.equip(shield,'off-hand')}
  const sword=['netherite','diamond','iron','stone','wooden'].map(m=>items().find(i=>i.name===`${m}_sword`)).find(Boolean);if(sword&&bot.heldItem?.slot!==sword.slot)await bot.equip(sword,'hand');check(token)
 }
 async function eat(token){
  check(token);if(bot.food>=20)return
  const item=items().filter(i=>safeFoods.has(i.name)).sort((a,b)=>(bot.registry.foodsByName?.[b.name]?.foodPoints||0)-(bot.registry.foodsByName?.[a.name]?.foodPoints||0))[0]
  if(!item)throw new Error('먹을 수 있는 안전한 식량이 없어요. 사냥/조리 또는 농사가 필요해요.')
  const beforeFood=bot.food,beforeCount=count(item.name)
  await bot.equip(item,'hand');check(token)
  // A consume promise can resolve before the server's actual consumption update.
  // Confirm an observed hunger or item-count change using public state only.
  try{
   await bot.consume();check(token);const until=Date.now()+5000
   while(bot.food<=beforeFood&&count(item.name)>=beforeCount&&Date.now()<until){check(token);await sleep(100)}
   check(token)
   if(bot.food<=beforeFood&&count(item.name)>=beforeCount)throw new Error('서버에서 식량 섭취 결과를 확인하지 못했어요.')
   await sleep(150);check(token)
  }finally{bot.deactivateItem()}
 }
 const combat=require('./combat').createCombat(bot,{check,near,sleep,equip,eat,acquire,log})
 const fight=combat.fight
 const failedHunts=new Map()
 async function huntCandidates(names,token){const candidates=Object.values(bot.entities).filter(e=>names.has(e.name)&&!protectsAnimal(e)&&(failedHunts.get(e.id)||0)<Date.now()).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position));if(!candidates.length)throw new Error('주변에 접근 가능한 사냥 대상이 없어요. 지상 초원을 탐색해야 합니다.');let lastError;for(const target of candidates.slice(0,3)){check(token);try{return await fight(target,token)}catch(e){check(token);lastError=e;failedHunts.set(target.id,Date.now()+180000);log?.({type:'message',text:`사냥 대상 변경: ${target.name} · ${e.message}`});if(bot.health<10)throw e}}throw lastError}
 async function huntMob(name,token){return huntCandidates(new Set([name]),token)}
 async function huntTarget(entity,token){check(token);if(!entity||protectsAnimal(entity))throw new Error('축산용 가축은 사냥 대상에서 보호합니다.');return fight(entity,token)}
 async function smelt(input,output,amount,token){
  const before=count(output);let block=bot.findBlock({matching:b=>b.name==='furnace',maxDistance:24})
  if(block)await near(block.position,2,token)
  else{if(!count('furnace')){if(acquire)await acquire('furnace',1,token);else{await collectDrop(['stone','cobblestone'],'cobblestone',8,token);await craft('furnace',1,await table(token),token)}}block=await place('furnace',token)}
  await planks(Math.ceil(amount/1.5),token);const furnace=await bot.openFurnace(block)
  try{
   check(token);if(furnace.outputItem()&&furnace.outputItem().name!==output)throw new Error('화로에 다른 작업의 결과가 있어요.')
   if(furnace.outputItem())await furnace.takeOutput()
   const inside=furnace.inputItem();if(inside&&inside.name!==input)throw new Error('화로에 다른 재료가 있어요.')
   const need=Math.max(0,before+amount-count(output)-(inside?.count||0)),raw=items().find(i=>i.name===input),fuel=items().find(i=>i.name.endsWith('_planks'))
   if(need&&(!raw||raw.count<need))throw new Error(`${input} 재료 부족`)
   if(fuel)await furnace.putFuel(fuel.type,null,Math.min(fuel.count,Math.ceil(amount/1.5)))
   check(token);if(need)await furnace.putInput(raw.type,null,need)
   const until=Date.now()+amount*12000+15000
   while(count(output)<before+amount&&Date.now()<until){check(token);if(furnace.outputItem())await furnace.takeOutput();await sleep(500)}
   if(count(output)<before+amount)throw new Error('제련 시간 초과')
  }finally{furnace.close()}
 }
 async function hunt(token){return huntCandidates(new Set(['cow','pig','chicken','sheep','rabbit']),token)}
 const defend=combat.defend
 async function recoverCookedFood(token){
  check(token);const block=bot.findBlock?.({matching:b=>b.name==='furnace',maxDistance:24});if(!block)return false
  await near(block.position,2,token);const furnace=await bot.openFurnace(block)
  try{check(token);const output=furnace.outputItem();if(!output||!safeFoods.has(output.name))return false;await furnace.takeOutput();check(token);return true}finally{furnace.close()}
 }
 async function cook(token,options={}){
  check(token);const raw=items().find(i=>require('./food-manager').RAW_FOODS.has(i.name)&&(!options.input||i.name===options.input));if(!raw)throw new Error('조리할 식재료가 없어요.')
  const amount=Math.min(raw.count,options.urgent?1:8),output=raw.name==='potato'?'baked_potato':'cooked_'+raw.name
  await smelt(raw.name,output,amount,token)
 }
 async function armor(token){for(const name of ['iron_helmet','iron_chestplate','iron_leggings','iron_boots']){check(token);if(!items().some(i=>i.name===name)&&!bot.inventory.slots.slice(5,9).some(i=>i?.name===name))await craft(name,1,await table(token),token)}await equip(token)}
 return {equip,eat,hunt,huntTarget,cook,recoverCookedFood,defend,fightThreat:fight,prepareWeapon:combat.prepare,retreat:combat.retreat,armor,huntMob,smelt,combatStatus:combat.status}
}
module.exports={createSurvivalSkills}
