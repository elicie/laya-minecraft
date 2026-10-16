import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BotInputSchema,RulesSchema} from '../packages/contracts/src';
import {blueprint} from '../packages/contracts/src/blueprints';
import {warehouseShelter} from '../packages/core/src/warehouse-shelter';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {beginResourceTrip,resourceTrip} from '../packages/minecraft/src/resource-trip';
import {ConditionWait} from '../packages/minecraft/src/services';
import {executeVillageTask} from '../packages/minecraft/src/village-actions';
import {restInWarehouse} from '../packages/minecraft/src/base-shelter';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('actual warehouse night entry, closed-door checkpoint resume and daylight exit preserve the building',{timeout:110000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const oldCycle=rcon('gamerule doDaylightCycle').includes('true'),oldTime=Number(rcon('time query daytime').match(/\d+/g)?.at(-1)??0),origin={x:9805,y:80,z:9805},blocks=blueprint('warehouse',origin),container={id:'night-warehouse',world:'127.0.0.1:25566',dimension:'overworld',position:{x:9806,y:81,z:9806}},base=warehouseShelter(container,blocks)!;
 rcon('forceload add 9800 9800 9825 9825');rcon('fill 9800 80 9800 9825 88 9825 air');rcon('fill 9800 77 9800 9825 78 9825 dirt');rcon('fill 9800 79 9800 9825 79 9825 grass_block');
 for(const b of blocks.filter(b=>!b.name.endsWith('_door')&&b.name!=='wall_torch'))rcon(`setblock ${b.position.x} ${b.position.y} ${b.position.z} ${b.name}`);
 rcon(`setblock ${base.door.x} ${base.door.y} ${base.door.z} oak_door[facing=south,half=lower,open=false]`);rcon(`setblock ${base.door.x} ${base.door.y+1} ${base.door.z} oak_door[facing=south,half=upper,open=false]`);
 for(const b of blocks.filter(b=>b.name==='wall_torch'))rcon(`setblock ${b.position.x} ${b.position.y} ${b.position.z} wall_torch[facing=${b.position.x===9806?'east':'west'}]`);
 rcon('kill @e[type=!player,x=9800,y=77,z=9800,dx=25,dy=12,dz=25]');rcon('gamerule doDaylightCycle true');rcon('time set 13000');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaBaseNight',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon(`tp LayaBaseNight ${base.outside.x+.5} ${base.outside.y} ${base.outside.z+.5}`);rcon('clear LayaBaseNight');
  const ready=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(base.outside.x+.5,base.outside.y,base.outside.z+.5))>.1||bot.time.isDay!==false||!bot.blockAt(new Vec3(9805,84,9805)))&&Date.now()<ready)await sleep(50);
  const movements=new Movements(bot);movements.canDig=false;movements.canOpenDoors=true;movements.allow1by1towers=false;movements.allowParkour=false;movements.maxDropDown=2;movements.infiniteLiquidDropdownDistance=false;movements.scafoldingBlocks=[];movements.blocksToAvoid.add(bot.registry.blocksByName.farmland!.id);bot.pathfinder.setMovements(movements);
  const rules=RulesSchema.parse({world:container.world,warehouse:container,baseShelter:base,autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaBaseNight'}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld'}),controller=new AbortController(),first=executor.services(controller.signal);
  let resolveClosed!:()=>void;const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});first.progress=(action)=>{if(action==='창고 야간 대피')resolveClosed();};
  const attempt=restInWarehouse(first,()=>true);attempt.catch(()=>{});await Promise.race([closed,attempt.then(()=>{throw Error('No actual warehouse entry');}),sleep(25000).then(()=>{throw Error('No actual warehouse entry');})]);
  assert.equal(bot.blockAt(new Vec3(base.door.x,base.door.y,base.door.z))!.getProperties().open,false);assert.equal(Math.floor(bot.entity.position.y),81);assert.equal(first.checkpoint.nightBasePending,true);
  controller.abort();await assert.rejects(attempt);const second=executor.services(AbortSignal.timeout(25000),structuredClone(first.checkpoint));const resumed=restInWarehouse(second,()=>true);await sleep(500);
  assert.equal(bot.blockAt(new Vec3(base.door.x,base.door.y,base.door.z))!.getProperties().open,false,'resuming at night must not open the door');rcon('time set 0');assert.equal(await resumed,true);
  assert.equal(second.checkpoint.nightBasePending,false);assert.equal(bot.blockAt(new Vec3(base.door.x,base.door.y,base.door.z))!.getProperties().open,false);assert.ok(bot.entity.position.distanceTo(new Vec3(base.outside.x+.5,base.outside.y,base.outside.z+.5))<.4);
  assert.ok(blocks.every(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name===b.name));assert.equal(bot.health,20);assert.equal(bot.inventory.items().length,0);
  console.log('Actual warehouse shelter',JSON.stringify({buildingPrepared:true,doorPubliclyOpenedAndClosed:true,closedCheckpointResumed:true,actualDaylightExit:true,buildingBlocksUnchanged:blocks.length,itemsGiven:false,health:bot.health}));
  const daytime=executor.services(AbortSignal.timeout(20000));assert.equal(await restInWarehouse(daytime,()=>true,undefined,'enter'),true);
  assert.equal(bot.blockAt(new Vec3(base.door.x,base.door.y,base.door.z))!.getProperties().open,false);
  rcon('give LayaBaseNight wheat 3');const stockDeadline=Date.now()+3000;while(executor.count('wheat')<3&&Date.now()<stockDeadline)await sleep(50);
  await executor.ensureItem('bread',1,daytime);assert.equal(executor.count('bread'),1);assert.equal(executor.count('wheat'),0);
  rcon(`tp LayaBaseNight ${base.inside.x+.4047} ${base.inside.y} ${base.inside.z+1.3815}`);await sleep(300);
  assert.equal(await restInWarehouse(daytime,()=>true,undefined,'exit'),true);assert.ok(blocks.every(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name===b.name));
  console.log('Actual indoor utility reuse',JSON.stringify({dayEntry:true,existingCraftingTable:true,breadCrafted:1,wheatConsumed:3,dayExit:true,buildingBlocksUnchanged:blocks.length,fixtureWheatGiven:true,productionWorld:false}));
  rcon(`setblock ${base.door.x} ${base.door.y} ${base.door.z} oak_door[facing=north,half=lower,open=false]`);rcon(`setblock ${base.door.x} ${base.door.y+1} ${base.door.z} oak_door[facing=north,half=upper,open=false]`);
  rcon(`tp LayaBaseNight ${base.outside.x+.574} ${base.outside.y+1} ${base.outside.z+.804}`);await sleep(700);
  assert.equal(Math.round(bot.entity.position.y),base.outside.y+1);
  const edge=executor.services(AbortSignal.timeout(15000),{materialExpedition:true});await beginResourceTrip(edge,'oak_log',1,base.outside);
  assert.equal(resourceTrip(edge.checkpoint)!.phase,'outbound');assert.equal(Math.round(bot.entity.position.y),base.outside.y);assert.equal((edge.checkpoint.baseThresholdSettle as any)?.phase,'complete');assert.equal(bot.health,20);
  console.log('Actual doorway foundation edge recovery',JSON.stringify({position:bot.entity.position,checkpoint:edge.checkpoint.baseThresholdSettle,blocksUnchanged:blocks.every(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name===b.name),fixtureTeleport:true,productionWorld:false}));
  // Composition check: a resumed farm has no held seed after other work
  // deposited it, and starts deeper inside the real warehouse.
  const farmOrigin={x:9818,y:79,z:9816},farmPlots=[{x:9819,y:79,z:9816},{x:9819,y:79,z:9817},{x:9819,y:79,z:9818}];
  rcon(`setblock ${farmOrigin.x} ${farmOrigin.y} ${farmOrigin.z} water`);for(const p of farmPlots){rcon(`setblock ${p.x} ${p.y} ${p.z} farmland[moisture=7]`);rcon(`setblock ${p.x} ${p.y+1} ${p.z} wheat[age=7]`);}
  rcon(`item replace block ${container.position.x} ${container.position.y} ${container.position.z} container.0 with wheat_seeds 2`);
  const farmRules=RulesSchema.parse({...rules,baseAutonomy:{id:'resume-seed-fixture',origin:farmOrigin,positions:farmPlots}}),farmExecutor=new MineflayerExecutor(bot,{config,rules:farmRules,world:rules.world,dimension:()=>'overworld',villageTask:executeVillageTask});
  const setup=farmExecutor.services(AbortSignal.timeout(25000));await farmExecutor.execute({id:'old-bread-store',goalId:'fixture',kind:'store',source:'user',params:{item:'bread',quantity:1},dependencies:[],reservationKeys:[],completion:{kind:'inventory',item:'bread',minimum:0}},setup);
  rcon(`tp LayaBaseNight ${base.inside.x+.4047} ${base.inside.y} ${base.inside.z+1.3815}`);await sleep(300);assert.equal(farmExecutor.count('wheat_seeds'),0);
  const deadline=AbortSignal.timeout(50000),farming=farmExecutor.services(deadline);const farmTask={id:'resumed-seed-farm',goalId:'fixture',kind:'farm',source:'user',params:{id:'resume-seed-fixture',crop:'wheat',mode:'harvest',origin:farmOrigin,positions:farmPlots,plots:3},dependencies:[],reservationKeys:[],completion:{kind:'farm',crop:'wheat',plots:3,mode:'harvest',quantity:3,baseline:0}} as const;
  await assert.rejects(farmExecutor.execute(farmTask as any,farming),error=>error instanceof ConditionWait);assert.equal((farming.checkpoint.waitingFor as any)?.item,'wheat_seeds');for(const p of farmPlots)assert.equal(Number(bot.blockAt(new Vec3(p.x,p.y+1,p.z))?.getProperties().age),7,'missing seed must not break a mature crop');
  rcon(`item replace block ${container.position.x} ${container.position.y} ${container.position.z} container.0 with wheat_seeds 3`);await sleep(200);const harvested=await farmExecutor.execute(farmTask as any,farming);

  assert.equal(harvested.outcome,'completed',harvested.reason);assert.ok(farmExecutor.count('wheat')>=3);assert.ok(harvested.observations.some(o=>o.kind==='container'&&o.data.items.every(i=>i.name!=='wheat_seeds')),'resumed farm actually withdrew the three chest seeds');
  for(const p of farmPlots)assert.equal(bot.blockAt(new Vec3(p.x,p.y+1,p.z))?.name,'wheat');
  await restInWarehouse(farming,()=>true,undefined,'enter');await farmExecutor.ensureItem('bread',1,farming);assert.equal(farmExecutor.count('wheat'),0);assert.equal(farmExecutor.count('bread'),1);
  await farmExecutor.execute({id:'new-bread-store',goalId:'fixture',kind:'store',source:'user',params:{item:'bread',quantity:1},dependencies:[],reservationKeys:[],completion:{kind:'inventory',item:'bread',minimum:0}},farming);assert.equal(farmExecutor.count('bread'),0);assert.equal(bot.health,20);
  console.log('Actual composed warehouse and farm workflow',JSON.stringify({initialHeldSeeds:0,actualSeedsWithdrawn:3,insufficientReserveWaitVerified:true,harvested:3,replanted:3,newBreadCraftedFromHarvest:1,newBreadDeposited:1,health:bot.health,fixtureSeedsGiven:true,fixtureMaturityPrepared:true,productionWorld:false}));

  await restInWarehouse(farming,()=>true,undefined,'exit');
  const resumedTrip=farmExecutor.services(AbortSignal.timeout(25000),{resourceRecovery:{sand:{destinationsUsed:3,elapsedMs:1234}}});
  await beginResourceTrip(resumedTrip,'wheat_seeds',1,base.outside);const actualSeeds=farmExecutor.count('wheat_seeds');assert.ok(actualSeeds>=1);
  await restInWarehouse(resumedTrip,()=>true,undefined,'enter');assert.equal(Math.round(bot.entity.position.y),base.inside.y);
  await farmExecutor.execute({id:'resumed-indoor-trip',goalId:'fixture',kind:'collect',source:'user',params:{item:'wheat_seeds',quantity:1,returnTo:base.outside},completion:{kind:'inventory',item:'wheat_seeds',minimum:1},dependencies:[],reservationKeys:[]},resumedTrip);
  assert.equal(resourceTrip(resumedTrip.checkpoint)!.phase,'complete');assert.equal(farmExecutor.count('wheat_seeds'),actualSeeds);assert.equal((resumedTrip.checkpoint.resourceRecovery as any).sand.elapsedMs,1234);
  assert.ok(bot.entity.position.distanceTo(new Vec3(base.outside.x+.5,base.outside.y,base.outside.z+.5))<.6);assert.equal(bot.blockAt(new Vec3(base.door.x,base.door.y,base.door.z))!.getProperties().open,false);
  console.log('Actual interrupted outdoor trip resumes from closed warehouse',JSON.stringify({actualDoorExit:true,savedBudgetPreserved:true,terrainEdits:0,productionWorld:false}));

 }finally{bot.quit('warehouse night shelter validation finished');await sleep(200);rcon('forceload remove 9800 9800 9825 9825');rcon(`gamerule doDaylightCycle ${oldCycle}`);rcon(`time set ${oldTime}`);}
});
