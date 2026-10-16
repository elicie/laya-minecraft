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

if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('the same actual body returns after walking beyond its recorded intermediate material waypoint',{timeout:100000},async()=>{
  assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
  rcon('forceload add 8300 8300 8390 8312');rcon('fill 8300 80 8300 8390 85 8312 air');rcon('fill 8300 76 8300 8390 78 8312 dirt');rcon('fill 8300 79 8300 8390 79 8312 grass_block');
  const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaDisplaced',auth:'offline'});bot.loadPlugin(pathfinder);
  try{
    await once(bot,'spawn');rcon('tp LayaDisplaced 8306.5 80 8306.5');rcon('clear LayaDisplaced');
    const ready=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(8306.5,80,8306.5))>1||!bot.blockAt(new Vec3(8380,79,8306)))&&Date.now()<ready)await sleep(50);
    const moves=new Movements(bot);moves.canDig=false;moves.allow1by1towers=false;moves.allowParkour=false;moves.maxDropDown=2;moves.infiniteLiquidDropdownDistance=false;moves.scafoldingBlocks=[];bot.pathfinder.setMovements(moves);
    const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaDisplaced'}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld'});
    const s=executor.services(AbortSignal.timeout(85000),{confirmedRecoveryDeathId:'same-actual-life'});await beginResourceTrip(s,'cobblestone',35);
    await s.near({x:8318.5,y:80,z:8306.5},0);const recorded=structuredClone(resourceTrip(s.checkpoint)!);assert.ok(recorded.trail.length>1);
    // Emergency movement is independent of material-trip recording. Walk the
    // real body through public APIs while retaining the earlier return trail.
    for(const x of [8342,8366,8380])await executor.near({x:x+.5,y:80,z:8306.5},s.signal,0);
    assert.ok(bot.entity.position.distanceTo(new Vec3(recorded.trail.at(-1)!.x,80,8306))>48);assert.deepEqual(resourceTrip(s.checkpoint)!.trail,recorded.trail);
    await returnFromResourceTrip(s);const trip=resourceTrip(s.checkpoint)!;assert.equal(trip.phase,'complete');assert.equal(trip.deathId,'same-actual-life');assert.equal(bot.inventory.items().length,0);
    assert.ok(bot.entity.position.distanceTo(new Vec3(8306.5,80,8306.5))<1.5);assert.match(rcon('execute if block 8318 79 8306 grass_block'),/Test passed/);
    console.log('Actual displaced return verified',JSON.stringify({home:trip.home,recordedLast:recorded.trail.at(-1),displacedAt:{x:8380,y:80,z:8306},actual:bot.entity.position,itemsGiven:false,terrainRepair:false}));
    await beginResourceTrip(s,'cobblestone',8);await s.near({x:8330.5,y:80,z:8306.5},0);
    const miningStand=resourceTrip(s.checkpoint)!.trail.at(-1)!;await executor.near({x:8354.5,y:80,z:8306.5},s.signal,0);
    rcon(`setblock ${miningStand.x} ${miningStand.y-1} ${miningStand.z} air`);
    const changed=Date.now()+5000;while(bot.blockAt(new Vec3(miningStand.x,miningStand.y-1,miningStand.z))?.name!=='air'&&Date.now()<changed)await sleep(50);
    await returnFromResourceTrip(s);assert.ok(bot.entity.position.distanceTo(new Vec3(8306.5,80,8306.5))<1.5);assert.ok(s.checkpoint.resourceTripShortcuts);assert.equal(bot.inventory.items().length,0);
    assert.match(rcon(`execute if block ${miningStand.x} ${miningStand.y-1} ${miningStand.z} air`),/Test passed/);
    console.log('Actual missing intermediate support bypassed',JSON.stringify({removedSupport:{x:miningStand.x,y:miningStand.y-1,z:miningStand.z},actual:bot.entity.position,itemsGiven:false,terrainRepair:false}));
    await executor.near({x:8310.5,y:80,z:8306.5},s.signal,0);
    rcon('fill 8305 80 8305 8307 80 8307 cobblestone');
    const floorUntil=Date.now()+5000;while(bot.blockAt(new Vec3(8306,80,8306))?.name!=='cobblestone'&&Date.now()<floorUntil)await sleep(50);
    await executor.near({x:8306.5,y:81,z:8306.5},s.signal,0);
    s.checkpoint.safeDetourRequired=true;
    await s.near({x:8306.5,y:80,z:8306.5},1);
    assert.ok(Math.abs(bot.entity.position.y-81)<.1,'the real raised floor satisfies the occupied construction goal without walking inside it');
    await s.near({x:8306.5,y:80,z:8304.5},1);
    assert.ok(bot.entity.position.distanceTo(new Vec3(8306.5,80,8304.5))<1.6);
    assert.match(rcon('execute if block 8306 80 8306 cobblestone'),/Test passed/);
    console.log('Actual raised construction floor and entrance approach verified',JSON.stringify({actual:bot.entity.position,itemsGiven:false,botTerrainEdits:false}));
  }finally{bot.quit('same-life displacement validation finished');await sleep(250);rcon('forceload remove 8300 8300 8390 8312');}
});
