const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {Vec3}=require('vec3'),registry=require('minecraft-data')('1.21.1')
const {createFoodManager}=require('../food-manager'),{createMissions}=require('../missions'),{createSurvivalSkills}=require('../survival-skills')
const {safeFoods}=require('../campaign')
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-food-'))
function fixture(){
 let inv=[],token=0;const calls=[]
 const bot={registry,food:15,health:20,inventory:{items:()=>inv.filter(i=>i.count),slots:[]},entity:{position:new Vec3(0,64,0)},game:{dimension:'overworld'}}
 const add=(name,count)=>{const item=inv.find(i=>i.name===name);if(item)item.count+=count;else inv.push({name,count})}
 const hooks={check:t=>{if(t!==token)throw new Error('cancelled')},skills:{
  eat:async()=>{calls.push('eat');const item=bot.inventory.items().find(i=>safeFoods.has(i.name));assert(item,'never call eat without edible inventory');add(item.name,-1);bot.food=20},
  cook:async()=>{calls.push('cook');assert(bot.inventory.items().some(i=>i.name==='mutton'));add('mutton',-1);add('cooked_mutton',1)},
  hunt:async()=>{calls.push('hunt');throw new Error('No prey')}
 },world:{farmStatus:()=>({farms:[]}),farm:async()=>{calls.push('farm');return {waiting:true,nextCheck:Date.now()+30000}}},acquire:async(name,total)=>{calls.push('acquire '+name);add(name,total-(inv.find(i=>i.name===name)?.count||0))},explore:async(t,options)=>{calls.push('explore');assert.equal(options.mode,'surface');assert.deepEqual(options.resources,[])},log:()=>{}}
 return {bot,hooks,calls,add,cancel:()=>{token++},token:()=>token}
}
async function main(){
 const realNow=Date.now;let clock=realNow();Date.now=()=>clock
 try{
  for(const goal of ['엔더드래곤 처치까지 진행해 줘','일단 살아남아','iron_sword']){
   const f=fixture();f.add('mutton',1);let executed=0
   const mission=createMissions(f.bot,{...f.hooks,token:f.token,isBusy:()=>false,run:fn=>fn(),acquire:async(...args)=>{executed++;await f.hooks.acquire(...args)},structures:{},endgame:{},campaign:{snapshot:()=>({complete:true,stages:[]})}},path.join(temp,String(Math.random())+'.json'))
   await mission.start(goal);const original=mission.view().goals[0].type;await mission.tick()
   assert.deepEqual(f.calls,['cook']);assert.equal(mission.view().index,0);assert.equal(mission.view().failures,0);assert(mission.view().enabled)
   clock+=2100;await mission.tick();assert.deepEqual(f.calls,['cook','eat']);assert.equal(f.bot.food,20);assert.equal(mission.view().index,0);assert.equal(mission.view().goals[0].type,original);assert.equal(executed,0)
   if(goal==='iron_sword'){clock+=2100;await mission.tick();assert.equal(executed,1);assert.equal(mission.view().phase,'목표 완료')}
  }
  const waiting=fixture(),m=createMissions(waiting.bot,{...waiting.hooks,token:waiting.token,isBusy:()=>false,run:fn=>fn(),campaign:{snapshot:()=>({stages:[]})},structures:{}},path.join(temp,'waiting.json'))
  await m.start('iron_sword');await m.tick();assert.deepEqual(waiting.calls,['hunt','farm']);assert(m.view().enabled);assert.equal(m.view().failures,0)
  for(let i=0;i<10;i++)await m.tick();assert.deepEqual(waiting.calls,['hunt','farm'],'growth waiting must not burn retries');assert.equal(m.view().index,0)
  waiting.add('cooked_mutton',1);await m.tick();assert.equal(waiting.calls.at(-1),'eat','new edible stock should interrupt the growth wait')
  const searching=fixture();searching.hooks.world.farm=async()=>{searching.calls.push('farm');throw new Error('No soil')};const manager=createFoodManager(searching.bot,searching.hooks)
  assert.equal((await manager.step(0,{urgent:true,target:1})).ready,false);assert.deepEqual(searching.calls,['hunt','farm','explore'])
  const bread=fixture();bread.add('bread',2);bread.add('wheat',3);const prep=createFoodManager(bread.bot,bread.hooks);await prep.step(0,{target:8});assert.equal(bread.bot.inventory.items().find(i=>i.name==='bread').count,3,'craft target includes existing bread')
  const cancel=fixture();cancel.add('mutton',1);cancel.hooks.skills.cook=async()=>{cancel.cancel()};await assert.rejects(()=>createFoodManager(cancel.bot,cancel.hooks).step(0,{urgent:true,target:1}),/cancelled/);assert(!cancel.calls.includes('hunt'))
  const leftovers=fixture();leftovers.hooks.skills.recoverCookedFood=async()=>{leftovers.add('cooked_mutton',1);return true};assert((await createFoodManager(leftovers.bot,leftovers.hooks).step(0,{target:1})).ready);assert(!leftovers.calls.includes('hunt'))
  const blockedFurnace=fixture();blockedFurnace.hooks.skills.recoverCookedFood=async()=>{throw new Error('NoPath')};await createFoodManager(blockedFurnace.bot,blockedFurnace.hooks).step(0,{target:1});assert.deepEqual(blockedFurnace.calls,['hunt','farm'],'an inaccessible furnace must not prevent other food routes')
  await interruptedCooking()
  await delayedEating()
  console.log('PASS hungry dragon/survival/item goals cook then eat, preserve goals, farm wait without failures, early edible wakeup, fallback exploration, bread counts, leftover recovery and cancellation')
 }finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true})}
}
async function interruptedCooking(){
 const f=fixture();f.add('mutton',1);f.add('oak_planks',1);let closed=false,input={name:'mutton',count:1},output={name:'cooked_mutton',count:1}
 f.bot.findBlock=()=>({position:new Vec3(1,64,0)});f.bot.openFurnace=async()=>({inputItem:()=>input,outputItem:()=>output,putFuel:async()=>{},takeOutput:async()=>{f.add('cooked_mutton',output.count);output=null},putInput:async()=>assert.fail('existing output must satisfy cooking before adding another input'),close:()=>{closed=true}})
 const skills=createSurvivalSkills(f.bot,{...f.hooks,near:async()=>{},planks:async()=>{},sleep:async()=>{}});await skills.cook(0);assert(closed);assert.equal(f.bot.inventory.items().find(i=>i.name==='cooked_mutton').count,1)
}
async function delayedEating(){
 const f=fixture();f.add('cooked_mutton',1);let confirmed=false,deactivated=false
 f.bot.equip=async()=>{};f.bot.consume=async()=>{};f.bot.deactivateItem=()=>{deactivated=true}
 const skills=createSurvivalSkills(f.bot,{...f.hooks,sleep:async()=>{if(!confirmed){f.bot.food=20;f.add('cooked_mutton',-1);confirmed=true}}})
 await skills.eat(0);assert(confirmed);assert(deactivated);assert.equal(f.bot.food,20)
 const cancelled=fixture();cancelled.add('bread',1);let cleaned=false
 cancelled.bot.equip=async()=>{};cancelled.bot.consume=async()=>{cancelled.cancel()};cancelled.bot.deactivateItem=()=>{cleaned=true}
 const interrupted=createSurvivalSkills(cancelled.bot,{...cancelled.hooks,sleep:async()=>{}});await assert.rejects(()=>interrupted.eat(0),/cancelled/);assert(cleaned)
}
main().catch(error=>{console.error(error);process.exit(1)})
