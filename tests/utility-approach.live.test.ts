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
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('an actual material trip approaches a worktable across an intact observed ledge and preserves its physical return',{timeout:100000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 rcon('forceload add 8500 8500 8540 8512');rcon('fill 8500 76 8500 8540 85 8512 air');rcon('fill 8500 76 8500 8509 78 8512 dirt');rcon('fill 8500 79 8500 8509 79 8512 grass_block');rcon('fill 8523 76 8500 8540 78 8512 dirt');rcon('fill 8523 79 8500 8540 79 8512 grass_block');rcon('fill 8510 79 8506 8530 79 8506 stone');rcon('setblock 8528 80 8506 crafting_table');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaUtilityPath',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('tp LayaUtilityPath 8506.5 80 8506.5');rcon('clear LayaUtilityPath');
  const ready=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(8506.5,80,8506.5))>1||!bot.blockAt(new Vec3(8528,80,8506)))&&Date.now()<ready)await sleep(50);
  const moves=new Movements(bot);moves.canDig=false;moves.allow1by1towers=false;moves.allowParkour=false;moves.maxDropDown=2;moves.infiniteLiquidDropdownDistance=false;moves.scafoldingBlocks=[];bot.pathfinder.setMovements(moves);
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaUtilityPath'}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld'});
  const s=executor.services(AbortSignal.timeout(85000),{confirmedRecoveryDeathId:'actual-life'});await beginResourceTrip(s,'cobblestone',8);
  const table={x:8528,y:80,z:8506};assert.equal(safeResourceRoute(bot,table,{radius:2}),undefined,'the old conservative route rejects the intact ledge');
  await s.near(table,2);assert.ok(bot.entity.position.distanceTo(new Vec3(8528.5,80,8506.5))<3.5);assert.equal(resourceTrip(s.checkpoint)?.phase,'outbound');assert.ok(resourceTrip(s.checkpoint)!.trail.length>1);
  const ledge=resourceTrip(s.checkpoint)!.trail.at(-1)!;
  assert.equal(safeResourceRoute(bot,ledge),undefined,'the saved observed ledge is outside the conservative reverse-route policy');
  const next={x:8535,y:80,z:8506};assert.ok(safeResourceRoute(bot,next),'the new forward route already passes the conservative policy');
  await s.near({...next,x:next.x+.5,z:next.z+.5},0);
  assert.ok(resourceTrip(s.checkpoint)!.trail.at(-1)!.x>ledge.x,'a strict forward walk still records its observed connection to the old ledge');
  await returnFromResourceTrip(s);assert.equal(resourceTrip(s.checkpoint)?.phase,'complete');assert.ok(bot.entity.position.distanceTo(new Vec3(8506.5,80,8506.5))<1.5);assert.equal(bot.inventory.items().length,0);
  assert.match(rcon('execute if block 8528 80 8506 crafting_table'),/Test passed/);assert.match(rcon('execute if block 8515 78 8506 air'),/Test passed/);assert.match(rcon('execute if block 8515 79 8506 stone'),/Test passed/);
  console.log('Actual utility approach and return verified',JSON.stringify({actual:bot.entity.position,itemsGiven:false,botTerrainEdits:false}));
 }finally{bot.quit('utility approach validation finished');await sleep(250);rcon('forceload remove 8500 8500 8540 8512');}
});
