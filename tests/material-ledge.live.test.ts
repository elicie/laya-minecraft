import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { BotInputSchema, RulesSchema } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { beginResourceTrip, resourceTrip, returnFromResourceTrip } from '../packages/minecraft/src/resource-trip';
import { safeResourceRoute } from '../packages/minecraft/src/resource-recovery';
import { ConditionWait } from '../packages/minecraft/src/services';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('material collection mines an exposed ledge block from real support, then returns without mining the walking floor',{timeout:100000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 rcon('forceload add 8700 8700 8740 8712');rcon('fill 8700 76 8700 8740 85 8712 air');rcon('fill 8700 76 8700 8709 78 8712 dirt');rcon('fill 8700 79 8700 8709 79 8712 grass_block');rcon('fill 8710 79 8706 8730 79 8706 andesite');rcon('setblock 8724 80 8706 stone');
 rcon('fill 8703 82 8705 8705 82 8707 oak_planks');
 rcon('fill 8722 79 8705 8726 79 8707 andesite');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaLedgeMine',auth:'offline'});bot.loadPlugin(pathfinder);
 const previousDaylightCycle=/\btrue\b/.test(rcon('gamerule doDaylightCycle'));
 try{
  await once(bot,'spawn');rcon('tp LayaLedgeMine 8706.5 80 8706.5');rcon('clear LayaLedgeMine');rcon('give LayaLedgeMine wooden_pickaxe 1');
  const ready=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(8706.5,80,8706.5))>1||!bot.inventory.items().some(i=>i.name==='wooden_pickaxe')||!bot.blockAt(new Vec3(8724,80,8706)))&&Date.now()<ready)await sleep(50);
  const moves=new Movements(bot);moves.canDig=false;moves.allow1by1towers=false;moves.allowParkour=false;moves.maxDropDown=2;moves.infiniteLiquidDropdownDistance=false;moves.scafoldingBlocks=[];bot.pathfinder.setMovements(moves);
  let lastProgress='';const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaLedgeMine'}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld',onProgress(action,reason){if(lastProgress!==action+reason){lastProgress=action+reason;console.log('Actual material progress',JSON.stringify({action,reason,position:bot.entity.position,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count}))}));}}});
  const s=executor.services(AbortSignal.timeout(85000),{materialExpedition:true,resourceExpedition:true,confirmedRecoveryDeathId:'actual-life'});await beginResourceTrip(s,'cobblestone',1);
  rcon('gamerule doDaylightCycle true');rcon('time set 18000');const nightUntil=Date.now()+5000;while((bot.time.isDay!==false||bot.time.doDaylightCycle!==true)&&Date.now()<nightUntil)await sleep(50);
  assert.equal(bot.time.isDay,false);await assert.rejects(s.ensureItem('cobblestone',1),error=>error instanceof ConditionWait&&(error.checkpoint.waitingFor as {watchDaylight:boolean}).watchDaylight===true);assert.equal(executor.count('cobblestone'),0);assert.equal(resourceTrip(s.checkpoint)?.phase,'complete');assert.equal(bot.blockAt(new Vec3(8724,80,8706))?.name,'stone');
  assert.ok(s.checkpoint.nightShelter,'night waiting must use actually reached existing cover');assert.ok(bot.entity.position.distanceTo(new Vec3(8704.5,80,8706.5))<1.5);
  rcon('time set 1000');const dayUntil=Date.now()+5000;while(!bot.time.isDay&&Date.now()<dayUntil)await sleep(50);assert.equal(bot.time.isDay,true);
  rcon('execute positioned 8720 80 8706 run kill @e[type=!player,distance=..64]');
  await s.near({x:8706.5,y:80,z:8706.5},0);
  assert.equal(safeResourceRoute(bot,{x:8722,y:80,z:8706}),undefined);await s.ensureItem('cobblestone',1);assert.equal(executor.count('cobblestone'),1);assert.equal(bot.blockAt(new Vec3(8724,80,8706))?.name,'air');
  assert.equal(resourceTrip(s.checkpoint)?.phase,'complete');assert.ok(bot.entity.position.distanceTo(new Vec3(8706.5,80,8706.5))<1.5);
  assert.match(rcon('execute if block 8724 79 8706 andesite'),/Test passed/);assert.match(rcon('execute if block 8715 78 8706 air'),/Test passed/);assert.equal(executor.count('wooden_pickaxe'),1);
  console.log('Actual ledge stone collection verified',JSON.stringify({actual:bot.entity.position,cobblestone:executor.count('cobblestone'),toolProvided:true,buildingMaterialsGiven:false,floorIntact:true}));
  rcon('setblock 8726 80 8706 stone');await sleep(150);
  const returned=executor.services(AbortSignal.timeout(40000),{confirmedRecoveryDeathId:'actual-life'});
  const supplied=await executor.execute({id:'actual-returned-material',goalId:'ledge-supply',kind:'collect',params:{item:'cobblestone',quantity:2,returnTo:{x:8706,y:80,z:8706}},completion:{kind:'inventory',item:'cobblestone',minimum:2},dependencies:[],reservationKeys:[]},returned);
  assert.equal(supplied.outcome,'completed');assert.equal(returned.checkpoint.materialExpedition,true);assert.equal(executor.count('cobblestone'),2);assert.equal(resourceTrip(returned.checkpoint)?.phase,'complete');assert.ok(bot.entity.position.distanceTo(new Vec3(8706.5,80,8706.5))<1.5);assert.equal(bot.blockAt(new Vec3(8726,80,8706))?.name,'air');
  console.log('Actual explicit returned collection crossed the ledge',JSON.stringify({actual:bot.entity.position,cobblestone:executor.count('cobblestone'),itemsGivenForThisCollection:false}));

  rcon('fill 8726 79 8705 8732 79 8707 andesite');rcon('setblock 8728 80 8706 stone');rcon('setblock 8730 80 8706 stone');await sleep(150);
  const late=executor.services(AbortSignal.timeout(45000),{confirmedRecoveryDeathId:'actual-life'}),normalPause=late.pause;let crossedDusk=false;
  const afterDig=(block:{name:string;position:{x:number}})=>{if(block.name==='air'&&block.position.x===8728){rcon('time set 9000');crossedDusk=true;}};
  bot.on('diggingCompleted',afterDig);late.pause=async ms=>{await normalPause(ms);if(crossedDusk){const until=Date.now()+5000;while(bot.time.timeOfDay<9000&&Date.now()<until)await sleep(50);crossedDusk=false;}};
  try{await assert.rejects(executor.execute({id:'actual-late-supply',goalId:'late-supply',kind:'collect',params:{item:'cobblestone',quantity:4,returnTo:{x:8706,y:80,z:8706}},completion:{kind:'inventory',item:'cobblestone',minimum:4},dependencies:[],reservationKeys:[]},late),error=>error instanceof ConditionWait&&(error.checkpoint.waitingFor as {watchDaylight:boolean}).watchDaylight===true);}finally{bot.removeListener('diggingCompleted',afterDig);}
  assert.equal(executor.count('cobblestone'),3);assert.equal(bot.blockAt(new Vec3(8728,80,8706))?.name,'air');assert.equal(bot.blockAt(new Vec3(8730,80,8706))?.name,'stone');assert.equal(resourceTrip(late.checkpoint)?.phase,'complete');assert.ok(bot.entity.position.distanceTo(new Vec3(8706.5,80,8706.5))<1.5);
  console.log('Actual mid-collection dusk returned carried supplies',JSON.stringify({actual:bot.entity.position,cobblestone:executor.count('cobblestone'),nextSourceUnmined:true,originalHomeReached:true}));
 }finally{bot.quit('material ledge validation finished');await sleep(250);rcon('time set 1000');rcon(`gamerule doDaylightCycle ${previousDaylightCycle}`);rcon('forceload remove 8700 8700 8740 8712');}
});
