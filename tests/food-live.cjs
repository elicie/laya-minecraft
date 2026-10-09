// Administrative fixtures are restricted to the disposable server on port 25566.
// Cooking, eating, hunger updates and inventory assertions use the real protocol.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process')
const mineflayer=require('mineflayer'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder')
const {createSurvivalSkills}=require('../survival-skills'),{createMissions}=require('../missions')
const {createSurvivalPolicy}=require('../survival-policy')
const PORT=Number(process.env.MC_TEST_PORT||25566);assert.equal(PORT,25566,'Never run food fixtures against the user server')
const rcon=command=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8',timeout:10000})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),temp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-food-live-'))
const bot=mineflayer.createBot({host:'127.0.0.1',port:PORT,version:'1.21.1',username:'LayaFoodTest',auth:'offline'});bot.loadPlugin(pathfinder)
let generation=0
function check(token){assert.equal(token,generation,'cancelled')}
const count=name=>bot.inventory.items().filter(item=>item.name===name).reduce((sum,item)=>sum+item.count,0)
async function near(position,range,token){check(token);const timer=setTimeout(()=>bot.pathfinder.setGoal(null),10000);try{await bot.pathfinder.goto(new goals.GoalNear(position.x,position.y,position.z,range));check(token)}finally{clearTimeout(timer)}}
async function acquire(name,target,token){check(token);assert(count(name)>=target,`fixture missing ${name}; no administrative supplies during goal execution`)}
const log=event=>{if(event.text)console.log(event.text)}
async function main(){
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('test bot spawn timeout')),15000);bot.once('spawn',()=>{clearTimeout(timer);resolve()});bot.once('error',error=>{clearTimeout(timer);reject(error)});bot.once('kicked',reason=>{clearTimeout(timer);reject(new Error(JSON.stringify(reason)))})})
 const movement=new Movements(bot);movement.canDig=false;movement.allowParkour=false;movement.allow1by1towers=false;bot.pathfinder.setMovements(movement)
 rcon('gamerule doMobSpawning false');rcon('gamerule doDaylightCycle false');rcon('time set day');rcon('clear LayaFoodTest')
 rcon('fill -4 63 -4 4 63 4 minecraft:dirt');rcon('fill -4 64 -4 4 64 4 minecraft:grass_block');rcon('fill -4 65 -4 4 70 4 minecraft:air')
 rcon('setblock 2 65 0 minecraft:furnace');rcon('tp LayaFoodTest 0.5 65 0.5');rcon('give LayaFoodTest minecraft:mutton 4');rcon('give LayaFoodTest minecraft:oak_planks 3');rcon('give LayaFoodTest minecraft:stone_pickaxe 1');await sleep(800)
 for(let attempt=0;attempt<4&&bot.food>=18;attempt++){rcon('effect give LayaFoodTest minecraft:hunger 1 255 true');await sleep(1400)}
 assert(bot.food<18,`hunger fixture did not take effect: ${bot.food}`);assert(bot.health>=8)
 const initialFood=bot.food,calls=[]
 const skills=createSurvivalSkills(bot,{check,near,acquire,planks:(target,token)=>acquire('oak_planks',target,token),sleep,log})
 const trackedSkills={...skills,cook:async token=>{calls.push('cook');await skills.cook(token)},eat:async token=>{calls.push('eat');await skills.eat(token)}}
 const decisions=[],foodPolicy=createSurvivalPolicy({experienceFile:path.join(temp,'experiences.jsonl'),log:event=>{if(event.type==='policy_decision')decisions.push(event);return 'food-live-'+decisions.length}})
 const request='stone_pickaxe',mission=createMissions(bot,{foodPolicy,check,token:()=>generation,isBusy:()=>false,run:fn=>fn(),skills:trackedSkills,acquire:async(...args)=>{calls.push('goal');await acquire(...args)},world:{farmStatus:()=>({farms:[]})},campaign:{snapshot:()=>({stages:[]})},structures:{},explore:async()=>assert.fail('fixture should cook its existing raw food'),log},path.join(temp,'mission.json'))
 await mission.start(request);await mission.tick()
 assert.equal(calls[0],'cook');assert.equal(count('mutton'),0);assert.equal(count('cooked_mutton'),4);assert.equal(mission.view().index,0);assert.equal(mission.view().failures,0);assert.equal(mission.view().request,request);assert(!bot.currentWindow)
 console.log('PASS live raw mutton -> furnace with wood fuel -> cooked mutton',initialFood)
 for(let step=0;step<5;step++){await sleep(2100);if(bot.food>=18)break;await mission.tick();assert.equal(mission.view().index,0,'the original goal must wait until after eating');assert.equal(mission.view().failures,0)}
 assert(bot.food>=18,`did not eat enough: ${bot.food}`);assert(calls.includes('eat'));assert(count('cooked_mutton')<4);assert.equal(mission.view().request,request)
 await sleep(2100);await mission.tick();assert.equal(calls.at(-1),'goal');assert.equal(mission.view().phase,'목표 완료');assert.equal(mission.view().index,1)
 console.log('PASS live eating raises hunger and resumes the preserved goal',bot.food)
 assert(decisions.some(d=>d.action==='cook'&&d.source==='laya'));assert(decisions.some(d=>d.action==='eat'&&d.source==='laya'));assert(decisions.every(d=>d.source==='laya'))
 const experiences=fs.readFileSync(path.join(temp,'experiences.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert(experiences.every(e=>!e.trainingEligible&&Number.isFinite(e.reward)&&Number.isFinite(e.elapsed_ms)));assert(experiences.some(e=>e.after.hunger>e.observation.hunger));assert(experiences.some(e=>e.action==='cook'&&e.after.safe>e.observation.safe))
 fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/food-policy-live.json',JSON.stringify({decisions,experiences,scope:'Isolated validation world with supplied ingredients; actual trained Laya chose cooking and eating.'},null,2));console.log('PASS trained Laya selects cook/eat; transitions and provisional rewards recorded without automatic correct labels')
}
main().then(()=>console.log('FOOD LIVE PASS')).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{bot.quit();setTimeout(()=>{fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0)},500)})
