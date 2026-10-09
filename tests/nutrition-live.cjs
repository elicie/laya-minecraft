// Administrative setup is restricted to this disposable world. Food gathering,
// crafting, eating, weapon crafting and attacks use the real survival protocol.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{Vec3}=require('vec3')
const mineflayer=require('mineflayer'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder')
const {createFarming}=require('../farming'),{createFoodManager}=require('../food-manager'),{createFoodPlanner}=require('../food-planner'),{createSurvivalPolicy}=require('../survival-policy'),{createSurvivalSkills}=require('../survival-skills'),{createCrafting}=require('../crafting'),{createAcquisition}=require('../acquisition')
const port=Number(process.env.MC_TEST_PORT||25566);assert.equal(port,25566)
const rcon=c=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',c],{encoding:'utf8',timeout:10000}),sleep=ms=>new Promise(r=>setTimeout(r,ms)),temp=fs.mkdtempSync(path.join(os.tmpdir(),'laya-nutrition-live-'))
const bot=mineflayer.createBot({host:'127.0.0.1',port,version:'1.21.1',username:'LayaFoodCombat',auth:'offline'});bot.loadPlugin(pathfinder)
const check=()=>{if(bot.health<=0)throw new Error('test bot died')},count=n=>bot.inventory.items().filter(i=>i.name===n).reduce((s,i)=>s+i.count,0),events=[]
const log=e=>{events.push(e);if(e.text)console.log(e.text)}
async function near(p,range,token){check();const timer=setTimeout(()=>bot.pathfinder.setGoal(null),12000);try{await bot.pathfinder.goto(new goals.GoalNear(p.x,p.y,p.z,range));check()}finally{clearTimeout(timer)}}
async function main(){
 await new Promise((resolve,reject)=>{bot.once('spawn',resolve);bot.once('error',reject);bot.once('kicked',r=>reject(new Error(JSON.stringify(r))))})
 const movement=new Movements(bot);movement.canDig=false;movement.allowParkour=false;bot.pathfinder.setMovements(movement)
 rcon('gamerule doMobSpawning false');rcon('gamerule doDaylightCycle false');rcon('time set day');rcon('kill @e[type=!minecraft:player]');rcon('clear LayaFoodCombat');rcon('fill -12 63 -12 12 63 12 minecraft:dirt');rcon('fill -12 64 -12 12 64 12 minecraft:grass_block');rcon('fill -12 65 -12 12 73 12 minecraft:air');rcon('setblock 0 65 2 minecraft:crafting_table');rcon('tp LayaFoodCombat 0.5 65 0.5');rcon('give LayaFoodCombat minecraft:oak_planks 20')
 const plots=[];for(let x=2;x<=7;x++){plots.push({x,y:64,z:0});rcon(`setblock ${x} 64 0 minecraft:farmland[moisture=7]`);rcon(`setblock ${x} 65 0 minecraft:wheat[age=7]`)}rcon('setblock 4 64 1 minecraft:water')
 await sleep(800);rcon('effect clear LayaFoodCombat');rcon('effect give LayaFoodCombat minecraft:regeneration 1 10 true');await sleep(1400);for(let i=0;i<4&&bot.food>=18;i++){rcon('effect give LayaFoodCombat minecraft:hunger 1 255 true');await sleep(1400)}rcon('damage LayaFoodCombat 14 minecraft:generic');await sleep(400)
 assert(bot.food<18);assert(bot.health<8&&bot.health>0);const before={health:bot.health,hunger:bot.food}
 const crafting=createCrafting(bot,{check,sleep}),table=async t=>{const b=bot.findBlock({matching:b=>b.name==='crafting_table',maxDistance:16});assert(b);await near(b.position,2,t);return b}
 const acquisition=createAcquisition(bot,{check,craft:crafting.craft,table,collectDrop:async()=>assert.fail('food and wooden weapon must not require unrelated mining')})
 const skills=createSurvivalSkills(bot,{check,near,sleep,acquire:acquisition.acquire,log})
 const file=path.join(temp,'farms.json');fs.writeFileSync(file,JSON.stringify({farms:[{id:'test-wheat',server:'127.0.0.1:25566',dimension:'overworld',crop:'wheat',plots,harvested:0,cycles:0}]}));process.env.MC_PORT='25566'
 const farming=createFarming(bot,{check,near,acquire:async()=>assert.fail('ripe harvesting must not acquire a hoe'),sleep,log},file),world={farmStatus:farming.status,farm:farming.work}
 const planner=createFoodPlanner(bot,{world,log}),policy=createSurvivalPolicy({log,experienceFile:path.join(temp,'policy.jsonl')})
 const manager=createFoodManager(bot,{check,world,skills,acquire:acquisition.acquire,policy,planner,sleep,log,explore:async()=>assert.fail('ripe wheat must take priority over wandering')})
 await planner.request();assert.equal(planner.status().selected?.meal,'bread','real Qwen must choose an observed food route');console.log('PASS real Qwen food plan',planner.status().selected)
 for(let i=0;i<15&&bot.food<18;i++){await manager.step(0,{urgent:true,target:1});await sleep(250)}
 assert(bot.food>=18);assert.equal(count('stone_hoe'),0);assert(farming.status().farms[0].harvested>=3);const recovered={health:bot.health,hunger:bot.food};console.log('PASS actual ripe wheat without hoe -> bread crafting -> eating',before,recovered)
 // A separate combat fixture supplies health recovery, but supplies no weapon.
 rcon('effect give LayaFoodCombat minecraft:regeneration 5 3 true');await sleep(2600);assert(bot.health>=14);assert.equal(count('wooden_sword'),0)
 const weapon=await skills.prepareWeapon(0);assert.equal(weapon.weapon,'wooden_sword');assert.equal(count('wooden_sword'),1);assert.equal(count('cobblestone'),0);console.log('PASS actual wooden sword crafted from owned planks without mining')
 rcon('summon minecraft:husk 5.5 65 -3.5 {NoAI:1b,PersistenceRequired:1b}');await sleep(500)
 const result=await skills.defend(0,{target:'husk'});assert(result.killed);assert.equal(skills.combatStatus().kills,1);console.log('PASS actual equipped weapon and server-confirmed hostile death')
 fs.writeFileSync('artifacts/nutrition-combat-live.json',JSON.stringify({scope:'Disposable flat world; supplied planks/table/ripe crop fixtures and separate combat health/mob fixture. Qwen real inference. No hoe, food, or weapon given during execution.',before,recovered,plan:planner.status(),farm:farming.status(),combat:skills.combatStatus(),events},null,2))
}
const deadline=setTimeout(()=>{console.error('nutrition live timeout');process.exit(1)},180000)
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(deadline);bot.quit();setTimeout(()=>{fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0)},400)})
