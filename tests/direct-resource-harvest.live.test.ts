import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BotInputSchema,RulesSchema} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(s:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',s],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

test('a real reachable log is harvested with an empty inventory and exhausted search, without another movement or supplied item',{timeout:45000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const p=new Vec3(27010,80,27010),target=p.offset(0,2,0);
 // An overhead branch drops into the actor's cell, so random horizontal drop
 // offsets cannot turn this no-movement assertion into a pickup-route test.
 rcon('forceload add 27000 27000 27025 27025');rcon('fill 27000 79 27000 27025 85 27025 air');rcon('fill 27000 79 27000 27025 79 27025 grass_block');rcon('setblock 27010 82 27010 oak_log');rcon('setblock 27010 84 27010 oak_leaves[persistent=true]');rcon('execute positioned 27010 80 27010 run kill @e[type=!player,distance=..40]');
 const b=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',auth:'offline',username:'LayaDirectMine'});b.loadPlugin(pathfinder);
 try{
  await once(b,'spawn');rcon('tp LayaDirectMine 27010.64 80 27010.5');rcon('clear LayaDirectMine');
  for(let i=0;i<160&&(b.entity.position.distanceTo(p.offset(.64,0,.5))>.05||b.entity.onGround!==true||!b.blockAt(target));i++)await sleep(50);
  const m=new Movements(b);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.scafoldingBlocks=[];b.pathfinder.setMovements(m);
  const {id:_id,...config}=BotInputSchema.parse({name:'LayaDirectMine'}),rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),e=new MineflayerExecutor(b,{config,rules,world:rules.world,dimension:()=>'overworld'});
  const budget={origin:{x:26900,y:80,z:27010},visited:[],failed:[],probes:[],sourceSnapshot:[],destinationsUsed:5,approachesUsed:8,elapsedMs:60000,status:'exhausted',reason:'previous route allowance spent'},s=e.services(AbortSignal.timeout(20000),{resourceRecovery:{oak_log:budget}}),origin=b.entity.position.clone();
  let atBreak:unknown;b.on('blockUpdate',(_old,next)=>{if(next?.position.equals(target)&&next.name==='air')atBreak=structuredClone((s.checkpoint.resourceRecovery as any).oak_log);});
  const near=s.near;s.near=async(q,radius)=>{assert.ok(b.entity.position.distanceTo(new Vec3(q.x,q.y,q.z))<=(radius??2)+.5,'direct harvest must not walk to a new source');await near(q,radius);};
  await e.ensureItem('oak_log',1,s);
  assert.equal(e.count('oak_log'),1);assert.equal(b.blockAt(target)?.name,'air');assert.ok(b.entity.position.distanceTo(origin)<.1);
  assert.ok(atBreak);assert.equal((atBreak as any).destinationsUsed,5);assert.equal((atBreak as any).approachesUsed,8);assert.equal((atBreak as any).elapsedMs,60000);
  console.log('Actual direct harvest',JSON.stringify({itemsGiven:false,harvested:e.count('oak_log'),positionUnchanged:b.entity.position.distanceTo(origin)<.1,budgetsAtBreak:atBreak,productionWorld:false}));
 }finally{b.quit('direct resource validation finished');await sleep(150);rcon('forceload remove 27000 27000 27025 27025');}
});

test('a real pathfinding offset settles within its dry ledge cell before mining stone with the already spent allowance',{timeout:60000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const p=new Vec3(27110,80,27110),ledge=new Vec3(27120,80,27120),target=ledge.offset(1,-1,0);
 rcon('forceload add 27100 27100 27135 27135');rcon('fill 27100 79 27100 27135 85 27135 air');rcon('fill 27100 78 27100 27135 78 27135 stone');rcon('fill 27100 79 27100 27135 79 27135 grass_block');
 for(const z of [27110,27111,27112]){rcon(`setblock 27111 80 ${z} oak_log`);rcon(`setblock 27111 83 ${z} oak_leaves[persistent=true]`);}
 rcon('setblock 27121 79 27120 stone');rcon('setblock 27120 79 27119 air');rcon('execute positioned 27120 80 27120 run kill @e[type=!player,distance=..40]');
 const b=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',auth:'offline',username:'LayaDirectStone'});b.loadPlugin(pathfinder);
 try{
  await once(b,'spawn');rcon('tp LayaDirectStone 27110.5 80 27110.5');rcon('clear LayaDirectStone');
  for(let i=0;i<160&&(b.entity.position.distanceTo(p.offset(.5,0,.5))>.05||b.entity.onGround!==true||!b.blockAt(target));i++)await sleep(50);
  const m=new Movements(b);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.scafoldingBlocks=[];b.pathfinder.setMovements(m);
  const {id:_id,...config}=BotInputSchema.parse({name:'LayaDirectStone'}),rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),e=new MineflayerExecutor(b,{config,rules,world:rules.world,dimension:()=>'overworld'});
  await e.ensureItem('oak_log',3,e.services(AbortSignal.timeout(20000)));await e.ensureItem('wooden_pickaxe',1,e.services(AbortSignal.timeout(20000)));assert.equal(e.count('wooden_pickaxe'),1);
  rcon('tp LayaDirectStone 27120.225 80 27120.5');
  for(let i=0;i<100&&(Math.abs(b.entity.position.x-27120.225)>.05||b.entity.onGround!==true);i++)await sleep(50);
  const before=b.entity.position.clone(),budget={origin:{x:27000,y:80,z:27120},visited:[],failed:[],probes:[],destinationsUsed:5,approachesUsed:8,elapsedMs:60000,status:'exhausted',reason:'previous route allowance spent'},s=e.services(AbortSignal.timeout(20000),{resourceRecovery:{cobblestone:budget}});
  let atBreak:any;b.on('blockUpdate',(_old,next)=>{if(next?.position.equals(target)&&next.name==='air')atBreak={budget:structuredClone((s.checkpoint.resourceRecovery as any).cobblestone),position:b.entity.position.clone()};});
  await e.ensureItem('cobblestone',1,s);
  assert.equal(e.count('cobblestone'),1);assert.ok(atBreak);assert.equal(atBreak.budget.destinationsUsed,5);assert.equal(atBreak.budget.approachesUsed,8);assert.equal(atBreak.budget.elapsedMs,60000);
  assert.ok(atBreak.position.floored().equals(ledge));assert.ok(atBreak.position.distanceTo(before)<.5);assert.ok(b.entity.position.distanceTo(before)<2);assert.equal(b.blockAt(ledge.offset(0,-1,0))?.name,'grass_block');
  console.log('Actual offset ledge harvest',JSON.stringify({itemsGiven:false,toolCraftedFromHarvestedWood:true,harvested:e.count('cobblestone'),center:s.checkpoint.footprintCenter,budgetsAtBreak:atBreak,productionWorld:false}));
 }finally{b.quit('offset ledge validation finished');await sleep(150);rcon('forceload remove 27100 27100 27135 27135');}
});
