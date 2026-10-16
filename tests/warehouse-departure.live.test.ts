import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { BotInputSchema, RulesSchema, type BuildAccessPreparation } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { safeResourceStand } from '../packages/minecraft/src/resource-recovery';
import { beginResourceTrip, resourceTrip, recordResourceTripPosition, returnFromResourceTrip } from '../packages/minecraft/src/resource-trip';
import { prepareBuildAccess } from '../packages/minecraft/src/build-access-recovery';
import { leaveRecoveryEdge } from '../packages/minecraft/src/recovery-safety';

if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

test('an actual edge departure preserves budgets, resumes a distant material trip, and reconciles an actual death without revisiting its old endpoint',{timeout:120000},async()=>{
  assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
  rcon('forceload add 6700 6700 6820 6712');rcon('fill 6700 80 6700 6820 86 6712 air');rcon('fill 6700 75 6700 6820 78 6712 dirt');rcon('fill 6700 79 6700 6820 79 6712 grass_block');rcon('fill 6706 76 6705 6706 79 6705 air');
  rcon('fill 6740 76 6706 6740 78 6706 air');
  rcon('kill @e[type=item,x=6700,y=75,z=6700,dx=120,dy=12,dz=12]');
  const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaDepartSafe',auth:'offline'});bot.loadPlugin(pathfinder);
  try{
    await once(bot,'spawn');rcon('tp LayaDepartSafe 6706.5 80 6706.5');rcon('clear LayaDepartSafe');
    const end=Date.now()+15000;while((bot.entity.position.distanceTo(new Vec3(6706.5,80,6706.5))>1||!bot.blockAt(new Vec3(6800,79,6706)))&&Date.now()<end)await sleep(100);
    assert.ok(bot.blockAt(new Vec3(6800,79,6706)),'the entire return target is actually loaded');
    const movements=new Movements(bot);movements.canDig=false;movements.allow1by1towers=false;movements.allowParkour=false;movements.maxDropDown=2;movements.infiniteLiquidDropdownDistance=false;movements.scafoldingBlocks=[];bot.pathfinder.setMovements(movements);
    const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaDepartSafe'});
    const executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=> 'overworld'});
    assert.equal(safeResourceStand(bot,bot.entity.position,()=>false),false,'the original material-trip check rejects this deep neighboring gap');
    const services=executor.services(AbortSignal.timeout(70000),{resourceRecovery:{sand:{destinationsUsed:5,elapsedMs:60000}},confirmedRecoveryDeathId:'current-life'});
    await beginResourceTrip(services,'cobblestone',1);
    assert.equal(safeResourceStand(bot,bot.entity.position,()=>false),true);assert.ok(services.checkpoint.resourceDeparture);
    assert.equal((services.checkpoint.resourceRecovery as {sand:{elapsedMs:number}}).sand.elapsedMs,60000);
    assert.equal(resourceTrip(services.checkpoint)!.phase,'outbound');assert.equal(bot.inventory.items().length,0);
    const preparation:BuildAccessPreparation={start:{x:6790,y:80,z:6706},target:{x:6800,y:80,z:6706},observedAt:Date.now(),path:Array.from({length:11},(_,i)=>({x:6790+i,y:80,z:6706})),edits:[]};
    const access=executor.services(AbortSignal.timeout(60000));
    const walk=access.walkVerified!;access.walkVerified=async(path,stand)=>{const done=await walk(path,stand);if(done)await recordResourceTripPosition(services);return done;};
    const result=await prepareBuildAccess({id:'preserved-access',goalId:'warehouse',kind:'build',source:'user',params:{mode:'prepare-access',preparation,accessReturnDepth:1},completion:{kind:'manual',reason:'actual arrival'},dependencies:[],reservationKeys:[]},access);
    assert.equal(result.outcome,'completed');assert.ok(bot.entity.position.distanceTo(new Vec3(6800.5,80,6706.5))<1.5);
    assert.ok(Number((result.checkpoint.accessReturnRoute as {arrived:number}).arrived)>=90);
    assert.equal(bot.inventory.items().length,0);assert.equal(bot.blockAt(new Vec3(6800,79,6706))?.name,'grass_block');
    assert.match(rcon('execute if block 6706 76 6705 air'),/Test passed/);
    assert.match(rcon('execute if block 6740 78 6706 air'),/Test passed/);assert.match(rcon('execute if block 6740 79 6706 grass_block'),/Test passed/);
    const home=resourceTrip(services.checkpoint)!.home;
    // The same body really walked 95 blocks beyond its saved local recovery
    // anchor. A new edge must use the actual current region and spent budget.
    rcon('fill 6798 76 6705 6802 79 6705 air');rcon('fill 6798 80 6707 6802 81 6707 stone');
    const edge=executor.services(AbortSignal.timeout(15000),{recoverySafety:{anchor:home,attempts:2,elapsedMs:1234,probes:[],status:'waiting',fingerprint:'previous actual local region',reason:'old edge'}});
    const edgeWalk:{x:number;y:number;z:number}[]=[],edgeNear=edge.near;edge.near=async(p,r)=>{await edgeNear(p,r);edgeWalk.push(bot.entity.position.floored());};
    assert.equal(await leaveRecoveryEdge(bot,edge),true);
    const safety=edge.checkpoint.recoverySafety as {attempts:number;elapsedMs:number;displacements:unknown[]};
    assert.equal(safety.attempts,3);assert.ok(safety.elapsedMs>=1234);assert.equal(safety.displacements.length,1);
    assert.ok(edgeWalk.some(p=>Math.abs(p.x-6800)>=3),'the real body walks along existing cliff-side supports to reach wider ground');
    rcon('fill 6798 76 6705 6802 78 6705 dirt');rcon('fill 6798 79 6705 6802 79 6705 grass_block');rcon('fill 6798 80 6707 6802 81 6707 air');
    const priorLife=structuredClone(services.checkpoint);
    rcon(`fill ${home.x-1} 76 ${home.z} ${home.x-1} 79 ${home.z} air`);
    rcon('setblock 6802 80 6706 stone');rcon('give LayaDepartSafe wooden_pickaxe 1');
    const toolUntil=Date.now()+5000;while(executor.count('wooden_pickaxe')<1&&Date.now()<toolUntil)await sleep(50);
    executor.options.villageTask=async(_task,s)=>{assert.ok(bot.entity.position.distanceTo(new Vec3(home.x+.5,home.y,home.z+.5))<1.5);return{outcome:'completed',checkpoint:s.checkpoint,observations:s.observations,evidence:s.evidence};};
    const resumed=await executor.execute({id:'original-building',goalId:'warehouse',kind:'build',params:{materialExpedition:true},completion:{kind:'manual',reason:'actual saved trip'},dependencies:[],reservationKeys:[]},services);
    assert.equal(resumed.outcome,'completed');assert.equal(resourceTrip(services.checkpoint)!.phase,'complete');assert.ok(executor.count('cobblestone')>=1);assert.equal(bot.blockAt(new Vec3(6802,80,6706))?.name,'air');
    await prepareBuildAccess({id:'death-source',goalId:'warehouse',kind:'build',params:{preparation},completion:{kind:'manual',reason:'actual distant body'},dependencies:[],reservationKeys:[]},executor.services(AbortSignal.timeout(30000)));
    rcon('spawnpoint LayaDepartSafe 6800 80 6702');
    const died=once(bot,'death'),spawned=once(bot,'spawn');rcon('kill LayaDepartSafe');await died;await spawned;
    const aliveUntil=Date.now()+10000;while((bot.health!==20||bot.entity.position.distanceTo(new Vec3(6800.5,80,6702.5))>2)&&Date.now()<aliveUntil)await sleep(100);
    assert.ok(bot.entity.position.distanceTo(new Vec3(home.x+.5,home.y,home.z+.5))>90,'the actual new body starts far from its preserved work position');
    assert.equal(bot.inventory.items().length,0,'actual death lost the source items away from the work position');
    // Isolate returning from incidental recovery of the randomly scattered
    // test tool. Actual empty respawn was verified before this fixture cleanup.
    rcon('kill @e[type=item,x=6795,y=75,z=6700,dx=20,dy=15,dz=12]');
    const chunksUntil=Date.now()+10000;while((!bot.blockAt(new Vec3(home.x,home.y-1,home.z))||!bot.blockAt(bot.entity.position.floored().offset(0,-1,0)))&&Date.now()<chunksUntil)await sleep(100);
    assert.ok(bot.blockAt(new Vec3(home.x,home.y-1,home.z)),'the new life must actually receive the work-position chunk before checking its return');
    const oldTrip=resourceTrip(priorLife)!;oldTrip.phase='returning';priorLife.resourceTrip=oldTrip;priorLife.confirmedRecoveryDeathId='actual-next-life';
    const newLife=executor.services(AbortSignal.timeout(40000),priorLife);
    try{await returnFromResourceTrip(newLife);}catch(error){console.log('Actual new-life return diagnostics',JSON.stringify({actual:bot.entity.position,home:bot.blockAt(new Vec3(home.x,home.y-1,home.z))?.name,canDig:bot.pathfinder.movements.canDig,canTower:bot.pathfinder.movements.allow1by1towers,failure:newLife.checkpoint.resourceTripReconcileFailure}));throw error;}
    assert.equal(resourceTrip(newLife.checkpoint)!.phase,'complete');assert.ok(newLife.checkpoint.resourceTripInterruptedLives);
    assert.ok(bot.entity.position.distanceTo(new Vec3(home.x+.5,home.y,home.z+.5))<1.5);assert.equal(bot.inventory.items().length,0);
    const damaged=resourceTrip(newLife.checkpoint)!;damaged.phase='returning';newLife.checkpoint.resourceTrip=damaged;
    rcon(`setblock ${home.x} ${home.y-1} ${home.z} air`);
    const landedUntil=Date.now()+5000;while(Math.abs(bot.entity.position.y-(home.y-1))>.1&&Date.now()<landedUntil)await sleep(50);
    await returnFromResourceTrip(newLife);const alternate=resourceTrip(newLife.checkpoint)!.home;
    assert.notDeepEqual(alternate,home);assert.ok(bot.entity.position.distanceTo(new Vec3(alternate.x+.5,alternate.y,alternate.z+.5))<1.5);assert.ok(newLife.checkpoint.resourceTripHomeRelocations);
    assert.equal(bot.blockAt(new Vec3(home.x,home.y-1,home.z))?.name,'air','the changed staging point does not repair or redefine the warehouse');
    console.log('Verified actual safe departure and resumed material trip',JSON.stringify({departure:services.checkpoint.resourceDeparture,actual:bot.entity.position,returnRoute:access.checkpoint.accessReturnRoute,tripPhase:resourceTrip(services.checkpoint)!.phase,cobblestone:executor.count('cobblestone'),providedTool:'wooden_pickaxe',constructionItemsGiven:false}));
  }finally{bot.quit('warehouse departure validation finished');await sleep(250);rcon('forceload remove 6700 6700 6820 6712');}
});
