import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder} from 'mineflayer-pathfinder';
import {WorkerLaunchSchema,type WorkerMessage} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MinecraftWorker} from '../packages/minecraft/src/worker';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate:()=>boolean,ms=10000){const until=Date.now()+ms;while(!predicate()&&Date.now()<until)await sleep(50);assert.ok(predicate(),'actual validation state did not arrive');}
test('an actual axe-equipped worker retreats from an approaching creeper before any blast or first hit',{timeout:60000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 rcon('forceload add 7600 7672 7808 7736');
 for(let x=7600;x<=7808;x+=32){rcon(`fill ${x} 80 7672 ${Math.min(7808,x+31)} 88 7736 air`);rcon(`fill ${x} 77 7672 ${Math.min(7808,x+31)} 79 7736 stone`);}
 rcon('kill @e[type=!player,x=7600,y=77,z=7672,dx=208,dy=12,dz=64]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaCreeperCheck',auth:'offline'});bot.loadPlugin(pathfinder);
 const launch=WorkerLaunchSchema.parse({botId:'creeper-check',sessionId:'actual-session',controllerEpoch:'actual-epoch',config:{name:'LayaCreeperCheck',connection:{host:'127.0.0.1',port:25566,version:'1.21.1'}},rules:{world:'127.0.0.1:25566',autonomyEnabled:false}}),messages:WorkerMessage[]=[];
 const worker=new MinecraftWorker(launch,bot,message=>messages.push(message),{timers:false}),tag=`laya_creeper_${process.pid}`;
 try{
  await once(bot,'spawn');rcon('gamemode survival LayaCreeperCheck');rcon('tp LayaCreeperCheck 7704.5 80 7704.5');rcon('clear LayaCreeperCheck');rcon('give LayaCreeperCheck wooden_axe 1');rcon('effect give LayaCreeperCheck minecraft:instant_health 1 10 true');rcon('effect give LayaCreeperCheck minecraft:saturation 1 10 true');
  await waitFor(()=>bot.health===20&&bot.food===20&&bot.entity.position.distanceTo(new Vec3(7704.5,80,7704.5))<.1&&bot.inventory.items().some(i=>i.name==='wooden_axe'));
  rcon(`summon creeper 7714.5 80 7704.5 {Tags:["${tag}"],PersistenceRequired:1b,Silent:1b,Invulnerable:1b}`);
  await waitFor(()=>Object.values(bot.entities).some(e=>e.name==='creeper'&&e.position.distanceTo(bot.entity.position)<12));
  const start=bot.entity.position.clone(),since=messages.length;worker.pollSafety();
  await waitFor(()=>messages.slice(since).some(m=>m.type==='safety.alert'&&m.payload.response==='retreat'),3000);
  await waitFor(()=>messages.slice(since).some(m=>m.type==='bot.status'&&m.payload.mode==='idle'&&m.payload.position&&Math.hypot(m.payload.position.x-start.x,m.payload.position.z-start.z)>24),30000);
  const serverPosition=(name:string)=>{const raw=rcon(`data get entity ${name} Pos`),match=raw.match(/\[(-?\d+(?:\.\d+)?)[dD]?,\s*(-?\d+(?:\.\d+)?)[dD]?,\s*(-?\d+(?:\.\d+)?)[dD]?\]/);assert.ok(match,raw);return new Vec3(Number(match[1]),Number(match[2]),Number(match[3]));};
  const actual=serverPosition('LayaCreeperCheck'),enemy=serverPosition(`@e[type=creeper,tag=${tag},limit=1]`);
  assert.ok(actual.distanceTo(enemy)>=32);assert.equal(bot.health,20);assert.equal(bot.inventory.items().find(i=>i.name==='wooden_axe')?.count,1);assert.equal(messages.some(m=>m.type==='bot.died'),false);
  assert.match(rcon('execute if block 7704 79 7704 stone'),/Test passed/);
  console.log('Actual armed pre-hit creeper escape',JSON.stringify({start,actual,enemy,distance:actual.distanceTo(enemy),health:bot.health,axeProvided:true,creeperAlive:true,noBlast:true}));
 }finally{await worker.shutdown();await sleep(200);rcon(`kill @e[type=creeper,tag=${tag}]`);rcon('forceload remove 7600 7672 7808 7736');}
});
