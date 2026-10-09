const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process')
const mineflayer=require('mineflayer'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder')
const {createActivityPolicy}=require('../activity-policy'),{createActivityManager}=require('../activity-manager'),{createSurvivalSkills}=require('../survival-skills')
const port=Number(process.env.MC_TEST_PORT||25566);assert.equal(port,25566)
const rcon=cmd=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',cmd],{encoding:'utf8',timeout:10000}),sleep=ms=>new Promise(r=>setTimeout(r,ms)),temp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-activity-safety-')),events=[]
const bot=mineflayer.createBot({host:'127.0.0.1',port,version:'1.21.1',username:'LayaSafetyTest',auth:'offline'});bot.loadPlugin(pathfinder)
const check=t=>assert.equal(t,0),near=async(p,range,t)=>{check(t);const timer=setTimeout(()=>bot.pathfinder.setGoal(null),10000);try{await bot.pathfinder.goto(new goals.GoalNear(p.x,p.y,p.z,range))}finally{clearTimeout(timer)}}
async function main(){
 await new Promise((resolve,reject)=>{bot.once('spawn',resolve);bot.once('error',reject)})
 const movement=new Movements(bot);movement.canDig=false;movement.allowParkour=false;bot.pathfinder.setMovements(movement)
 rcon('fill -24 65 -24 -4 70 -4 minecraft:air');rcon('fill -24 64 -24 -4 64 -4 minecraft:grass_block');rcon('clear LayaSafetyTest');rcon('tp LayaSafetyTest -14.5 65 -14.5');rcon('summon minecraft:creeper -8.5 65 -14.5 {NoAI:1b,PersistenceRequired:1b}');await sleep(700)
 const enemy=Object.values(bot.entities).find(e=>e.name==='creeper');assert(enemy);const before=bot.entity.position.distanceTo(enemy.position)
 const skills=createSurvivalSkills(bot,{check,near,sleep}),policy=createActivityPolicy({log:e=>{events.push(e);return 'safety-'+events.length},experienceFile:path.join(temp,'experiences.jsonl')})
 const manager=createActivityManager(bot,{policy,check,skills,world:{farmStatus:()=>({farms:[]})},structures:{},execute:async()=>assert.fail('Unsafe combat must retreat before fighting'),sleep})
 await manager.step({type:'fight',mode:'continuous',quantity:1},0)
 const after=bot.entity.position.distanceTo(enemy.position);assert(after>before+2);assert(events.some(e=>e.type==='activity_decision'&&e.action==='retreat'&&e.source==='laya'));assert(skills.combatStatus().retreats>0)
 fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/activity-safety-live.json',JSON.stringify({scope:'Isolated port 25566, NoAI creeper fixture; learned retreat and actual public path movement',beforeDistance:before,afterDistance:after,events},null,2));console.log('PASS trained Laya selects retreat from close creeper without a bow; actual safe-distance movement')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{bot.quit();setTimeout(()=>{fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0)},500)})
