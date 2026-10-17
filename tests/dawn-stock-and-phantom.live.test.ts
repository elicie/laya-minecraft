import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {WorkerLaunchSchema,type WorkerMessage} from '../packages/contracts/src';
import {blueprint} from '../packages/contracts/src/blueprints';
import {warehouseShelter} from '../packages/core/src/warehouse-shelter';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MinecraftWorker} from '../packages/minecraft/src/worker';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
function verifyLab(){assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');}

test('designated idle producer refreshes an actually occluded closed-door warehouse without an operator goal',{timeout:45000},async()=>{
 verifyLab();const origin={x:28405,y:80,z:28405},blocks=blueprint('warehouse',origin),world='127.0.0.1:25566',container={id:'dawn-stock',world,dimension:'overworld',position:{x:28406,y:81,z:28406}},base=warehouseShelter(container,blocks)!;
 const oldCycle=rcon('gamerule doDaylightCycle').includes('true');
 rcon('forceload add 28400 28400 28425 28425');rcon('fill 28400 79 28400 28425 87 28425 air');rcon('fill 28400 79 28400 28425 79 28425 grass_block');
 for(const b of blocks.filter(b=>!b.name.endsWith('_door')&&b.name!=='wall_torch'))rcon(`setblock ${b.position.x} ${b.position.y} ${b.position.z} ${b.name}`);
 for(const half of ['lower','upper'])rcon(`setblock ${base.door.x} ${base.door.y+(half==='upper'?1:0)} ${base.door.z} oak_door[facing=south,half=${half},open=false]`);
 for(const b of blocks.filter(b=>b.name==='wall_torch'))rcon(`setblock ${b.position.x} ${b.position.y} ${b.position.z} wall_torch[facing=${b.position.x===28406?'east':'west'}]`);
 rcon('gamerule doDaylightCycle false');rcon('time set 1000');rcon('execute positioned 28410 80 28410 run kill @e[type=!player,distance=..30]');rcon(`item replace block ${container.position.x} ${container.position.y} ${container.position.z} container.0 with bread 8`);
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',auth:'offline',username:'LayaDawnStock'});bot.loadPlugin(pathfinder);
 const messages:WorkerMessage[]=[],launch=WorkerLaunchSchema.parse({botId:'producer-live',sessionId:'dawn-session',controllerEpoch:'dawn-epoch',config:{name:'LayaDawnStock',connection:{host:'127.0.0.1',port:25566,version:'1.21.1',auth:'offline'}},rules:{world,warehouse:container,baseShelter:base,baseAutonomy:{id:'dawn-farm',origin:{x:28420,y:79,z:28420},positions:[{x:28421,y:79,z:28420}],botId:'producer-live'}}}),worker=new MinecraftWorker(launch,bot,m=>messages.push(m),{timers:false});
 try{
  await once(bot,'spawn');rcon(`tp LayaDawnStock ${base.outside.x+.5} ${base.outside.y} ${base.outside.z+.5}`);rcon('clear LayaDawnStock');
  for(let i=0;i<160&&(!messages.some(m=>m.type==='bot.ready')||bot.entity.onGround!==true||bot.entity.position.distanceTo(new Vec3(base.outside.x+.5,base.outside.y,base.outside.z+.5))>.1);i++)await sleep(50);
  assert.equal(worker.executor.canObserveContainerHere(container),false,'the closed building really occludes the chest');
  worker.pollSafety();
  for(let i=0;i<400&&!messages.some(m=>m.type==='world.observed'&&m.payload.observations.some(o=>o.kind==='container'));i++)await sleep(50);
  const actual=messages.flatMap(m=>m.type==='world.observed'?m.payload.observations:[]).find(o=>o.kind==='container');assert.ok(actual?.kind==='container',JSON.stringify(messages.filter(m=>m.type==='bot.error'||m.type==='bot.status').slice(-3)));
  assert.equal(actual.data.items.find(i=>i.name==='bread')?.count,8);assert.equal(bot.blockAt(new Vec3(base.door.x,base.door.y,base.door.z))!.getProperties().open,false);assert.equal(Math.floor(bot.entity.position.y),base.inside.y);assert.equal(messages.some(m=>m.type==='task.accepted'),false);assert.ok(blocks.every(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name===b.name));
  console.log('Actual dawn stock refresh',JSON.stringify({closedChestInitiallyOccluded:true,actualBread:8,doorClosed:true,operatorGoal:false,buildingUnchanged:true,fixtureBread:true,productionWorld:false}));
 }finally{await worker.shutdown('dawn stock validation complete');await sleep(150);rcon('forceload remove 28400 28400 28425 28425');rcon(`gamerule doDaylightCycle ${oldCycle}`);}
});

test('real airborne phantom defense does not pathfind toward flying coordinates and cancels cleanly',{timeout:30000},async()=>{
 verifyLab();const oldCycle=rcon('gamerule doDaylightCycle').includes('true');rcon('forceload add 28500 28500 28525 28525');rcon('fill 28500 79 28500 28525 88 28525 air');rcon('fill 28500 79 28500 28525 79 28525 grass_block');rcon('gamerule doDaylightCycle false');rcon('time set 13000');rcon('execute positioned 28510 80 28510 run kill @e[type=!player,distance=..30]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',auth:'offline',username:'LayaPhantomHold'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('tp LayaPhantomHold 28510.5 80 28510.5');rcon('clear LayaPhantomHold');rcon('give LayaPhantomHold wooden_sword 1');rcon('summon phantom 28518 86 28510 {NoAI:1b,PersistenceRequired:1b,Tags:["laya_hold_fixture"]}');
  for(let i=0;i<160&&(bot.entity.onGround!==true||!bot.inventory.items().some(i=>i.name==='wooden_sword')||!Object.values(bot.entities).some(e=>e.name==='phantom'));i++)await sleep(50);
  const move=new Movements(bot);move.canDig=false;move.allow1by1towers=false;bot.pathfinder.setMovements(move);
  const launch=WorkerLaunchSchema.parse({botId:'phantom-live',sessionId:'p',controllerEpoch:'e',config:{name:'LayaPhantomHold',role:'guard'},rules:{world:'127.0.0.1:25566'}}),executor=new MineflayerExecutor(bot,{config:launch.config,rules:launch.rules,world:launch.rules.world,dimension:()=>'overworld'}),target=Object.values(bot.entities).find(e=>e.name==='phantom')!;
  const initial=bot.entity.position.clone(),s=executor.services(AbortSignal.timeout(1800));let defended=false;s.progress=a=>{if(a==='공중 위협 방어')defended=true;};
  await assert.rejects(executor.fightEntity(target,s));assert.equal(defended,true);assert.ok(bot.entity.position.distanceTo(initial)<.1);assert.equal(bot.health,20);assert.equal(executor.fighting,false);assert.equal(bot.pathfinder.isMoving(),false);
  console.log('Actual phantom ground defense',JSON.stringify({actualPhantom:true,positionRetained:true,health:20,cancellationFenced:true,fixtureSwordAndPhantom:true,productionWorld:false}));
 }finally{bot.quit('phantom hold validation complete');await sleep(150);rcon('kill @e[tag=laya_hold_fixture]');rcon('forceload remove 28500 28500 28525 28525');rcon(`gamerule doDaylightCycle ${oldCycle}`);}
});
