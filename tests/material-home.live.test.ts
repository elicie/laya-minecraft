import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { BotInputSchema, RulesSchema } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { beginResourceTrip, returnFromResourceTrip, resourceTrip } from '../packages/minecraft/src/resource-trip';

if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

test('distant same-life and new-life bodies return through observed legs and relocate only a destroyed staging support', {timeout:180000},async()=>{
  assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
  rcon('forceload add 8100 8100 8200 8112');rcon('fill 8100 80 8100 8200 86 8112 air');rcon('fill 8100 75 8100 8200 78 8112 dirt');rcon('fill 8100 79 8100 8200 79 8112 grass_block');
  const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaHomeChange',auth:'offline',viewDistance:2});bot.loadPlugin(pathfinder);
  try{
    await once(bot,'spawn');rcon('tp LayaHomeChange 8106.5 80 8106.5');rcon('clear LayaHomeChange');
    const ready=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(8106.5,80,8106.5))>1||!bot.blockAt(new Vec3(8130,79,8106)))&&Date.now()<ready)await sleep(50);
    const moves=new Movements(bot);moves.canDig=false;moves.allow1by1towers=false;moves.allowParkour=false;moves.maxDropDown=2;moves.infiniteLiquidDropdownDistance=false;moves.scafoldingBlocks=[];bot.pathfinder.setMovements(moves);
    const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaHomeChange'}),area={origin:{x:8104,y:80,z:8107},width:7,depth:5,height:4};
    const executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld'}),s=executor.services(AbortSignal.timeout(160000),{confirmedRecoveryDeathId:'initial-life',buildProtection:area,resourceRecovery:{sand:{destinationsUsed:5,elapsedMs:60000}}});
    await beginResourceTrip(s,'oak_door',1);const original=structuredClone(resourceTrip(s.checkpoint)!.home);
    for(const x of [8130,8154,8178]){const chunkUntil=Date.now()+5000;while(!bot.blockAt(new Vec3(x,79,8106))&&Date.now()<chunkUntil)await sleep(50);await executor.near({x:x+.5,y:80,z:8106.5},s.signal,0);}
    assert.equal(bot.blockAt(new Vec3(8106,79,8106)),null);await returnFromResourceTrip(s);
    assert.ok(bot.entity.position.distanceTo(new Vec3(8106.5,80,8106.5))<1.5);assert.equal(resourceTrip(s.checkpoint)!.deathId,'initial-life');assert.equal((s.checkpoint.resourceTripDisplacements as unknown[]).length,1);assert.equal(s.checkpoint.resourceTripInterruptedLives,undefined);assert.equal(bot.inventory.items().length,0);
    console.log('Actual same-life unloaded home return verified',JSON.stringify({actual:bot.entity.position,approach:s.checkpoint.resourceTripApproach,itemsGiven:false}));
    await beginResourceTrip(s,'oak_door',1);
    for(const x of [8130,8154,8178]){const chunkUntil=Date.now()+5000;while(!bot.blockAt(new Vec3(x,79,8106))&&Date.now()<chunkUntil)await sleep(50);await s.near({x:x+.5,y:80,z:8106.5},0);}
    assert.ok(bot.entity.position.x>=8178);assert.equal(bot.inventory.items().length,0);rcon('spawnpoint LayaHomeChange 8178 80 8106');
    const died=once(bot,'death'),spawned=once(bot,'spawn');rcon('kill LayaHomeChange');await died;await spawned;
    const alive=Date.now()+10000;while((bot.health!==20||Math.abs(bot.entity.position.y-80)>.1||!bot.blockAt(bot.entity.position.floored().offset(0,-1,0)))&&Date.now()<alive)await sleep(100);
    assert.equal(bot.inventory.items().length,0);assert.equal(bot.blockAt(new Vec3(8106,79,8106)),null,'the new player must not initially observe its home beyond the two-chunk view');s.checkpoint.confirmedRecoveryDeathId='actual-next-life';
    rcon('fill 8106 78 8106 8106 79 8106 air');
    await returnFromResourceTrip(s);const trip=resourceTrip(s.checkpoint)!;assert.equal(trip.phase,'complete');assert.notDeepEqual(trip.home,original);
    assert.ok(bot.entity.position.distanceTo(new Vec3(trip.home.x+.5,trip.home.y,trip.home.z+.5))<1.5);assert.deepEqual(s.checkpoint.buildProtection,area);assert.equal(bot.inventory.items().length,0);
    assert.match(rcon('execute if block 8106 79 8106 air'),/Test passed/);assert.equal((s.checkpoint.resourceRecovery as {sand:{elapsedMs:number}}).sand.elapsedMs,60000);
    assert.ok(s.checkpoint.resourceTripApproach);console.log('Actual missing staging support verified',JSON.stringify({original,actualHome:trip.home,actual:bot.entity.position,approach:s.checkpoint.resourceTripApproach,relocations:s.checkpoint.resourceTripHomeRelocations,constructionItemsGiven:false,terrainRepairPerformed:false}));
  }finally{bot.quit('material home validation finished');await sleep(250);rcon('forceload remove 8100 8100 8200 8112');}
});
