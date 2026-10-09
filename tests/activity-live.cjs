// Disposable server only. All materials/terrain fixtures are prepared between
// goals; the goal executor never receives administrative materials during play.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process')
const mineflayer=require('mineflayer'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder'),{Vec3}=require('vec3')
const {createActivityPolicy}=require('../activity-policy'),{createSurvivalPolicy}=require('../survival-policy'),{createMissions}=require('../missions'),{createFarming}=require('../farming'),{createStructures,requirements}=require('../structures'),{createCollector}=require('../resource-collector'),{createExplorer}=require('../exploration'),{createSurvivalSkills}=require('../survival-skills'),{createCrafting}=require('../crafting')
const PORT=Number(process.env.MC_TEST_PORT||25566);assert.equal(PORT,25566,'Never run activity fixtures against the user server')
const rcon=command=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8',timeout:10000}),sleep=ms=>new Promise(r=>setTimeout(r,ms))
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-activity-live-')),events=[],cases=[];let generation=0
const log=e=>{events.push(e);if(e.text)console.log(e.text);if(e.type==='activity_decision')console.log('Laya decision:',e.observation.domain,e.action,e.source,Number(e.confidence).toFixed(3));return 'live-'+events.length}
const bot=mineflayer.createBot({host:'127.0.0.1',port:PORT,version:'1.21.1',username:'LayaActivityTest',auth:'offline'});bot.loadPlugin(pathfinder)
const check=t=>assert.equal(t,generation,'cancelled'),count=name=>bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
async function near(p,range,t){check(t);const timer=setTimeout(()=>bot.pathfinder.setGoal(null),12000);try{await bot.pathfinder.goto(new goals.GoalNear(p.x,p.y,p.z,range));check(t)}finally{clearTimeout(timer)}}
const crafting=createCrafting(bot,{check,sleep})
async function acquire(name,target,t){
 check(t);if(count(name)>=target)return
 assert(['stone_hoe','stone_sword'].includes(name),`No administrative acquisition while executing a goal: ${name} ${count(name)}/${target}`)
 const table=bot.findBlock({matching:b=>b.name==='crafting_table',maxDistance:24});assert(table);await near(table.position,2,t);await crafting.craft(name,1,table,t);assert(count(name)>=target)
}
async function supplies(entries){for(const [name,target]of Object.entries(entries)){if(count(name)<target)rcon(`give LayaActivityTest minecraft:${name} ${target-count(name)}`)}await sleep(400)}
async function main(){
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('spawn timeout')),15000);bot.once('spawn',()=>{clearTimeout(timer);resolve()});bot.once('error',reject)})
 const movement=new Movements(bot);movement.canDig=false;movement.allowParkour=false;movement.allow1by1towers=false;movement.maxDropDown=3;bot.pathfinder.setMovements(movement);bot.pathfinder.searchRadius=45
 rcon('gamerule doMobSpawning false');rcon('gamerule doDaylightCycle false');rcon('time set day');rcon('kill @e[type=!minecraft:player]');rcon('clear LayaActivityTest')
 rcon('fill -24 65 -24 0 80 24 minecraft:air');rcon('fill 1 65 -24 24 80 24 minecraft:air');rcon('fill -24 63 -24 24 63 24 minecraft:dirt');rcon('fill -24 64 -24 24 64 24 minecraft:grass_block');rcon('tp LayaActivityTest 0.5 65 0.5');rcon('setblock 1 64 1 minecraft:water');rcon('setblock 0 65 3 minecraft:crafting_table');await sleep(700)
 await supplies({wheat_seeds:64,cobblestone:64,stick:4,cooked_beef:16})
 const farming=createFarming(bot,{check,near,acquire,sleep,log},path.join(temp,'farms.json')),world={farmStatus:farming.status,farm:farming.work}
 const skills=createSurvivalSkills(bot,{check,near,acquire,sleep,log}),structures=createStructures(bot,{check,near,acquire,planks:(n,t)=>acquire('oak_planks',n,t),sleep,log},path.join(temp,'structures.json'))
 const collector=createCollector(bot,{check,near,sleep,log}),explorer=createExplorer(bot,{check,near,log},path.join(temp,'exploration.json'))
 const activityPolicy=createActivityPolicy({log,experienceFile:path.join(temp,'activity.jsonl')}),foodPolicy=createSurvivalPolicy({log,experienceFile:path.join(temp,'food.jsonl')})
 const mission=createMissions(bot,{activityPolicy,foodPolicy,check,token:()=>generation,isBusy:()=>false,run:fn=>fn(),acquire,skills,world,structures,collector,explorer,explore:explorer.explore,planks:(n,t)=>acquire('oak_planks',n,t),campaign:{snapshot:()=>({stages:[]})},sleep,log},path.join(temp,'mission.json'))
 async function goal(request,max=30){
  const start=events.length;await mission.start(request)
  for(let i=0;i<max&&mission.view().enabled;i++){await mission.tick();await sleep(2100)}
  const status=mission.view();assert.equal(status.phase,'목표 완료',`${request}: ${status.phase} / ${status.lastResult}`)
  const decisions=events.slice(start).filter(e=>e.type==='activity_decision');assert(decisions.some(e=>e.source==='laya'),'goal must use the actual trained Laya')
  cases.push({request,decisions,complete:true});return decisions
 }
 const farmDecisions=await goal('밀 농사 지어줘',8);assert(farmDecisions.some(e=>e.action==='gather'));assert(farmDecisions.some(e=>e.action==='farm'&&e.source==='laya'));assert(count('stone_hoe')>0);assert(farming.status().farms[0].complete);console.log('PASS learned farm preparation -> actual hoe crafting -> 24-plot planting')
 await mission.start('밀 농장 계속 관리해줘');await mission.tick();await sleep(2100);await mission.tick();assert(mission.view().enabled);assert(mission.view().nextTickAt>Date.now());assert(events.some(e=>e.type==='activity_decision'&&e.action==='wait'&&e.source==='laya'));mission.stop();console.log('PASS learned growth waiting retains continuous farm goal')
 const field=JSON.parse(fs.readFileSync(path.join(temp,'farms.json'))).farms[0];for(const p of field.plots)rcon(`setblock ${p.x} ${p.y+1} ${p.z} minecraft:wheat[age=7]`);await sleep(800)
 const harvested=await goal('밀 1개 수확해줘',5);assert(harvested.some(e=>e.action==='farm'&&e.source==='laya'));assert(farming.status().farms[0].harvested>0);console.log('PASS learned mature harvest -> real pickup and replant -> quantity completion')
 await supplies({...requirements('cabin','oak'),cobblestone:64});rcon('tp LayaActivityTest 14.5 65 0.5');await sleep(500)
 const building=await goal('작은 집 지어줘',28);assert(building.some(e=>e.action==='survey'&&e.source==='laya'));assert(building.some(e=>e.action==='build'&&e.source==='laya'));assert(structures.status('cabin').complete);console.log('PASS learned site survey -> real furnished cabin completion')
 rcon('tp LayaActivityTest -14.5 65 -14.5');await supplies({iron_sword:1,shield:1,iron_helmet:1,iron_chestplate:1,iron_leggings:1,iron_boots:1});rcon('summon minecraft:husk -11.5 65 -14.5 {PersistenceRequired:1b}');await sleep(500)
 const combat=await goal('몬스터 1마리 잡아줘',5);assert(combat.some(e=>e.action==='fight'&&e.source==='laya'));assert(skills.combatStatus().kills>0);console.log('PASS learned fight selection -> server-confirmed husk death')
 const logs=count('oak_log');for(let x=-13;x<=-10;x++)rcon(`setblock ${x} 65 -10 minecraft:oak_log`);await sleep(500)
 const collected=await goal(`나무 ${logs+4}개 채집해줘`,5);assert(collected.some(e=>e.action==='collect'&&e.source==='laya'));assert(count('oak_log')>=logs+4);console.log('PASS learned resource collection -> real inventory increase')
 rcon('tp LayaActivityTest -14.5 65 20.5');rcon('fill 25 63 14 48 63 24 minecraft:dirt');rcon('fill 25 64 14 48 64 24 minecraft:grass_block');rcon('setblock 43 65 20 minecraft:iron_ore');await sleep(700)
 const searched=await goal('철광석 찾아줘',14);assert(searched.some(e=>e.action==='search'&&e.source==='laya'));assert(explorer.status().visited>0);assert(bot.findBlocks({matching:b=>b.name==='iron_ore',maxDistance:48,count:1}).length);console.log('PASS learned exploration -> actual movement and observed iron coordinates')
 const transitions=events.filter(e=>e.type==='activity_outcome');assert(transitions.every(e=>!e.trainingEligible&&Number.isFinite(e.elapsed_ms)));assert(transitions.some(e=>e.after.built>e.observation.built));assert(transitions.some(e=>e.after.harvested>e.observation.harvested));assert(transitions.some(e=>e.after.have>e.observation.have))
 fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/activity-policy-live.json',JSON.stringify({scope:'Port 25566 disposable world; supplied materials/terrain. Learned action selection and actual skill execution, not autonomous acquisition of all prerequisites.',cases,transitions},null,2));console.log('ACTIVITY LIVE PASS')
}
main().catch(error=>{console.error(error);fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/activity-policy-live-failure.json',JSON.stringify({error:error.message,events},null,2));process.exitCode=1}).finally(()=>{bot.quit();setTimeout(()=>{fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0)},500)})
