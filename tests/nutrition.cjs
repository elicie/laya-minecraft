const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Vec3}=require('vec3')
const {createFoodPlanner,foodOptions}=require('../food-planner'),{createSurvivalPolicy}=require('../survival-policy'),{createRoutine}=require('../routine'),{createCombat,canEngage}=require('../combat')
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'laya-nutrition-'))
async function main(){
 let inv=[],farms=[{crop:'wheat',ripe:20,unloaded:0}],calls=[],clock=0
 const bot={health:1,food:0,inventory:{items:()=>inv,slots:[]},entity:{position:new Vec3(0,64,0)},entities:{},game:{dimension:'overworld'},time:{timeOfDay:1000}},world={farmStatus:()=>({farms})}
 const planner=createFoodPlanner(bot,{world,fetchImpl:async(url,request)=>{const body=JSON.parse(request.body);assert(body.messages[1].content.includes('farm:wheat'));return {ok:true,json:async()=>({message:{content:JSON.stringify({id:'farm:wheat',reason:'익은 밀을 수확해 빵을 만들고 먹습니다.'})}})}}})
 await planner.request();assert.equal(planner.pick({}).meal,'bread');assert(!foodOptions(bot,world).some(c=>c.action==='hunt'),'critical-health food plan must not propose hunting')
 farms=[];assert.equal(planner.pick({}),null,'the selected crop must still be observed before execution')
 const bad=createFoodPlanner(bot,{world,fetchImpl:async()=>({ok:true,json:async()=>({message:{content:JSON.stringify({id:'hunt:imaginary',reason:'invented'})}})})});bot.health=20;await bad.request();assert.equal(bad.status().selected,null);assert(bad.status().error)
 const policy=createSurvivalPolicy({fetchImpl:async()=>({ok:true,json:async()=>({answers:{food_action:{choice:'explore',confidence:.99}}})}),experienceFile:path.join(temp,'events'),log:()=>{}})
 const observation={health:1,hunger:0,urgent:true,target:1,safe:0,raw:0,wheat:0,ripe:20}
 const d=await policy.decide(observation);assert.equal(d.action,'farm');assert.equal(d.source,'fallback');assert.equal(d.proposed,'explore')
 assert.equal((await policy.decide({...observation,safe:1})).action,'eat');assert.equal((await policy.decide({...observation,wheat:3})).action,'bread')
 const planned=await policy.decide({...observation,health:20,hunger:20,urgent:false,raw:1,ripe:0},{plan:{action:'cook',source:'qwen',model:'test-qwen',input:'mutton',meal:'cooked_mutton'}});assert.equal(planned.action,'cook');assert.equal(planned.source,'qwen');assert.equal(planned.model,'test-qwen')
 bot.health=1;const routine=createRoutine(bot,{world,check:()=>{},now:()=>clock,skills:{},structures:{allStatus:()=>[{kind:'house',origin:{x:100,y:64,z:100}}]},near:async()=>calls.push('home'),food:async()=>{calls.push('food');return {ready:false}},acquire:async()=>calls.push('tool'),explore:async()=>calls.push('explore')})
 await routine.step(0);clock+=2500;await routine.step(0);assert.deepEqual(calls,['food','food'],'low-health hunger must keep sourcing food before returning home or gathering tools')
 bot.health=20;bot.food=20;inv=[{name:'wooden_sword',count:1,maxDurability:59,durabilityUsed:0}];const enemy={name:'zombie',position:new Vec3(3,64,0)};assert(canEngage(bot,[enemy]));assert(!canEngage(bot,[enemy,{name:'creeper',position:new Vec3(5,64,0)}]));bot.food=5;assert(!canEngage(bot,[enemy]))
 bot.food=20;inv=[{name:'iron_axe',count:1,maxDurability:250,durabilityUsed:0}];bot.equip=async item=>calls.push(item.name)
 const combat=createCombat(bot,{check:()=>{},equip:async()=>{},acquire:async()=>assert.fail('an existing weapon must not require mining stone'),log:()=>{}});assert.equal((await combat.prepare(0)).weapon,'iron_axe')
 await replantWithoutHoe()
 console.log('PASS observed Qwen food choices, invalidated/made-up plans, starving crop priority without a hoe, low-health eating, hunger before maintenance, bounded defense and existing weapons')
}
async function replantWithoutHoe(){
 const {createFarming}=require('../farming'),{createFoodManager}=require('../food-manager'),plants=new Map(),seed={name:'wheat_seeds',count:20},plots=Array.from({length:4},(_,x)=>({x,y:64,z:0}))
 const bot={food:3,health:20,inventory:{items:()=>[seed]},entities:{},game:{dimension:'overworld'},entity:{position:new Vec3(0,65,0)}}
 const block=(p,name,boundingBox='empty')=>({name,position:p,boundingBox,light:15,skyLight:15,getProperties:()=>({age:0,moisture:7})})
 bot.blockAt=p=>{if(p.z===1&&p.y===64&&p.x===0)return block(p,'water');if(p.z===0&&p.y===64&&p.x>=0&&p.x<4)return block(p,p.x===3?'dirt':'farmland','block');return block(p,plants.get(p.toString())||'air')}
 bot.equip=async()=>{};bot._placeBlockWithOptions=async soil=>{plants.set(soil.position.offset(0,1,0).toString(),'wheat');seed.count--}
 const file=path.join(temp,'farm.json');fs.writeFileSync(file,JSON.stringify({farms:[{id:'test',server:`${process.env.MC_HOST||'127.0.0.1'}:${process.env.MC_PORT||25565}`,dimension:'overworld',crop:'wheat',plots}]}))
 const farm=createFarming(bot,{check:()=>{},near:async()=>{},sleep:async()=>{},acquire:async()=>assert.fail('replanting existing farmland does not require stone or a hoe'),log:()=>{}},file)
 const result=await farm.work(0,{crop:'wheat',forFood:true,produceTarget:3});assert.equal(result.plantedNow,3);assert(!result.complete);assert(result.waiting,'a partial but planted food field must wait for growth instead of gathering tools')
 const world={farmStatus:farm.status};assert(foodOptions(bot,world).some(c=>c.id==='wait:wheat'));assert(createFoodManager(bot,{world}).observe().growing)
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}))
