// Isolated fixture world only. Administrative setup supplies test materials and
// matures crops; assertions check actual Mineflayer actions and server blocks.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process')
const mineflayer=require('mineflayer'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder'),{Vec3}=require('vec3')
const {createFarming}=require('../farming'),{createSurvivalSkills}=require('../survival-skills'),{createStructures,requirements}=require('../structures'),{createCollector}=require('../resource-collector'),{createExplorer}=require('../exploration')
const PORT=Number(process.env.MC_TEST_PORT||25566);assert.equal(PORT,25566,'Never run fixture setup against the user server')
const rcon=command=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8',timeout:10000})
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),temp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-advanced-'))
let generation=0
const bot=mineflayer.createBot({host:'127.0.0.1',port:PORT,version:'1.21.1',username:'LayaValidation',auth:'offline'});bot.loadPlugin(pathfinder)
function check(token){if(token!==generation)throw new Error('cancelled')}
async function near(p,range,token){check(token);const timer=setTimeout(()=>bot.pathfinder.setGoal(null),12000);try{await bot.pathfinder.goto(new goals.GoalNear(p.x,p.y,p.z,range));check(token)}finally{clearTimeout(timer)}}
async function acquire(name,target,token){check(token);const have=bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);if(have<target){rcon(`give LayaValidation minecraft:${name} ${target-have}`);await sleep(250)}check(token)}
async function planks(target,token){await acquire('oak_planks',target,token)}
const log=e=>{if(e.text)console.log(e.text)}
async function main(){await new Promise((resolve,reject)=>{bot.once('spawn',resolve);bot.once('error',reject)});const movement=new Movements(bot);movement.canDig=false;movement.allowParkour=false;movement.allow1by1towers=false;movement.maxDropDown=3;bot.pathfinder.setMovements(movement);bot.pathfinder.searchRadius=45
 rcon('gamerule doMobSpawning false');rcon('gamerule doDaylightCycle false');rcon('time set day');rcon('kill @e[type=!minecraft:player]');rcon('clear LayaValidation');rcon('fill -24 65 -24 0 80 24 minecraft:air');rcon('fill 1 65 -24 24 80 24 minecraft:air');rcon('fill -24 63 -24 24 63 24 minecraft:dirt');rcon('fill -24 64 -24 24 64 24 minecraft:grass_block');rcon('tp LayaValidation 0.5 65 0.5');await sleep(700)
 let farming
 if(process.env.MC_LIVE_START!=='build'){
 farming=createFarming(bot,{check,near,acquire,sleep,log},path.join(temp,'farms.json'))
 if(process.env.MC_LIVE_START!=='irrigation'){
 rcon('setblock 1 64 1 minecraft:water');await acquire('stone_hoe',1,0);await acquire('wheat_seeds',64,0);await sleep(300)
 const first=await farming.work(0,{crop:'wheat'});assert(first.complete);assert.equal(first.planted,first.plots);assert(first.plots>=8);console.log('PASS live hydrated soil tilling and initial planting',first.plots)
 const saved=JSON.parse(fs.readFileSync(path.join(temp,'farms.json'))).farms[0];for(const p of saved.plots)rcon(`setblock ${p.x} ${p.y+1} ${p.z} minecraft:wheat[age=7]`);await sleep(800)
 const harvest=await farming.work(0,{crop:'wheat'});assert(harvest.harvestedNow>0);assert.equal(harvest.planted,harvest.plots);assert(harvest.cycles>0);console.log('PASS live mature-only harvest, drop pickup, automatic replant',harvest.harvestedNow)
 for(const p of saved.plots.slice(0,4))assert(rcon(`execute if block ${p.x} ${p.y+1} ${p.z} minecraft:wheat[age=0] run data get entity LayaValidation Pos`).includes('entity data'))
 }
 rcon('setblock 1 64 1 minecraft:grass_block');rcon('fill 15 64 15 24 64 24 minecraft:stone');rcon('setblock 20 64 20 minecraft:water');await acquire('carrot',64,0);await sleep(300)
 const irrigated=await farming.work(0,{crop:'carrot'});assert(irrigated.complete);assert.equal(irrigated.hydrated,irrigated.plots);assert.equal(irrigated.planted,24);console.log('PASS live bucket filling, new irrigation source and carrot planting',irrigated.plots)
 if(['farm','irrigation'].includes(process.env.MC_LIVE_START)){generation++;await assert.rejects(()=>farming.work(0,{crop:'wheat'}),/cancelled/);console.log('PASS live farm cancellation before mutation');return}
 }
 rcon('tp LayaValidation 14.5 65 0.5');await sleep(500)
 const structures=createStructures(bot,{check,near,planks,log,acquire,sleep},path.join(temp,'structures.json'))
 for(const [name,n]of Object.entries(requirements('cabin','oak')))await acquire(name,n,0)
 let built;for(let i=0;i<18;i++){built=await structures.build('cabin',0);console.log('BUILD',built.phase,built.built,built.total,built.furnitureBuilt);if(built.complete)break}assert(built.complete,'furnished cabin must complete');console.log('PASS live cabin doors, glass windows, torches, bed, chest, table, furnace')
 rcon('tp LayaValidation -14.5 65 -14.5');await sleep(500);for(const name of ['iron_sword','shield','iron_helmet','iron_chestplate','iron_leggings','iron_boots'])await acquire(name,1,0)
 const skills=createSurvivalSkills(bot,{check,near,sleep,log,acquire});rcon('summon minecraft:husk -11.5 65 -14.5 {PersistenceRequired:1b}');await sleep(500);const enemy=Object.values(bot.entities).find(e=>e.name==='husk');assert(enemy);await skills.defend(0,{target:'husk'});assert.equal(skills.combatStatus().kills,1);assert(!bot.entities[enemy.id]);console.log('PASS live armored melee and server-confirmed mob death')
 const collector=createCollector(bot,{check,near,sleep,log});const before=bot.inventory.items().filter(i=>i.name==='oak_log').reduce((n,i)=>n+i.count,0);for(let x=-13;x<=-10;x++)rcon(`setblock ${x} 65 -10 minecraft:oak_log`);await sleep(500);const result=await collector.collect(['oak_log'],['oak_log'],before+4,0);assert.equal(result.collected,before+4);console.log('PASS live exact-count gathering and matching drop collection')
 const explorer=createExplorer(bot,{check,near,log},path.join(temp,'exploration.json'));await explorer.explore(0,{mode:'surface',resources:[]});assert(explorer.status().visited>0);assert(fs.existsSync(path.join(temp,'exploration.json')));console.log('PASS live exploration and persisted visited sectors')
 generation++;await assert.rejects(()=>farming?farming.work(0,{crop:'wheat'}):collector.collect(['oak_log'],['oak_log'],5,0),/cancelled/);console.log('PASS live cancellation before world mutation')
}
main().then(()=>console.log('ADVANCED LIVE PASS')).catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{bot.quit();setTimeout(()=>{fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0)},500)})
