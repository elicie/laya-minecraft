import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { RecoveryStateSchema, WorkerLaunchSchema, WorkerMessageSchema, type Position } from '../packages/contracts/src';
import { blueprintPreset } from '../packages/contracts/src/blueprint-catalog';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ResourceRecovery, foodSearchCanExpand, reconcileResourceJourneys, safeResourceStand, safeResourceRoute } from '../packages/minecraft/src/resource-recovery';
import { observedGroundRoute } from '../packages/minecraft/src/observed-ground-walk';
import { ActionFailure, ConditionWait, pause } from '../packages/minecraft/src/services';
import { approachKnownBase, beginResourceTrip, recordResourceTripPosition, returnFromResourceTrip, resourceTrip, resumeResourceTrip } from '../packages/minecraft/src/resource-trip';
import { walkingFeet } from '../packages/minecraft/src/observations';
import { leaveRecoveryEdge } from '../packages/minecraft/src/recovery-safety';

function fixture() {
  const cells = new Map<string, string>(), ages = new Map<string, number>(), sources: Vec3[] = [], stock = new Map<string, number>(), moved: Vec3[] = [], dug: Vec3[] = [];
  let loaded = (_p: Vec3) => true, routeAllowed = (_p: Vec3) => true, visible = (_p: Vec3) => true, pathRadius=50;
  const blockAt = (p: Vec3) => {
    if (!loaded(p)) return null;
    const name = cells.get(p.toString()) ?? (p.y === 63 ? 'dirt' : 'air');
    const empty=['air', 'cave_air', 'potatoes', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'leaf_litter', 'bush', 'firefly_bush', 'short_dry_grass', 'tall_dry_grass', 'dandelion','orange_tulip','pink_tulip'].includes(name);
    return { name, position: p, boundingBox: empty ? 'empty' : 'block', shapes:empty?[]:[[0,0,0,1,name==='farmland'?.9375:1,1]], canHarvest: () => true, getProperties: () => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(name) ? { age: ages.get(p.toString()) ?? 7 } : {} };
  };
  const launch = WorkerLaunchSchema.parse({ botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch', config: { name: 'RecoveryUnit' }, rules: { autonomyEnabled: false } });
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {}, health: 5, food: 17, blockAt,
    inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, stackSize: 64 })), emptySlotCount: () => 36 },
    registry: { itemsByName: { cobblestone: { id: 1 }, potato: { id: 2 } }, items: {} }, recipesAll: () => [],
    findBlock(request: { matching(b: unknown): boolean; useExtraInfo?(b: unknown): boolean }) { return sources.map(blockAt).find(b => b && request.matching(b) && (!request.useExtraInfo || request.useExtraInfo(b))) ?? null; },
    findBlocks(request: { point?: Position; matching(b: unknown): boolean }) { assert.ok(request.point, 'recovery resource scans must use their fixed anchor'); return sources.filter(p => { const b = blockAt(p); return b && request.matching(b); }).slice(0, 64); },
    canSeeBlock(block: { position: Vec3 }) { return visible(bot.entity.position); },
    async equip() {}, async dig(block: { name: string; position: Vec3 }) { dug.push(block.position); cells.set(block.position.toString(), 'air'); const item = block.name === 'stone' ? 'cobblestone' : block.name === 'potatoes' ? 'potato' : block.name; stock.set(item, (stock.get(item) ?? 0) + 1); },
    pathfinder: { movements: { canDig: false, allow1by1towers: false }, getPathTo(_movements: unknown, goal: { x: number; y: number; z: number }) {
      const target = new Vec3(goal.x, goal.y, goal.z); if (!routeAllowed(target)) return { status: 'noPath', path: [] };
      const start = bot.entity.position.floored(), queue = [start], previous = new Map<string, Vec3 | null>([[start.toString(), null]]);
      let found: Vec3 | undefined;
      for (let index = 0; index < queue.length && index < 10000; index++) {
        const p = queue[index]; if (p.equals(target)) { found = p; break; }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
          const next = p.offset(dx!, dy, dz!); if (previous.has(next.toString()) || next.distanceTo(start) > pathRadius || blockAt(next)?.boundingBox !== 'empty' || blockAt(next.offset(0, 1, 0))?.boundingBox !== 'empty' || blockAt(next.offset(0, -1, 0))?.boundingBox !== 'block') continue;
          previous.set(next.toString(), p); queue.push(next);
        }
      }
      const path = [];
      while (found && !found.equals(start)) { path.unshift({ x: found.x, y: found.y, z: found.z, toBreak: [], toPlace: [], parkour: false }); found = previous.get(found.toString())!; }
      return { status: previous.has(target.toString()) ? 'success' : 'noPath', path };
    } },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => 'overworld' }), services = executor.services(new AbortController().signal);
  services.pause = async () => {};
  services.near = async p => { const destination = new Vec3(p.x, p.y, p.z); moved.push(destination); bot.entity.position = destination; };
  const add = (p: Vec3, name: string) => { sources.push(p); cells.set(p.toString(), name); };
  return { bot, executor, services, cells, ages, sources, stock, moved, dug, add, launch, set loaded(fn: typeof loaded) { loaded = fn; }, set routeAllowed(fn: typeof routeAllowed) { routeAllowed = fn; }, set visible(fn: typeof visible) { visible = fn; },set pathRadius(n:number){pathRadius=n;} };
}

test('rejected source candidates yield to a queued heartbeat without refilling the current search allowance', async () => {
  const f = fixture(); f.bot.health = 20; f.bot.food = 20; f.launch.config.allowedActions = ['collect'];
  Object.assign(f.bot.registry.itemsByName, { sand: { id: 3 } });
  for (let x = 6; x < 38; x++) f.add(new Vec3(x,80,0),'sand');
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'sand', ['sand'], false, () => false);
  Object.assign(recovery.state, { destinationsUsed: 4, approachesUsed: 7, elapsedMs: 59000 });
  f.services.pause = ms => pause(ms, f.services.signal);
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 0);
  try {
    await assert.rejects(f.executor.ensureItem('sand',1,f.services), ConditionWait);
    assert.equal(heartbeat,true,'failed candidates must not monopolize the worker event loop');
    assert.equal(recovery.state.destinationsUsed,4); assert.equal(recovery.state.approachesUsed,7); assert.equal(recovery.state.elapsedMs,59000);
    assert.deepEqual(f.dug,[]); assert.deepEqual(f.moved,[]);
  } finally { clearTimeout(timer); }
});

test('building material expedition obtains distant actual sand and returns via loaded saved waypoints without losing its search origin',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;Object.assign(f.bot.registry.itemsByName,{sand:{id:3}});
  f.loaded=p=>Math.abs(p.x-f.bot.entity.position.x)<=26 && Math.abs(p.z)<=2;
  f.add(new Vec3(240,64,0),'sand');
  const legacy=new ResourceRecovery(f.bot as unknown as Bot,f.services,'sand',['sand'],true,()=>false);
  legacy.state.destinationsUsed=5;legacy.state.elapsedMs=60000;legacy.wait('spent local search',1);
  const near=f.services.near;f.services.near=async(p,r)=>{await near(p,r);await recordResourceTripPosition(f.services);};
  f.executor.options.villageTask=async(_task,s)=>{await s.ensureItem('sand',1);return{outcome:'completed',observations:s.observations,evidence:s.evidence,checkpoint:s.checkpoint};};
  const result=await f.executor.execute({id:'build',goalId:'warehouse',kind:'build',params:{materialExpedition:true},completion:{kind:'manual',reason:'actual round trip'},dependencies:[],reservationKeys:[]},f.services);
  assert.equal(result.outcome,'completed');assert.equal(f.stock.get('sand'),1);assert.ok(f.moved.some(p=>p.x>200));
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(0.5,64,0.5))<1);
  const saved=resourceTrip(f.services.checkpoint)!;assert.equal(saved.phase,'complete');assert.equal(saved.returns,1);
  const recovery=new ResourceRecovery(f.bot as unknown as Bot,f.services,'sand',['sand'],true,()=>false);
  assert.deepEqual(recovery.state.origin,{x:0,y:64,z:0});assert.deepEqual(recovery.state.resourceJourney!.center,{x:0,y:64,z:0});
});

test('past collection directs only verified exploration legs toward a distant source and is consumed on actual regional arrival',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.resourceExpedition=true;
  Object.assign(f.bot.registry.itemsByName,{oak_log:{id:3}});f.loaded=p=>Math.abs(p.x-f.bot.entity.position.x)<=26;
  const source=new Vec3(-120,64,0);f.add(source,'oak_log');f.cells.set(source.offset(0,1,0).toString(),'oak_leaves');
  f.services.checkpoint.resourceHints=[{item:'oak_log',position:{x:120,y:64,z:0},world:'another-world',dimension:'overworld'},{item:'oak_log',position:{x:-120,y:64,z:0},world:f.services.rules.world,dimension:f.services.rules.dimension}];
  await f.executor.ensureItem('oak_log',1,f.services);
  assert.equal(f.stock.get('oak_log'),1);assert.deepEqual(f.dug,[source]);assert.ok(f.moved.some(p=>p.x<=-96));assert.ok(f.moved.every(p=>p.x<1));
  assert.deepEqual((f.services.checkpoint.resourceHintVisits as {oak_log:Position[]}).oak_log,[{x:-120,y:64,z:0}]);
  const r=new ResourceRecovery(f.bot as unknown as Bot,f.services,'oak_log',['oak_log'],true,()=>false);assert.deepEqual(r.state.origin,{x:0,y:64,z:0});
  WorkerMessageSchema.parse({protocolVersion:1,messageId:'hinted-collection',controllerEpoch:'epoch',botId:'bot',sessionId:'session',sentAt:1,type:'task.result',taskId:'task',attemptId:'attempt',payload:{outcome:'completed',checkpoint:f.services.checkpoint,observations:f.services.observations,evidence:[]}});
});

test('a journey created after the confirmed respawn does not treat the same life as another death on reassignment', () => {
  const f = fixture(), recovery = RecoveryStateSchema.parse({ deathId:'already-resolved',occurredAt:1,world:f.launch.rules.world,dimension:'overworld',priorInventory:[],phase:'resolved',reason:'actual safe respawn',attemptCount:0,progress:{recoveredCount:0,remainingCount:0},safe:true,updatedAt:2,checkpoint:{} });
  reconcileResourceJourneys(f.bot as unknown as Bot,f.services.checkpoint,recovery);
  f.services.checkpoint.resourceExpedition=true;
  const search=new ResourceRecovery(f.bot as unknown as Bot,f.services,'oak_log',['oak_log'],true,()=>false);assert.equal(search.beginResourceJourney(),true);
  const before=structuredClone(search.state.resourceJourney);f.bot.entity.position=new Vec3(12,64,0);
  reconcileResourceJourneys(f.bot as unknown as Bot,f.services.checkpoint,recovery);
  assert.deepEqual((f.services.checkpoint.resourceRecovery as Record<string,{resourceJourney:unknown}>).oak_log!.resourceJourney,before);
});

test('fresh food sightings guide actual safe exploration without creating food or resetting spent search',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=10;
  f.services.rules.foodSearchHints=[{resource:'pig',position:{x:-120,y:64,z:0},observedAt:Date.now(),world:f.services.rules.world,dimension:f.services.rules.dimension}];
  const r=new ResourceRecovery(f.bot as unknown as Bot,f.services,'$food',[],true,()=>false);
  assert.equal(await r.move(),true);assert.ok(f.moved.at(-1)!.x<0);assert.equal(f.stock.size,0);
  assert.equal(r.state.destinationsUsed,1);
  f.services.rules.foodSearchHints[0]!.observedAt=Date.now()-900001;
  const visitedBefore=structuredClone(f.services.checkpoint.resourceHintVisits);await r.move();assert.deepEqual(f.services.checkpoint.resourceHintVisits,visitedBefore);
  assert.equal(r.state.destinationsUsed,2);
});

test('critical food search walks an intact protected floor while collection protection stays intact',async()=>{
  const f=fixture();f.bot.health=3;f.bot.food=17;
  const r=new ResourceRecovery(f.bot as unknown as Bot,f.services,'$food',[],true,()=>true);
  assert.equal(await r.move(),true);assert.ok(f.moved.length>0);
  assert.equal(f.dug.length,0);assert.equal(f.stock.size,0);
  const hostile={id:99,name:'zombie',position:f.bot.entity.position.clone()};Object.assign(f.bot.entities,{99:hostile});
  assert.equal(r.route(f.bot.entity.position.offset(8,0,0)),false);
});

test('a healthy material trip can depart an intact existing edge without moving its pinned home or editing the gap',async()=>{
 const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.materialExpedition=true;
 for(const y of [61,62,63])f.cells.set(new Vec3(1,y,0).toString(),'air');
 assert.equal(safeResourceStand(f.bot as unknown as Bot,f.bot.entity.position,()=>false),false);
 const trip=await beginResourceTrip(f.services,'wheat_seeds',2,{x:0,y:64,z:0});
 assert.deepEqual(trip.home,{x:0,y:64,z:0});assert.equal(trip.phase,'outbound');assert.equal(f.moved.length,0);assert.equal(f.dug.length,0);
});

test('a hungry distant body approaches a known base through actually loaded legs without inventing a return trail',async()=>{
 const f=fixture();f.bot.health=9;f.bot.food=17;f.loaded=p=>Math.abs(p.x-f.bot.entity.position.x)<=26&&Math.abs(p.z)<=2;
 await approachKnownBase(f.services,{x:240,y:64,z:0});assert.ok(f.bot.entity.position.x>=208);
 assert.equal(resourceTrip(f.services.checkpoint),undefined);
 const proof=f.services.checkpoint.resourceTripApproach as {moves:number;legs:unknown[]};assert.ok(proof.moves>1);assert.ok(proof.legs.length>1);
 const before=structuredClone(proof);await approachKnownBase(f.services,{x:240,y:64,z:0});assert.deepEqual(f.services.checkpoint.resourceTripApproach,before);
 assert.equal(f.dug.length,0);assert.equal(f.stock.size,0);
});

test('actual escape records terrain continuity while a pursuing hostile still prevents return travel',async()=>{
  const f=fixture();f.services.checkpoint.confirmedRecoveryDeathId='old-life';await beginResourceTrip(f.services,'oak_log',32);
  f.bot.entity.position=new Vec3(20.5,64,.5);Object.assign(f.bot.entities,{3:{id:3,name:'zombie',position:new Vec3(.5,64,.5)}});
  f.services.checkpoint.confirmedRecoveryDeathId='new-life';await beginResourceTrip(f.services,'oak_log',32);await recordResourceTripPosition(f.services);assert.equal(resourceTrip(f.services.checkpoint)!.trail.at(-1)!.x,20);assert.equal(resourceTrip(f.services.checkpoint)!.deathId,'new-life');
  await assert.rejects(returnFromResourceTrip(f.services),ConditionWait);assert.equal(f.bot.entity.position.x,20.5);assert.equal(resourceTrip(f.services.checkpoint)!.phase,'returning');
});

test('a harvested farmland surface uses its public collision height and does not strand a pending resource trip',async()=>{
  const f=fixture();f.cells.set(new Vec3(0,63,0).toString(),'farmland');f.bot.entity.position=new Vec3(.5,63.9375,.5);
  assert.equal(walkingFeet(f.bot as unknown as Bot).y,64);assert.equal(safeResourceStand(f.bot as unknown as Bot,f.bot.entity.position,()=>false),true);
  await beginResourceTrip(f.services,'oak_log',32,{x:8.5,y:64,z:.5});await returnFromResourceTrip(f.services);
  assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');assert.equal(f.bot.entity.position.x,8.5);assert.equal(f.stock.get('oak_log')??0,0,'surface compatibility never invents harvested wood');
});

test('a physically completed return reconnects a nested lost anchor once while preserving its spent search and history',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;await beginResourceTrip(f.services,'oak_door',1);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  f.services.checkpoint.resourceRecovery={oak_log:{origin:{x:0,y:64,z:0},destinationsUsed:5,elapsedMs:60000,status:'exhausted',reason:'원정의 마지막 도착 위치와 현재 위치 사이의 안전한 연결을 확인해야 합니다.',resourceJourney:{center:{x:24,y:64,z:0},visited:[{x:24,y:64,z:0}],deadEnds:[],pending:false,moves:42,elapsedMs:123456,status:'blocked'}}};
  await returnFromResourceTrip(f.services);const r=(f.services.checkpoint.resourceRecovery as Record<string,{status:string;elapsedMs:number;resourceJourney:{status:string;displacementCount:number;moves:number;elapsedMs:number}}>).oak_log!;
  assert.equal(r.status,'searching');assert.equal(r.resourceJourney.status,'searching');assert.equal(r.resourceJourney.displacementCount,1);assert.equal(r.elapsedMs,60000);assert.equal(r.resourceJourney.moves,42);assert.equal(r.resourceJourney.elapsedMs,123456);
  await returnFromResourceTrip(f.services);assert.equal(r.resourceJourney.displacementCount,1);
});

for(const spent of [false,true])test(`an actual combat displacement reconnects the local recovery edge without refreshing its safety budget (${spent?'spent':'remaining'})`,async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.bot.entity.position=new Vec3(32.5,64,.5);
  for(let x=30;x<=34;x++){f.cells.set(new Vec3(x,63,-1).toString(),'air');f.cells.set(new Vec3(x,64,1).toString(),'stone');f.cells.set(new Vec3(x,65,1).toString(),'stone');}
  f.services.checkpoint.recoverySafety={anchor:{x:0,y:64,z:0},attempts:spent?5:2,elapsedMs:1234,probes:[],status:'waiting',fingerprint:'old actual region',reason:'old edge blocked'};
  const result=await leaveRecoveryEdge(f.bot as unknown as Bot,f.services,()=>100);
  const saved=f.services.checkpoint.recoverySafety as {attempts:number;elapsedMs:number;displacements:{from:Position;to:Position}[]};
  assert.equal(result,!spent);assert.equal(saved.attempts,spent?5:3);assert.equal(saved.elapsedMs,1234);assert.deepEqual(saved.displacements,[{from:{x:0,y:64,z:0},to:{x:32,y:64,z:0}}]);
  if(spent)assert.equal(f.moved.length,0);else assert.ok(f.moved.some(p=>Math.abs(p.x-32.5)>=3),'existing solid footing along the edge reaches the wider safe ground');
  assert.equal(f.cells.get(new Vec3(32,63,-1).toString()),'air');assert.equal(f.cells.get(new Vec3(32,64,1).toString()),'stone');
});

test('actual terrain hazards on the return route preserve the recorded trail and do not execute unsafe movement',async()=>{
  const f=fixture();f.bot.health=20;f.loaded=p=>Math.abs(p.z)<=1;
  await beginResourceTrip(f.services,'cobblestone',1);
  await f.services.near({x:16.5,y:64,z:0.5});await recordResourceTripPosition(f.services);
  const before=f.moved.length;f.cells.set(new Vec3(8,63,0).toString(),'lava');
  await assert.rejects(returnFromResourceTrip(f.services),ConditionWait);
  assert.equal(f.moved.length,before);assert.equal(resourceTrip(f.services.checkpoint)!.phase,'returning');
  assert.deepEqual(resourceTrip(f.services.checkpoint)!.trail,[{x:0,y:64,z:0}], 'the already reached source waypoint is confirmed, while the blocked home segment remains');
  assert.equal(f.bot.entity.position.x,16.5);
});

test('an interrupted return resumes from preserved waypoints without recollecting already held resources',async()=>{
  const f=fixture();f.bot.health=20;await beginResourceTrip(f.services,'cobblestone',1);
  for(const x of [24,48]){await f.services.near({x:x+0.5,y:64,z:0.5});await recordResourceTripPosition(f.services);}
  f.stock.set('cobblestone',1);
  let blocked=true;const near=f.services.near;f.services.near=async(p,r)=>{if(blocked && p.x<40)throw new ActionFailure('interrupted','CANCELLED',false,true);await near(p,r);};
  await assert.rejects(returnFromResourceTrip(f.services),e=>e instanceof ActionFailure && e.code==='CANCELLED');
  const checkpoint=structuredClone(f.services.checkpoint);assert.equal(resourceTrip(checkpoint)!.phase,'returning');assert.deepEqual(resourceTrip(checkpoint)!.trail,[{x:0,y:64,z:0},{x:24,y:64,z:0}],'a failed walk must retain the not-yet-reached source waypoint');
  blocked=false;f.services.checkpoint=checkpoint;await returnFromResourceTrip(f.services);
  assert.equal(resourceTrip(checkpoint)!.phase,'complete');assert.equal(f.dug.length,0);assert.equal(f.stock.get('cobblestone'),1);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(0.5,64,0.5))<1);
});

test('an older failed shortcut restores recorded source stands without refreshing resource budgets',async()=>{
 const f=fixture();f.bot.health=20;f.bot.food=20;await beginResourceTrip(f.services,'cobblestone',1);
 for(const x of [24,48,72,84]){await f.services.near({x:x+.5,y:64,z:.5});await recordResourceTripPosition(f.services);}
 const trip=resourceTrip(f.services.checkpoint)!;trip.phase='returning';trip.trail=trip.trail.slice(0,2);f.services.checkpoint.resourceTrip=trip;
 f.services.checkpoint.resourceTripShortcuts=[{from:{x:84,y:64,z:0},target:{x:24,y:64,z:0},skippedWaypoints:[{x:48,y:64,z:0},{x:72,y:64,z:0},{x:84,y:64,z:0}],observedAt:1}];f.services.checkpoint.returnMovementFailure={observedAt:2};f.services.checkpoint.resourceRecovery={sand:{elapsedMs:1234,destinationsUsed:3}};
 await returnFromResourceTrip(f.services);assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');assert.ok(f.services.checkpoint.resourceTripShortcutRepairs);assert.equal((f.services.checkpoint.resourceRecovery as any).sand.elapsedMs,1234);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);
});

test('tool preparation at home can restore the same actually traversed source path before collecting',async()=>{
  const f=fixture();f.bot.health=20;await beginResourceTrip(f.services,'cobblestone',1);
  for(const x of [24,48,72]){await f.services.near({x:x+0.5,y:64,z:0.5});await recordResourceTripPosition(f.services);}
  const trail=resourceTrip(f.services.checkpoint)!.trail;
  await returnFromResourceTrip(f.services);await beginResourceTrip(f.services,'cobblestone',1);
  await resumeResourceTrip(f.services,trail);assert.equal(f.bot.entity.position.x,72.5);
  assert.equal(resourceTrip(f.services.checkpoint)!.phase,'outbound');assert.equal(f.dug.length,0);
  await returnFromResourceTrip(f.services);assert.ok(f.bot.entity.position.distanceTo(new Vec3(0.5,64,0.5))<1);
});

test('same-life interruption preserves a trip while a confirmed new recovery reconnects its real home position',async()=>{
  const f=fixture();f.bot.health=20;f.services.checkpoint.confirmedRecoveryDeathId='first';await beginResourceTrip(f.services,'cobblestone',1);
  await f.services.near({x:24.5,y:64,z:0.5});await recordResourceTripPosition(f.services);
  await beginResourceTrip(f.services,'cobblestone',1);assert.equal(resourceTrip(f.services.checkpoint)!.trail.length,2);
  f.bot.entity.position=new Vec3(0.5,64,0.5);f.services.checkpoint.confirmedRecoveryDeathId='next';
  await beginResourceTrip(f.services,'cobblestone',1);assert.deepEqual(resourceTrip(f.services.checkpoint)!.trail,[{x:0,y:64,z:0}]);
  assert.equal(resourceTrip(f.services.checkpoint)!.deathId,'next');
});

for(const supplied of [false,true])test(`a resumed building finishes its saved material expedition before approaching the entrance (${supplied?'held stock':'actual collection'})`,async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;
  await beginResourceTrip(f.services,'cobblestone',1);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  if(supplied)f.stock.set('cobblestone',1);else f.add(new Vec3(28,64,0),'stone');
  let entered=false;f.executor.options.villageTask=async(_task,s)=>{
    entered=true;assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1.5,'the saved return completes before any new entrance approach');
    assert.deepEqual(s.checkpoint.buildProtection,{origin:{x:0,y:64,z:8},width:1,depth:1,height:1});
    assert.equal(f.stock.get('cobblestone'),1);assert.equal(resourceTrip(s.checkpoint)!.phase,'complete');
    return{outcome:'completed',checkpoint:s.checkpoint,observations:s.observations,evidence:[]};
  };
  const result=await f.executor.execute({id:'original-building',goalId:'warehouse',kind:'build',params:{materialExpedition:true},completion:{kind:'blocks',blocks:[{position:{x:0,y:64,z:8},name:'cobblestone'},{position:{x:0,y:65,z:8},name:'oak_planks'}]},dependencies:[],reservationKeys:[]},f.services);
  assert.equal(result.outcome,'completed');assert.equal(entered,true);assert.equal(f.dug.length,supplied?0:1);assert.equal(resourceTrip(result.checkpoint)!.returns,1);
});

test('a physically displaced same-life return can reprove an intermediate waypoint beyond 48 blocks',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.confirmedRecoveryDeathId='same-life';
  await beginResourceTrip(f.services,'cobblestone',35);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  f.bot.entity.position=new Vec3(84.5,64,.5);f.loaded=p=>Math.abs(p.z)<=2;f.pathRadius=128;
  await returnFromResourceTrip(f.services);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);assert.equal(resourceTrip(f.services.checkpoint)!.deathId,'same-life');assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');assert.equal(f.stock.size,0);
});

test('a mined-away intermediate support is bypassed only by a fully observed home connection',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;await beginResourceTrip(f.services,'cobblestone',8);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  f.bot.entity.position=new Vec3(48.5,64,.5);f.stock.set('cobblestone',8);f.cells.set(new Vec3(24,63,0).toString(),'air');f.loaded=p=>Math.abs(p.z)<=3;
  await returnFromResourceTrip(f.services);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);assert.equal(f.cells.get(new Vec3(24,63,0).toString()),'air');assert.equal(f.stock.get('cobblestone'),8);assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');
  const shortcut=(f.services.checkpoint.resourceTripShortcuts as {target:Position;skippedWaypoints:Position[]}[])[0]!;assert.deepEqual(shortcut.target,{x:0,y:64,z:0});assert.deepEqual(shortcut.skippedWaypoints,[{x:24,y:64,z:0}]);
});

test('the same life physically reconnects home through loaded legs after a distant food or combat displacement',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.confirmedRecoveryDeathId='same-life';
  await beginResourceTrip(f.services,'cobblestone',8);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  f.services.checkpoint.resourceRecovery={sand:{destinationsUsed:5,elapsedMs:60000}};f.bot.entity.position=new Vec3(140.5,64,.5);f.loaded=p=>Math.abs(p.x-f.bot.entity.position.x)<=26&&Math.abs(p.z)<=2;
  await returnFromResourceTrip(f.services);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);assert.equal(resourceTrip(f.services.checkpoint)!.deathId,'same-life');assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');assert.equal(f.stock.size,0);
  assert.equal(f.services.checkpoint.resourceTripInterruptedLives,undefined);assert.equal((f.services.checkpoint.resourceTripDisplacements as unknown[]).length,1);assert.ok((f.services.checkpoint.resourceTripApproach as {moves:number}).moves>=4);assert.equal((f.services.checkpoint.resourceRecovery as {sand:{elapsedMs:number}}).sand.elapsedMs,60000);
});



test('explicit material collection first brings a new body home before resuming an old returning trip',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.confirmedRecoveryDeathId='actual-new-life';
  f.services.checkpoint.resourceTrip={item:'oak_log',minimum:1,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0},{x:24,y:64,z:0}],phase:'returning',deathId:'actual-old-life',returns:4};
  f.services.checkpoint.resourceRecovery={sand:{destinationsUsed:5,elapsedMs:60000}};f.bot.entity.position=new Vec3(140.5,64,.5);f.loaded=p=>Math.abs(p.x-f.bot.entity.position.x)<=26&&Math.abs(p.z)<=2;
  f.executor.ensureItem=async()=>{assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);f.stock.set('oak_log',1);};
  const result=await f.executor.execute({id:'new-life-supply',goalId:'supply',kind:'collect',params:{item:'oak_log',quantity:1,returnTo:{x:0,y:64,z:0}},completion:{kind:'inventory',item:'oak_log',minimum:1},dependencies:[],reservationKeys:[]},f.services);
  assert.equal(result.outcome,'completed');assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');assert.equal(resourceTrip(f.services.checkpoint)!.deathId,'actual-new-life');assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);assert.ok(f.services.checkpoint.resourceTripInterruptedLives);assert.equal((f.services.checkpoint.resourceRecovery as {sand:{elapsedMs:number}}).sand.elapsedMs,60000);
});

test('a real intact edge home can start and finish a trip through its fully observed connection',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;const home={x:0,y:64,z:0};
  f.cells.set(new Vec3(-1,63,0).toString(),'air');f.cells.set(new Vec3(-1,62,0).toString(),'air');
  assert.equal(safeResourceStand(f.bot as unknown as Bot,home,()=>false),false);
  const trip=await beginResourceTrip(f.services,'oak_log',40,home);assert.deepEqual(trip.home,home);
  await returnFromResourceTrip(f.services);assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);assert.equal(f.stock.size,0);assert.equal(f.dug.length,0);
});

test('a four-hundred-block food displacement gets one distance-based return allowance while preserving spent resource work',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.confirmedRecoveryDeathId='same-life';
  await beginResourceTrip(f.services,'cobblestone',8);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  f.services.checkpoint.resourceRecovery={sand:{destinationsUsed:5,elapsedMs:60000}};f.bot.entity.position=new Vec3(400.5,64,.5);f.loaded=p=>Math.abs(p.x-f.bot.entity.position.x)<=26&&Math.abs(p.z)<=2;
  await returnFromResourceTrip(f.services);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);assert.equal(resourceTrip(f.services.checkpoint)!.deathId,'same-life');assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');assert.equal(f.stock.size,0);
  const approach=f.services.checkpoint.resourceTripApproach as {moves:number;maxMoves:number;maxElapsedMs:number;origin:{x:number}};assert.equal(approach.origin.x,400);assert.equal(approach.maxMoves,31);assert.equal(approach.maxElapsedMs,260000);assert.equal(f.services.checkpoint.resourceTripInterruptedLives,undefined);assert.equal((f.services.checkpoint.resourceTripDisplacements as unknown[]).length,1);assert.ok((f.services.checkpoint.resourceTripApproach as {moves:number}).moves>12);assert.equal((f.services.checkpoint.resourceRecovery as {sand:{elapsedMs:number}}).sand.elapsedMs,60000);
});

for(const registered of [false,true])test(`a resumed ${registered?'registered':'preset'} foundation lowers its carried target to eight while retaining its original route and budgets`,async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;await beginResourceTrip(f.services,'cobblestone',35);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  f.stock.set('cobblestone',8);f.services.checkpoint.buildStage='foundation';f.services.checkpoint.resourceRecovery={sand:{destinationsUsed:5,elapsedMs:60000}};
  f.executor.options.villageTask=async(_task,s)=>{assert.equal(resourceTrip(s.checkpoint)!.minimum,8);assert.equal(resourceTrip(s.checkpoint)!.phase,'complete');assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);return{outcome:'partial',checkpoint:s.checkpoint,observations:s.observations,evidence:[]};};
  const definition=registered?{...blueprintPreset('warehouse'),id:'128787ca-e9c5-48b9-9e63-76b956839ada',version:1,createdAt:1,updatedAt:1}:undefined;
  const result=await f.executor.execute({id:'small-floor',goalId:'warehouse',kind:'build',params:{materialExpedition:true,blueprint:definition?.id??'warehouse',...(definition?{blueprintDefinition:definition}:{})},completion:{kind:'blocks',blocks:[{position:{x:0,y:64,z:8},name:'cobblestone'}]},dependencies:[],reservationKeys:[]},f.services);
  assert.equal(result.outcome,'partial');assert.equal(f.stock.get('cobblestone'),8);assert.equal(f.dug.length,0);assert.equal((f.services.checkpoint.resourceRecovery as {sand:{elapsedMs:number}}).sand.elapsedMs,60000);assert.equal((f.services.checkpoint.foundationBatchAdjustment as {from:number}).from,35);
});

for(const reason of ['원정의 마지막 도착 위치와 현재 위치 사이의 안전한 연결을 확인해야 합니다.','all source directions genuinely exhausted'])test(`actual home arrival reconciles only an obsolete connection wait even when its saved center is already home: ${reason}`,async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;await beginResourceTrip(f.services,'cobblestone',35);
  const r=new ResourceRecovery(f.bot as unknown as Bot,f.services,'cobblestone',['stone'],true,()=>false);Object.assign(r.state,{status:'exhausted',reason,destinationsUsed:5,elapsedMs:60000,approachesUsed:8,resourceJourney:{center:{x:0,y:64,z:0},visited:[],deadEnds:[],pending:false,moves:12,elapsedMs:1234,status:'blocked'}});
  await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);await returnFromResourceTrip(f.services);
  const saved=(f.services.checkpoint.resourceRecovery as {cobblestone:typeof r.state}).cobblestone;
  const expected=reason.includes('마지막 도착 위치')?'searching':'blocked';assert.equal(saved.resourceJourney!.status,expected);assert.equal(saved.destinationsUsed,5);assert.equal(saved.elapsedMs,60000);assert.equal(saved.approachesUsed,8);assert.equal(saved.resourceJourney!.moves,12);
  saved.status='exhausted';saved.reason=reason;saved.resourceJourney!.status='blocked';await beginResourceTrip(f.services,'cobblestone',35);
  assert.equal(saved.resourceJourney!.status,expected);assert.equal(saved.destinationsUsed,5);assert.equal(saved.elapsedMs,60000);assert.equal(saved.resourceJourney!.moves,12);
});

test('a resumed failed window expedition physically returns before switching to the unfinished warehouse shell',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;
  f.services.checkpoint.resourceTripInterruptedLives=[{item:'glass_pane',failure:'actual previous sand search failed'}];
  await beginResourceTrip(f.services,'glass_pane',3);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  let entered=false;f.executor.options.villageTask=async(_task,s)=>{
    entered=true;assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1.5);
    assert.equal(resourceTrip(s.checkpoint)!.phase,'complete');assert.equal(f.stock.size,0);
    return{outcome:'partial',checkpoint:s.checkpoint,observations:s.observations,evidence:[]};
  };
  const result=await f.executor.execute({id:'build-shell',goalId:'warehouse',kind:'build',params:{materialExpedition:true,design:'warehouse'},completion:{kind:'blocks',blocks:[{position:{x:0,y:64,z:0},name:'cobblestone'},{position:{x:0,y:65,z:0},name:'glass_pane'}]},dependencies:[],reservationKeys:[]},f.services);
  assert.equal(result.outcome,'partial');assert.equal(entered,true);assert.equal(f.dug.length,0);
});

test('nested physical material collection reconnects an older search through the saved trip without refreshing its spent budget',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.materialExpedition=true;f.services.checkpoint.resourceExpedition=true;f.services.checkpoint.confirmedRecoveryDeathId='current-life';
  await beginResourceTrip(f.services,'glass_pane',3);
  const sand=new ResourceRecovery(f.bot as unknown as Bot,f.services,'sand',['sand'],true,()=>false);sand.state.destinationsUsed=5;sand.state.elapsedMs=60000;sand.beginResourceJourney();sand.state.resourceJourney!.moves=7;sand.state.resourceJourney!.elapsedMs=12345;
  for(const x of [24,48,72,96]){await f.services.near({x:x+.5,y:64,z:.5});await recordResourceTripPosition(f.services);}
  f.add(new Vec3(98,64,0),'stone');await f.executor.ensureItem('cobblestone',1,f.services);assert.equal(f.stock.get('cobblestone'),1);
  const restored=new ResourceRecovery(f.bot as unknown as Bot,f.services,'sand',['sand'],true,()=>false),j=restored.state.resourceJourney!;
  assert.deepEqual(j.center,{x:96,y:64,z:0});assert.deepEqual(restored.state.origin,{x:0,y:64,z:0});assert.equal(restored.state.destinationsUsed,5);assert.equal(restored.state.elapsedMs,60000);assert.equal(j.moves,7);assert.equal(j.elapsedMs,12345);assert.equal(j.displacementCount,1);
  const again=new ResourceRecovery(f.bot as unknown as Bot,f.services,'sand',['sand'],true,()=>false);assert.equal(again.state.resourceJourney!.displacementCount,1);
  again.state.resourceJourney!.center={x:0,y:64,z:0};delete f.services.checkpoint.lastResourcePosition;
  assert.deepEqual(new ResourceRecovery(f.bot as unknown as Bot,f.services,'sand',['sand'],true,()=>false).state.resourceJourney!.center,{x:0,y:64,z:0},'movement and timers without actual resource collection do not reanchor a search');
});

for(const spawn of [0,24])test(`a confirmed new life returns to its actual work position without revisiting the prior life expedition end (spawn ${spawn})`,async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.confirmedRecoveryDeathId='prior-life';await beginResourceTrip(f.services,'glass_pane',3);
  for(const x of [24,48]){await f.services.near({x:x+.5,y:64,z:.5});await recordResourceTripPosition(f.services);}
  const prior=resourceTrip(f.services.checkpoint)!;prior.phase='returning';prior.failure='prior source unavailable';f.services.checkpoint.resourceTrip=prior;
  f.services.checkpoint.confirmedRecoveryDeathId='new-life';f.bot.entity.position=new Vec3(spawn+.5,64,.5);const before=f.moved.length;
  f.services.checkpoint.resourceRecovery={sand:{destinationsUsed:5,elapsedMs:60000}};
  await returnFromResourceTrip(f.services);assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');assert.equal(resourceTrip(f.services.checkpoint)!.deathId,'new-life');
  assert.ok(f.moved.slice(before).every(p=>p.x<=spawn+.5),'the new body never walks towards the lost expedition endpoint');
  assert.deepEqual((f.services.checkpoint.resourceTripInterruptedLives as {trail:Position[]}[])[0]!.trail,prior.trail);
  assert.equal((f.services.checkpoint.resourceRecovery as {sand:{elapsedMs:number}}).sand.elapsedMs,60000);assert.equal(f.stock.size,0);
});

for(const newLife of [false,true])test(`a destroyed return support relocates only the staging foot to reachable existing ground and preserves the pinned building (${newLife?'new':'same'} life)`,async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.confirmedRecoveryDeathId='prior';await beginResourceTrip(f.services,'cobblestone',1);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  const area={origin:{x:0,y:64,z:1},width:7,depth:5,height:4};f.services.checkpoint.buildProtection=area;f.services.checkpoint.resourceRecovery={sand:{destinationsUsed:5,elapsedMs:60000}};
  f.cells.set(new Vec3(0,63,0).toString(),'air');f.cells.set(new Vec3(0,62,0).toString(),'air');if(newLife)f.services.checkpoint.confirmedRecoveryDeathId='next';
  await returnFromResourceTrip(f.services);const trip=resourceTrip(f.services.checkpoint)!;
  assert.equal(trip.phase,'complete');assert.notDeepEqual(trip.home,{x:0,y:64,z:0});assert.ok(new Vec3(trip.home.x,trip.home.y,trip.home.z).distanceTo(new Vec3(0,64,0))<=6);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(trip.home.x+.5,trip.home.y,trip.home.z+.5))<1.5);assert.deepEqual(f.services.checkpoint.buildProtection,area);assert.equal(f.cells.get(new Vec3(0,63,0).toString()),'air');assert.equal(f.stock.size,0);
  assert.deepEqual((f.services.checkpoint.resourceTripHomeRelocations as {from:Position}[])[0]!.from,{x:0,y:64,z:0});assert.equal((f.services.checkpoint.resourceRecovery as {sand:{elapsedMs:number}}).sand.elapsedMs,60000);
});

test('a new body outside its loaded home chunk walks verified observed legs before reconnecting the old expedition',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.services.checkpoint.confirmedRecoveryDeathId='prior';await beginResourceTrip(f.services,'oak_door',1);await f.services.near({x:24.5,y:64,z:.5});await recordResourceTripPosition(f.services);
  f.services.checkpoint.confirmedRecoveryDeathId='next';f.bot.entity.position=new Vec3(96.5,64,.5);f.loaded=p=>Math.abs(p.x-f.bot.entity.position.x)<=26&&Math.abs(p.z)<=2;
  f.services.checkpoint.resourceRecovery={sand:{destinationsUsed:5,elapsedMs:60000}};
  assert.equal(f.bot.blockAt(new Vec3(0,63,0)),null);await returnFromResourceTrip(f.services);
  assert.equal(resourceTrip(f.services.checkpoint)!.phase,'complete');assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1.5);
  const approach=f.services.checkpoint.resourceTripApproach as {moves:number;legs:{from:Position;to:Position}[]};assert.ok(approach.moves>=3);assert.ok(approach.legs.every(l=>Math.abs(l.from.x-l.to.x)<=24));
  assert.equal((f.services.checkpoint.resourceRecovery as {sand:{elapsedMs:number}}).sand.elapsedMs,60000);assert.equal(f.stock.size,0);
});

test('confirmed respawn relocates an old resource journey once while preserving original anchor and spent budgets', async () => {
  const f = fixture(); f.bot.health = 20;
  f.services.checkpoint.resourceExpedition = true;
  const before = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  before.state.destinationsUsed = 5; before.state.elapsedMs = 60000;
  assert.equal(before.beginResourceJourney(), true);
  before.state.resourceJourney!.center = { x: 411, y: 64, z: -360 };
  before.state.resourceJourney!.moves = 160; before.state.resourceJourney!.elapsedMs = 700000;
  Object.assign(f.services.checkpoint, before.wait('saved distant journey', 1).checkpoint);
  const recovery = RecoveryStateSchema.parse({ deathId: 'new-life', occurredAt: 1, world: f.launch.rules.world, dimension: 'overworld', priorInventory: [], phase: 'resolved', reason: 'actual respawn', attemptCount: 0, progress: { recoveredCount: 0, remainingCount: 0 }, safe: true, updatedAt: 2, checkpoint: {} });
  reconcileResourceJourneys(f.bot as unknown as Bot, f.services.checkpoint, { ...recovery, safe: false });
  assert.deepEqual(before.state.resourceJourney!.center, { x: 411, y: 64, z: -360 });
  reconcileResourceJourneys(f.bot as unknown as Bot, f.services.checkpoint, recovery);
  const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  assert.deepEqual(restored.state.resourceJourney!.center, { x: 0, y: 64, z: 0 });
  assert.deepEqual(restored.state.origin, { x: 0, y: 64, z: 0 });
  assert.equal(restored.state.destinationsUsed, 5); assert.equal(restored.state.elapsedMs, 60000);
  assert.equal(restored.state.resourceJourney!.moves, 160); assert.equal(restored.state.resourceJourney!.elapsedMs, 700000);
  f.bot.entity.position = new Vec3(120.5,64,0.5);
  reconcileResourceJourneys(f.bot as unknown as Bot, f.services.checkpoint, recovery);
  const unchanged = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  assert.deepEqual(unchanged.state.resourceJourney!.center, { x: 0, y: 64, z: 0 }, 'movement or restart in the same life does not reanchor');
  assert.equal(unchanged.state.resourceJourney!.relocations!.length, 1);
  f.bot.entity.position = new Vec3(0.5,64,0.5); f.add(new Vec3(6,64,0), 'stone');
  await f.executor.ensureItem('cobblestone', 1, f.services);
  assert.equal(f.stock.get('cobblestone'), 1, 'the original task can acquire an actually visible new-life source');
});

test('respawn at the original base still replaces the previous body last-arrival point once',()=>{
 const f=fixture();f.bot.health=20;f.services.checkpoint.resourceExpedition=true;
 const r=new ResourceRecovery(f.bot as unknown as Bot,f.services,'cobblestone',['stone'],true,()=>false);r.state.destinationsUsed=5;r.state.elapsedMs=60000;r.beginResourceJourney();r.state.resourceJourney!.visited=[{x:48,y:64,z:0}];r.state.resourceJourney!.moves=7;r.state.resourceJourney!.elapsedMs=1234;
 f.services.checkpoint.resourceJourneyDeathId='same-base-respawn';
 const recovery=RecoveryStateSchema.parse({deathId:'same-base-respawn',occurredAt:1,world:f.launch.rules.world,dimension:'overworld',priorInventory:[],phase:'resolved',reason:'new body at base',attemptCount:0,progress:{recoveredCount:0,remainingCount:0},safe:true,updatedAt:2,checkpoint:{}});
 reconcileResourceJourneys(f.bot as unknown as Bot,f.services.checkpoint,recovery);
 const after=new ResourceRecovery(f.bot as unknown as Bot,f.services,'cobblestone',['stone'],true,()=>false);assert.deepEqual(after.state.resourceJourney!.visited.at(-1),{x:0,y:64,z:0});assert.equal(after.state.resourceJourney!.moves,7);assert.equal(after.state.resourceJourney!.elapsedMs,1234);assert.equal(after.state.elapsedMs,60000);
});

test('an unreachable exposed source is retained while actual walking discovers and collects another source', async () => {
  const f = fixture(), inaccessible = new Vec3(6, 64, 0), discovered = new Vec3(12, 64, 3);
  f.add(inaccessible, 'stone'); f.add(discovered, 'stone');
  f.loaded = p => !p.equals(discovered) || f.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) > 4;
  f.routeAllowed = p => !(p.x >= 3 && p.x <= 7 && Math.abs(p.z) <= 2);
  await f.executor.ensureItem('cobblestone', 1, f.services);
  assert.equal(f.stock.get('cobblestone'), 1); assert.deepEqual(f.dug, [discovered]); assert.equal(f.cells.get(inaccessible.toString()), 'stone');
  const records = f.services.checkpoint.resourceRecovery as Record<string, { origin: Position; failed: { position: Position }[] }>;
  assert.deepEqual(records.cobblestone.origin, { x: 0, y: 64, z: 0 }); assert.ok(records.cobblestone.failed.some(p => p.position.x === 6));
  assert.ok(f.services.observations.some(o => o.kind === 'exploration' && o.data.resources.some(r => r.position.x === discovered.x)));
});

test('observed empty-collision meadow plants and flowers allow walking while leaves, crops and missing headroom remain protected', () => {
  const p = new Vec3(8, 64, 0);
  for (const name of ['short_grass', 'tall_grass', 'fern', 'large_fern', 'leaf_litter', 'bush', 'firefly_bush', 'short_dry_grass', 'tall_dry_grass','dandelion','orange_tulip','pink_tulip']) {
    const f = fixture(); f.cells.set(p.toString(), name); f.cells.set(p.offset(0, 1, 0).toString(), name);
    assert.equal(safeResourceStand(f.bot as unknown as Bot, p, () => false), true, name);
    f.loaded = q => !q.equals(p.offset(0, 1, 0));
    assert.equal(safeResourceStand(f.bot as unknown as Bot, p, () => false), false);
  }
  for (const name of ['oak_leaves', 'potatoes', 'sweet_berry_bush']) {
    const f = fixture(); f.cells.set(p.toString(), name);
    assert.equal(safeResourceStand(f.bot as unknown as Bot, p, () => false), false, name);
  }
  const solid = fixture(); solid.cells.set(p.toString(), 'short_grass');
  const blockAt = solid.bot.blockAt; solid.bot.blockAt = q => { const b = blockAt(q); return b?.name === 'short_grass' ? { ...b, boundingBox: 'block' } : b; };
  assert.equal(safeResourceStand(solid.bot as unknown as Bot, p, () => false), false, 'plant names cannot override actual collision');
});

test('legacy food waits on actual passable leaf litter resume once while spent budgets and travel remain intact', () => {
  const f=fixture(), legacy=new ResourceRecovery(f.bot as unknown as Bot,f.services,'$food',[],true,()=>false);
  f.cells.set(f.bot.entity.position.floored().toString(),'leaf_litter');
  Object.assign(legacy.state,{foodSearchExpanded:true,destinationsUsed:13,elapsedMs:180000,status:'exhausted',probes:[{position:{x:0,y:64,z:0},name:'leaf_litter'}],foodJourney:{center:{x:0,y:64,z:0},visited:[{x:8,y:64,z:0}],deadEnds:[],pending:false,moves:20,elapsedMs:90000,status:'blocked'}});
  assert.equal(foodSearchCanExpand(f.services.checkpoint),true);
  const resumed=new ResourceRecovery(f.bot as unknown as Bot,f.services,'$food',[],true,()=>false);
  assert.equal(resumed.state.foodJourney!.status,'searching');assert.equal(resumed.state.destinationsUsed,13);assert.equal(resumed.state.elapsedMs,180000);assert.equal(resumed.state.foodJourney!.moves,20);assert.equal(resumed.state.foodJourney!.elapsedMs,90000);assert.deepEqual(resumed.state.foodJourney!.visited,[{x:8,y:64,z:0}]);
  resumed.state.status='exhausted';resumed.state.foodJourney!.status='blocked';
  assert.equal(foodSearchCanExpand(f.services.checkpoint),false,'the compatibility repair is not a timer-based retry');
});

test('legacy food waits on actual passable flowers resume once while spent budgets and travel remain intact', () => {
  const f=fixture(), legacy=new ResourceRecovery(f.bot as unknown as Bot,f.services,'$food',[],true,()=>false);
  f.cells.set(f.bot.entity.position.floored().toString(),'orange_tulip');
  Object.assign(legacy.state,{foodSearchExpanded:true,destinationsUsed:13,elapsedMs:180000,status:'exhausted',probes:[{position:{x:0,y:64,z:0},name:'orange_tulip'}],foodJourney:{center:{x:0,y:64,z:0},visited:[{x:8,y:64,z:0}],deadEnds:[],pending:false,moves:20,elapsedMs:90000,status:'blocked'}});
  assert.equal(foodSearchCanExpand(f.services.checkpoint),true);
  const resumed=new ResourceRecovery(f.bot as unknown as Bot,f.services,'$food',[],true,()=>false);
  assert.equal(resumed.state.foodJourney!.status,'searching');assert.equal(resumed.state.destinationsUsed,13);assert.equal(resumed.state.elapsedMs,180000);assert.equal(resumed.state.foodJourney!.moves,20);assert.equal(resumed.state.foodJourney!.elapsedMs,90000);assert.deepEqual(resumed.state.foodJourney!.visited,[{x:8,y:64,z:0}]);
  resumed.state.status='exhausted';resumed.state.foodJourney!.status='blocked';
  assert.equal(foodSearchCanExpand(f.services.checkpoint),false,'the compatibility repair is not a timer-based retry');
});

test('collection crosses a grassy one-block slope to an actual exposed resource without digging the route vegetation', async () => {
  const f = fixture(), source = new Vec3(8, 65, 0);
  for (let x = -2; x <= 14; x++) for (let z = -5; z <= 5; z++) {
    const y = x >= 4 ? 65 : 64;
    if (y === 65) f.cells.set(new Vec3(x, 64, z).toString(), 'grass_block');
    f.cells.set(new Vec3(x, y, z).toString(), 'short_grass');
  }
  f.add(source, 'stone');
  for (const p of [source.offset(0, 1, 0), source.offset(0, -1, 0), source.offset(0, 0, 1), source.offset(0, 0, -1)]) f.cells.set(p.toString(), p.y === 64 ? 'grass_block' : 'short_grass');
  await f.executor.ensureItem('cobblestone', 1, f.services);
  assert.equal(f.stock.get('cobblestone'), 1); assert.deepEqual(f.dug, [source]);
  assert.ok(f.moved.some(p => p.y === 65));
  assert.equal(f.cells.get(new Vec3(3, 64, 0).toString()), 'short_grass');
});

for(const direction of [-1,1])test(`collection follows observed one-block steps to a resource six blocks ${direction<0?'below':'above'} its starting ground`,async()=>{
  const f=fixture();
  for(let x=-3;x<=26;x++)for(let z=-6;z<=6;z++){
    const feet=64+direction*Math.max(0,Math.min(6,Math.floor(x/2)));
    for(let y=54;y<=75;y++)f.cells.set(new Vec3(x,y,z).toString(),y<feet?(y===feet-1?'grass_block':'dirt'):'air');
  }
  const source=new Vec3(20,64+direction*6,0);f.add(source,'stone');
  const old=new ResourceRecovery(f.bot as unknown as Bot,f.services,'cobblestone',['stone'],true,()=>false);
  old.state.failed=[{position:{x:source.x,y:source.y,z:source.z},name:'stone',reason:'legacy height-based rejection'}];
  await f.executor.ensureItem('cobblestone',1,f.services);
  assert.equal(f.stock.get('cobblestone'),1);assert.deepEqual(f.dug,[source]);
  assert.ok(f.moved.some(p=>Math.abs(p.y-64)>=4));
  for(let i=1;i<f.moved.length;i++)assert.ok(Math.abs(f.moved[i]!.y-f.moved[i-1]!.y)<=1);
  assert.ok((f.services.checkpoint.resourceApproachRechecks as {routeConfirmed:boolean}[]).some(r=>r.routeConfirmed));
  WorkerMessageSchema.parse({ protocolVersion:1,messageId:'source-rechecked',controllerEpoch:'epoch',botId:'bot',sessionId:'session',sentAt:1,type:'task.result',taskId:'task',attemptId:'attempt',payload:{outcome:'partial',checkpoint:f.services.checkpoint,observations:[],evidence:[]} });
});

test('only real movement changes a source approach rejection; route refusals and spent budgets remain intact',()=>{
  const f=fixture(),r=new ResourceRecovery(f.bot as unknown as Bot,f.services,'cobblestone',['stone'],true,()=>false),source=new Vec3(12,64,0),route=new Vec3(16,64,0);
  r.reject(source,'stone','not visible from the actual stand');r.reject(route,'air','unsafe path');r.state.destinationsUsed=5;r.state.elapsedMs=60000;r.state.status='exhausted';
  assert.equal(r.failed(source),true);const restored=new ResourceRecovery(f.bot as unknown as Bot,f.services,'cobblestone',['stone'],true,()=>false);assert.equal(restored.failed(source),true);
  f.bot.entity.position=new Vec3(8.5,64,.5);assert.equal(restored.failed(source),false);assert.equal(restored.failed(route),true);
  assert.equal(restored.state.destinationsUsed,5);assert.equal(restored.state.elapsedMs,60000);assert.equal(restored.canApproach(),false);
});

test('a floating natural upper log is collected from observed ground within eye reach without placing a tower',async()=>{
  const f=fixture(),source=new Vec3(8,68,0);Object.assign(f.bot.registry.itemsByName,{oak_log:{id:3}});f.add(source,'oak_log');f.cells.set(source.offset(0,1,0).toString(),'oak_leaves');
  await f.executor.ensureItem('oak_log',1,f.services);
  assert.equal(f.stock.get('oak_log'),1);assert.deepEqual(f.dug,[source]);assert.ok(f.moved.length>0);assert.ok(f.moved.every(p=>p.y===64));assert.equal(f.cells.get(source.offset(0,1,0).toString()),'oak_leaves');
});

test('actual source-approach arrival advances its material anchor while preserving spent budgets after a rejected harvest',async()=>{
  const f=fixture();f.bot.health=20;const r=new ResourceRecovery(f.bot as unknown as Bot,f.services,'oak_log',['oak_log'],true,()=>false);
  Object.assign(r.state,{destinationsUsed:5,elapsedMs:60000,resourceJourney:{center:{x:0,y:64,z:0},visited:[],deadEnds:[],pending:false,moves:11,elapsedMs:1234,status:'searching'}});
  await r.approach({x:24.5,y:64,z:.5},0);r.reject({x:26,y:64,z:0},'oak_log','not visible from the actual stand');
  assert.deepEqual(r.state.origin,{x:0,y:64,z:0});assert.deepEqual(r.journey!.center,{x:24,y:64,z:0});assert.equal(r.state.approachesUsed,1);assert.equal(r.state.destinationsUsed,5);assert.ok(r.state.elapsedMs>=60000);assert.equal(r.journey!.moves,11);assert.equal(f.stock.size,0);
  f.routeAllowed=p=>p.x>24;assert.equal(await r.move(),true);assert.equal(r.journey!.moves,12);
});

test('resource approaches select an observed clear viewpoint beyond the three nearest occluded stands',async()=>{
  const f=fixture(),source=new Vec3(8,64,0);f.add(source,'stone');f.visible=p=>p.x>=8;
  Object.assign(f.bot,{world:{raycast:(eye:Vec3)=>({position:eye.x>=8?source:new Vec3(4,64,0)})}});
  await f.executor.ensureItem('cobblestone',1,f.services);assert.equal(f.stock.get('cobblestone'),1);assert.deepEqual(f.dug,[source]);assert.ok(f.moved.some(p=>p.x>=8));
});

for(const material of [false,true])test(`only the authorized material stage collects exposed stone from intact observed ledge support (${material})`,async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;
  for(let x=1;x<=12;x++)for(const z of [-1,1])f.cells.set(new Vec3(x,63,z).toString(),'air');
  f.add(new Vec3(8,64,0),'stone');f.services.checkpoint.materialExpedition=material;
  const r=new ResourceRecovery(f.bot as unknown as Bot,f.services,'cobblestone',['stone'],false,()=>false);
  if(material){await r.approach({x:6.5,y:64,z:.5},0);await f.executor.ensureItem('cobblestone',1,f.services);assert.equal(f.stock.get('cobblestone'),1);assert.equal(f.cells.get(new Vec3(6,63,0).toString()),undefined);}
  else{await assert.rejects(r.approach({x:6.5,y:64,z:.5},0),ConditionWait);assert.equal(f.moved.length,0);assert.equal(f.dug.length,0);}
});

for(const observed of [false,true])test(`a public diagonal through two solid corners is replanned around actual clear footholds (${observed?'observed':'strict'})`,()=>{
  const f=fixture();f.cells.set(new Vec3(1,64,0).toString(),'stone');f.cells.set(new Vec3(0,64,1).toString(),'stone');
  f.bot.pathfinder.getPathTo=()=>({status:'success',path:[{x:1,y:64,z:1,toBreak:[],toPlace:[],parkour:false}]});
  Object.assign(f.bot.pathfinder.movements,{getNeighbors(p:Position){return [-1,0,1].flatMap(dx=>[-1,0,1].filter(dz=>dx||dz).map(dz=>({x:p.x+dx,y:64,z:p.z+dz,cost:1,remainingBlocks:0,toBreak:[],toPlace:[],parkour:false}))).filter(q=>Math.abs(q.x)<=3&&Math.abs(q.z)<=3);}});
  const path=observed?observedGroundRoute(f.bot as unknown as Bot,{x:1,y:64,z:1}):safeResourceRoute(f.bot as unknown as Bot,{x:1,y:64,z:1});
  assert.ok(path&&path.length>1);assert.notDeepEqual(path[0],{x:1,y:64,z:1});assert.deepEqual(path.at(-1),{x:1,y:64,z:1});assert.equal(f.cells.get(new Vec3(1,64,0).toString()),'stone');assert.equal(f.moved.length,0);
});

test('an outbound public movement timeout retries the actual route once and continues recording its physical return trail',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;Object.assign(f.bot,{clearControlStates(){},deactivateItem(){}});Object.assign(f.bot.pathfinder,{setGoal(){}});
  let calls=0;f.executor.near=async p=>{if(++calls===1)throw new ConditionWait('20초 동안 목표 위치 1,64,0에 접근하지 못해 이동을 중단했습니다.');f.bot.entity.position=new Vec3(p.x,p.y,p.z);};
  const s=f.executor.services(AbortSignal.timeout(5000),{resourceTrip:{item:'cobblestone',minimum:8,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0}],phase:'outbound',returns:0}});
  await s.near({x:8.5,y:64,z:.5},0);assert.equal(calls,9);assert.ok(f.bot.entity.position.distanceTo(new Vec3(8.5,64,.5))<.1);assert.deepEqual(resourceTrip(s.checkpoint)?.trail.at(-1),{x:8,y:64,z:0});assert.equal(resourceTrip(s.checkpoint)?.phase,'outbound');assert.equal(f.stock.size,0);
});

test('an actual continuous-return timeout retries the reobserved path once with individual steps and credits only the real home arrival',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;await beginResourceTrip(f.services,'cobblestone',8);await f.services.near({x:8.5,y:64,z:.5},0);await recordResourceTripPosition(f.services);
  let continuous=0;f.services.walkVerified=async()=>{continuous++;throw new ConditionWait('20초 동안 목표 위치 0,64,0에 접근하지 못해 이동을 중단했습니다.');};
  await returnFromResourceTrip(f.services);assert.equal(continuous,1);assert.equal(resourceTrip(f.services.checkpoint)?.phase,'complete');assert.equal(resourceTrip(f.services.checkpoint)?.returns,1);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,64,.5))<1);assert.equal(f.stock.size,0);
});

test('a timed-out diagonal return uses a verified clear cardinal corner before passing the adjacent solid wall',async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;await beginResourceTrip(f.services,'cobblestone',8);await f.services.near({x:8.5,y:64,z:.5},0);await recordResourceTripPosition(f.services);f.cells.set(new Vec3(8,64,1).toString(),'stone');
  const original=f.bot.pathfinder.getPathTo.bind(f.bot.pathfinder);
  f.bot.pathfinder.getPathTo=(m,g)=>f.bot.entity.position.floored().equals(new Vec3(8,64,0))&&g.x===0&&g.z===0?{status:'success',path:[...Array.from({length:8},(_,i)=>({x:7-i,y:64,z:1,toBreak:[],toPlace:[],parkour:false})),{x:0,y:64,z:0,toBreak:[],toPlace:[],parkour:false}]}:original(m,g);
  f.services.walkVerified=async()=>{throw new ConditionWait('20초 동안 목표 위치 0,64,0에 접근하지 못해 이동을 중단했습니다.');};const first=f.moved.length;
  await returnFromResourceTrip(f.services);assert.deepEqual(f.moved.slice(first,first+2).map(p=>({x:p.x,y:p.y,z:p.z})),[{x:7.5,y:64,z:.5},{x:7.5,y:64,z:1.5}]);assert.equal(resourceTrip(f.services.checkpoint)?.phase,'complete');assert.equal(f.cells.get(new Vec3(8,64,1).toString()),'stone');
});

test('a trip with a blocked return cannot use source exploration to walk away from its saved home',async()=>{
  const f=fixture();f.services.checkpoint.resourceTrip={item:'cobblestone',minimum:8,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0}],phase:'returning',returns:2};
  const r=new ResourceRecovery(f.bot as unknown as Bot,f.services,'cobblestone',['stone'],true,()=>false);
  await assert.rejects(r.approach({x:8.5,y:64,z:.5}),ConditionWait);await assert.rejects(r.move(),ConditionWait);assert.equal(f.moved.length,0);assert.equal(resourceTrip(f.services.checkpoint)?.returns,2);
});

for(const trip of [false,true])test(`a fully observed utility walk crosses intact ore and an adjacent gap while preserving terrain and return records (${trip?'active trip':'read-only return'})`,async()=>{
  const f=fixture();f.bot.health=20;f.bot.food=20;f.cells.set(new Vec3(4,63,0).toString(),'copper_ore');f.cells.set(new Vec3(5,63,1).toString(),'air');
  Object.assign(f.bot.pathfinder,{async goto(goal:{x:number;y:number;z:number}){f.bot.entity.position=new Vec3(goal.x+.5,goal.y,goal.z+.5);},setGoal(){}});
  const s=f.executor.services(new AbortController().signal,{safeDetourRequired:true,...(trip?{resourceTrip:{item:'cobblestone',minimum:1,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0}],phase:'outbound',returns:0}}:{})});
  await s.near({x:8.5,y:64,z:.5},0);assert.ok(f.bot.entity.position.x>=8);
  if(trip){assert.equal(resourceTrip(s.checkpoint)?.phase,'outbound');assert.deepEqual(resourceTrip(s.checkpoint)?.trail.at(-1),{x:8,y:64,z:0});assert.equal(resourceTrip(s.checkpoint)?.returns,0);}
  assert.equal(f.cells.get(new Vec3(4,63,0).toString()),'copper_ore');assert.equal(f.cells.get(new Vec3(5,63,1).toString()),'air');assert.equal(f.stock.size,0);
});

test('full existing floors are walkable and sand requires observed stable layers beneath it', () => {
  const p = new Vec3(8, 64, 0);
  for (const name of ['cobblestone', 'oak_planks', 'polished_andesite']) {
    const f = fixture(); f.cells.set(p.offset(0, -1, 0).toString(), name);
    assert.equal(safeResourceStand(f.bot as unknown as Bot, p, () => false), true);
    assert.equal(safeResourceStand(f.bot as unknown as Bot, p, q => q.y === 63 && q.x === p.x), false);
  }
  const sand = fixture(); sand.cells.set(p.offset(0, -1, 0).toString(), 'sand'); sand.cells.set(p.offset(0, -2, 0).toString(), 'stone');
  assert.equal(safeResourceStand(sand.bot as unknown as Bot, p, () => false), true);
  sand.cells.set(p.offset(0, -2, 0).toString(), 'air'); assert.equal(safeResourceStand(sand.bot as unknown as Bot, p, () => false), false);
  sand.cells.set(p.offset(0, -2, 0).toString(), 'lava'); assert.equal(safeResourceStand(sand.bot as unknown as Bot, p, () => false), false);
  sand.loaded = q => q.y !== 62; assert.equal(safeResourceStand(sand.bot as unknown as Bot, p, () => false), false);
});

test('real route clearance changes wake exhausted searches but vegetation movement and timestamps do not grant another budget', () => {
  const f = fixture(), blocked = new Vec3(4, 64, 0);
  f.cells.set(blocked.toString(), 'oak_leaves');
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  recovery.sample(blocked); recovery.state.destinationsUsed = 5; recovery.wait('blocked canopy');
  assert.equal(new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false).state.status, 'exhausted');
  f.cells.set(blocked.toString(), 'short_grass');
  const changed = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false); assert.equal(changed.state.destinationsUsed, 0);
  changed.state.destinationsUsed = 5; changed.wait('actual budget exhausted'); f.bot.entity.position.x = 1;
  assert.equal(new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false).state.destinationsUsed, 5);
});

test('critical health food recovery walks to observed ground and harvests a newly loaded crop without hunting', async () => {
  const f = fixture(), crop = new Vec3(12, 64, 3); f.add(crop, 'potatoes'); f.loaded = p => !p.equals(crop) || f.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) > 4;
  await f.executor.ensureFood(f.services); assert.equal(f.stock.get('potato'), 1); assert.deepEqual(f.dug, [crop]);
  assert.ok(f.services.observations.some(o => o.kind === 'exploration')); assert.equal(f.services.checkpoint.resourceRecoveryScope, undefined);
});

test('food recovery broadens its saved search and harvests beyond the first 48-block radius', async () => {
  const f = fixture(), crop = new Vec3(80, 64, 0); f.add(crop, 'potatoes');
  f.loaded = p => !p.equals(crop) || f.bot.entity.position.x > 48;
  await f.executor.ensureFood(f.services);
  assert.equal(f.stock.get('potato'), 1); assert.deepEqual(f.dug, [crop]);
  const state = (f.services.checkpoint.resourceRecovery as Record<string, { foodSearchExpanded?: boolean; origin: Position }>).$food;
  assert.equal(state.foodSearchExpanded, true); assert.deepEqual(state.origin, { x: 0, y: 64, z: 0 });
  assert.ok(f.moved.some(p => p.x > 48)); assert.ok(f.services.observations.some(o => o.kind === 'exploration' && o.data.resources.some(r => r.position.x === 80)));
});

test('blocked outward food routes fall back to safe unvisited directions without spending walking attempts on route probes', async () => {
  const f = fixture(); f.bot.entity.position = new Vec3(16.5, 64, 0.5);
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false);
  recovery.state.origin = { x: 0, y: 64, z: 0 }; recovery.state.visited = [{ x: 16, y: 64, z: 0 }]; recovery.state.destinationsUsed = 1;
  f.routeAllowed = p => Math.hypot(p.x, p.z) < 20;
  assert.equal(await recovery.move(), true); assert.equal(recovery.state.destinationsUsed, 2);
  assert.ok(f.moved.length === 1 && Math.hypot(f.moved[0]!.x, f.moved[0]!.z) < 20);
  assert.ok(recovery.state.failed.length > 0);
});

test('the expanded food search retains its finite totals through clocks, restarts and repeated expansion requests', async () => {
  const f = fixture(); let clock = 0;
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false, () => clock);
  recovery.state.destinationsUsed = 5; recovery.state.elapsedMs = 61000; recovery.wait('local food search failed');
  assert.equal(foodSearchCanExpand(f.services.checkpoint), true); assert.equal(recovery.expandFoodSearch(), true);
  assert.equal(recovery.state.destinationsUsed, 5); assert.equal(recovery.state.elapsedMs, 61000); assert.equal(recovery.radius, 96);
  for (let count = 5; count < 13; count++) assert.equal(await recovery.move(), true);
  assert.equal(recovery.state.destinationsUsed, 13); assert.equal(await recovery.move(), false); recovery.wait('expanded search failed');
  for (let i = 0; i < 3; i++) {
    clock += 100000; f.bot.entity.position.x += 0.01;
    const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false, () => clock);
    assert.equal(foodSearchCanExpand(f.services.checkpoint), true, 'the distinct long-distance journey is still unused'); assert.equal(restored.expandFoodSearch(), false);
    assert.equal(restored.state.destinationsUsed, 13); assert.equal(restored.state.elapsedMs, 61000); assert.equal(await restored.move(), false);
    assert.deepEqual(restored.state.origin, { x: 0, y: 64, z: 0 });
  }
});

test('food recovery travels beyond 192 blocks through newly observed local terrain without renewing the exhausted near-search budget', async () => {
  const f = fixture(), crop = new Vec3(256, 64, 0);
  f.add(crop, 'potatoes');
  f.loaded = p => p.distanceTo(f.bot.entity.position) < 26 && Math.abs(p.z) <= 12;
  const near = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false);
  near.expandFoodSearch(); near.state.destinationsUsed = 13; near.state.elapsedMs = 180000; near.wait('near search spent');
  f.bot.entity.position = new Vec3(96.5, 64, 0.5);
  await f.executor.ensureFood(f.services);
  const search = (f.services.checkpoint.resourceRecovery as Record<string, ResourceRecovery['state']>).$food;
  assert.ok(search.foodJourney && search.foodJourney.moves > 13);
  assert.deepEqual(search.origin, { x: 0, y: 64, z: 0 }); assert.equal(f.stock.get('potato'), 1); assert.deepEqual(f.dug, [crop]);
  assert.ok(f.moved.some(p => p.x > 192)); assert.ok(search.foodJourney.visited.some(p => p.x > 192));
  assert.ok(f.services.observations.some(o => o.kind === 'exploration' && o.data.resources.some(r => r.position.x === 256)));
});

test('an explicit collection task resumes an exhausted search from the current region and collects distant observed stone', async () => {
  const f = fixture(), source = new Vec3(280, 64, 0); f.add(source, 'stone');
  f.loaded = p => p.distanceTo(f.bot.entity.position) < 26 && Math.abs(p.z) <= 12;
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  recovery.state.destinationsUsed = 5; recovery.state.elapsedMs = 60000; recovery.wait('old local search exhausted', 1);
  f.bot.entity.position = new Vec3(120.5,64,0.5);
  const result = await f.executor.execute({ id: 'collect', goalId: 'goal', kind: 'collect', params: { item: 'cobblestone', quantity: 1 }, dependencies: [], reservationKeys: [], completion: { kind: 'manual', reason: 'observed inventory delta' } }, f.services);
  assert.equal(result.outcome, 'completed'); assert.equal(f.stock.get('cobblestone'), 1); assert.deepEqual(f.dug, [source]);
  const state = (f.services.checkpoint.resourceRecovery as Record<string, ResourceRecovery['state']>).cobblestone;
  assert.deepEqual(state.origin, { x: 0, y: 64, z: 0 }); assert.ok(state.resourceJourney && state.resourceJourney.moves > 5);
  assert.ok(f.moved.some(p => p.x > 192)); assert.equal(f.services.checkpoint.resourceExpedition, true);
});

test('resource expeditions require an explicit collection scope and retain spent local counts when a new leg is saved', async () => {
  const f = fixture(), recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  recovery.state.destinationsUsed = 5; recovery.state.elapsedMs = 60000; recovery.wait('local search exhausted', 1);
  assert.equal(recovery.beginResourceJourney(), false);
  f.services.checkpoint.resourceExpedition = true; assert.equal(recovery.beginResourceJourney(), true);
  assert.equal(await recovery.move(), true); assert.equal(recovery.state.destinationsUsed, 5); assert.equal(recovery.state.elapsedMs, 60000);
  const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  assert.equal(restored.state.resourceJourney!.moves, 1); assert.equal(restored.beginResourceJourney(), false);
  assert.equal(restored.state.destinationsUsed, 5); assert.equal(restored.state.elapsedMs, 60000);
});

test('a travelling food checkpoint restores its route history and counters while each next hop uses current loaded terrain', async () => {
  const f = fixture(); f.loaded = p => p.distanceTo(f.bot.entity.position) < 26 && Math.abs(p.z) <= 12;
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false, () => 0);
  recovery.expandFoodSearch(); recovery.state.destinationsUsed = 13; recovery.state.elapsedMs = 180000;
  assert.equal(recovery.beginFoodJourney(), true);
  for (let i = 0; i < 60; i++) assert.equal(await recovery.move(), true);
  const before = structuredClone(recovery.state);
  const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false, () => 999999);
  assert.deepEqual(restored.state, before); assert.equal(restored.state.destinationsUsed, 13); assert.equal(restored.state.elapsedMs, 180000);
  assert.equal(await restored.move(), true); assert.equal(restored.state.foodJourney!.moves, 61);
  assert.ok(Math.hypot(restored.state.foodJourney!.center.x, restored.state.foodJourney!.center.z) > 192); assert.equal(new Set(restored.state.foodJourney!.visited.map(p => `${p.x},${p.y},${p.z}`)).size, restored.state.foodJourney!.visited.length);
  restored.pauseFoodJourney(); assert.equal(await restored.move(), false); restored.wait('paused');
  assert.equal(foodSearchCanExpand(f.services.checkpoint), true); assert.equal(restored.beginFoodJourney(), true); assert.equal(restored.state.foodJourney!.moves, 61);
});

test('a dead-end food route backtracks along confirmed waypoints and explores another branch', async () => {
  const f = fixture();
  f.loaded = p => p.x >= -4 && p.x <= 84 && Math.abs(p.z) <= 4 || Math.abs(p.x) <= 4 && p.z >= 0 && p.z <= 40;
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false);
  recovery.expandFoodSearch(); f.bot.entity.position = new Vec3(80.5, 64, 0.5); recovery.beginFoodJourney();
  recovery.state.foodJourney!.visited = Array.from({ length: 11 }, (_, i) => i * 8).flatMap(x => [-3, 0].map(z => ({ x, y: 64, z })));
  for (let i = 0; i < 48 && recovery.state.foodJourney!.center.z < 24; i++) assert.equal(await recovery.move(), true);
  assert.ok(recovery.state.foodJourney!.center.z >= 24);
  assert.ok(recovery.state.foodJourney!.deadEnds.some(p => p.x >= 64));
  assert.ok(f.moved.some(p => p.x > 0 && p.x < 48));
});

test('a food journey blocked on every observed route waits without restarting from clock ticks', async () => {
  const f = fixture(); f.routeAllowed = () => false;
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false);
  recovery.expandFoodSearch(); assert.equal(recovery.beginFoodJourney(), true);
  assert.equal(await recovery.move(), false); recovery.wait('no reachable food frontier');
  const before = structuredClone(recovery.state);
  for (let i = 0; i < 3; i++) {
    const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false, () => 100000 * (i + 1));
    assert.deepEqual(restored.state, before); assert.equal(foodSearchCanExpand(f.services.checkpoint), false); assert.equal(await restored.move(), false);
  }
});

test('food exploration does not approach hostiles and cannot expand without exploration permission', async () => {
  const f = fixture();
  const bot = f.bot as unknown as Bot;
  const enemyPosition = new Vec3(8, 64, 0);
  bot.entities[2] = { id: 2, name: 'zombie', position: enemyPosition } as unknown as Bot['entities'][number];
  const recovery = new ResourceRecovery(bot, f.services, '$food', ['potatoes'], true, () => false);
  if (await recovery.move()) assert.ok(f.moved.every(p => p.distanceTo(enemyPosition) >= 12));
  const disabled = new ResourceRecovery(bot, f.services, '$food', ['potatoes'], false, () => false);
  assert.equal(disabled.expandFoodSearch(), false);
});

test('a real threat leaving a watched food route restores its search while unchanged threats do not', () => {
  const f = fixture(), bot = f.bot as unknown as Bot, p = new Vec3(8, 64, 0);
  bot.entities[2] = { id: 2, name: 'zombie', position: p } as unknown as Bot['entities'][number];
  const recovery = new ResourceRecovery(bot, f.services, '$food', ['potatoes'], true, () => false);
  recovery.expandFoodSearch(); recovery.sample(p); recovery.state.destinationsUsed = 13; recovery.wait('hostile blocks food access');
  assert.equal(new ResourceRecovery(bot, f.services, '$food', ['potatoes'], true, () => false).state.status, 'exhausted');
  delete bot.entities[2];
  const cleared = new ResourceRecovery(bot, f.services, '$food', ['potatoes'], true, () => false);
  assert.equal(cleared.state.status, 'searching'); assert.equal(cleared.state.destinationsUsed, 0); assert.equal(cleared.state.foodSearchExpanded, true);
});

test('five failed destinations exhaust the same checkpoint and timestamps, own movement or unload grant no new budget', async () => {
  const f = fixture(); for (let x = 10; x < 23; x++) for (let z = 10; z < 15; z++) f.add(new Vec3(x, 64, z), 'stone'); f.routeAllowed = () => false;
  let clock = 0; const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone', 'cobblestone'], true, () => false, () => clock);
  assert.equal(await recovery.move(), false); assert.equal(recovery.state.destinationsUsed, 5); const wait = recovery.wait('blocked', 1);
  for (let n = 0; n < 10; n++) { clock += 100000; f.bot.entity.position.x += 0.01; const next = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone', 'cobblestone'], true, () => false, () => clock); assert.equal(next.state.destinationsUsed, 5); assert.equal(await next.move(), false); }
  f.loaded = () => false; assert.equal(new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone', 'cobblestone'], true, () => false).state.status, 'exhausted');
  assert.ok((wait.checkpoint.resourcePositions as unknown[]).length <= 64); assert.deepEqual(wait.checkpoint.resourceNames, ['stone', 'cobblestone']);
  WorkerMessageSchema.parse({ protocolVersion: 1, messageId: 'result', controllerEpoch: 'epoch', botId: 'bot', sessionId: 'session', sentAt: 1, type: 'task.result', taskId: 'task', attemptId: 'attempt', payload: { outcome: 'condition-wait', reason: wait.message, checkpoint: wait.checkpoint, observations: [], evidence: [] } });
});

test('a newly observed related source restores a bounded budget without moving the original anchor', async () => {
  const f = fixture(), recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  recovery.state.destinationsUsed = 5; recovery.wait('empty', 1); f.bot.entity.position.x = 8; f.add(new Vec3(12, 64, 3), 'stone');
  const changed = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  assert.equal(changed.state.destinationsUsed, 0); assert.deepEqual(changed.state.origin, { x: 0, y: 64, z: 0 });
});

test('search time is charged across checkpoint resumes and the running move is the final bounded attempt', async () => {
  const f = fixture(); let clock = 0; f.services.near = async () => { clock += 21000; throw new ConditionWait('NoPath'); };
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => clock);
  assert.equal(await recovery.move(), false); assert.equal(recovery.state.destinationsUsed, 3); assert.equal(recovery.state.elapsedMs, 63000); recovery.wait('timed out');
  const resumed = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => clock); assert.equal(await resumed.move(), false); assert.equal(resumed.state.elapsedMs, 63000);
});

test('unobserved, hazardous, cliff and protected destinations never become exploration moves', async () => {
  for (const bad of ['unknown', 'water', 'lava', 'cliff', 'protected']) {
    const f = fixture(), p = new Vec3(8, 64, 0);
    if (bad === 'unknown') f.loaded = q => !q.equals(p);
    if (bad === 'water' || bad === 'lava') f.cells.set(p.toString(), bad);
    if (bad === 'cliff') { f.cells.set(p.offset(1, -1, 0).toString(), 'air'); f.cells.set(p.offset(1, -2, 0).toString(), 'air'); }
    assert.equal(safeResourceStand(f.bot as unknown as Bot, p, q => bad === 'protected' && q.x === p.x), false);
  }
  const f = fixture(); f.executor.options.config.allowedActions = ['collect'];
  await assert.rejects(f.executor.ensureItem('cobblestone', 1, f.services), ConditionWait); assert.deepEqual(f.moved, []); assert.deepEqual(f.dug, []);
});

test('unknown navigation effects and cancellation propagate without exploration or consuming another candidate', async () => {
  for (const code of ['UNKNOWN', 'CANCELLED']) {
    const f = fixture(); f.add(new Vec3(2, 64, 0), 'stone'); f.services.near = async () => { throw new ActionFailure('uncertain', code, false, code === 'CANCELLED'); };
    await assert.rejects(f.executor.ensureItem('cobblestone', 1, f.services), error => error instanceof ActionFailure && error.code === code); assert.deepEqual(f.dug, []); assert.equal(f.services.observations.length, 0);
  }
  const f = fixture(); Object.assign(f.bot.pathfinder, { setGoal() {}, async goto() { throw new ActionFailure('movement effect unknown', 'UNKNOWN', false, false); } });
  await assert.rejects(f.executor.near({ x: 8, y: 64, z: 0 }, new AbortController().signal), error => error instanceof ActionFailure && error.code === 'UNKNOWN');
});

test('blocked sight tries distinct observed stand positions before rejecting the whole source', async () => {
  const f = fixture(); f.add(new Vec3(2, 64, 0), 'stone'); f.visible = p => p.x > 0.6;
  await f.executor.ensureItem('cobblestone', 1, f.services); assert.equal(f.stock.get('cobblestone'), 1); assert.ok(f.moved.length >= 2); assert.notDeepEqual(f.moved[0], f.moved[1]);
});

test('the 128 concealed-candidate cap still performs bounded exploration and returns a valid resource wait', async () => {
  const f = fixture();
  for (let x = 19; x <= 34; x++) for (let z = -1; z <= 11; z++) for (let y = 63; y <= 66; y++) f.cells.set(new Vec3(x, y, z).toString(), 'stone');
  for (let x = 20; x < 33; x++) for (let z = 0; z < 10; z++) f.sources.push(new Vec3(x, 64, z));
  await assert.rejects(f.executor.ensureItem('cobblestone', 1, f.services), error => {
    assert.ok(error instanceof ConditionWait); assert.equal(error.checkpoint.missingResource, 'cobblestone'); assert.deepEqual(error.checkpoint.resourceNames, ['stone', 'cobblestone']); assert.ok((error.checkpoint.resourcePositions as unknown[]).length <= 64); return true;
  });
  assert.ok(f.services.observations.some(o => o.kind === 'exploration')); assert.deepEqual(f.dug, []);
  const state = (f.services.checkpoint.resourceRecovery as Record<string, { destinationsUsed: number }>).cobblestone; assert.ok(state.destinationsUsed <= 5);
});

test('fresh crop maturity and loaded collision observations are required immediately before digging', async () => {
  const f = fixture(), crop = new Vec3(2, 64, 0); f.add(crop, 'potatoes');
  const original = f.bot.blockAt; let age = 7;
  f.bot.blockAt = p => { const b = original(p); return b?.name === 'potatoes' ? { ...b, getProperties: () => ({ age }) } : b; };
  f.services.near = async p => { f.bot.entity.position = new Vec3(p.x, p.y, p.z); age = 0; };
  await assert.rejects(f.executor.ensureItem('potato', 1, f.services), ConditionWait); assert.deepEqual(f.dug, []);
  const unknown = fixture(); unknown.add(new Vec3(2, 64, 0), 'stone'); unknown.loaded = p => p.y !== 63;
  await assert.rejects(unknown.executor.ensureItem('cobblestone', 1, unknown.services), ConditionWait); assert.deepEqual(unknown.moved, []); assert.deepEqual(unknown.dug, []);
});

test('an actually observed blocked route cell is watched and its hazard removal restores the exhausted budget', async () => {
  const f = fixture(), hazard = new Vec3(4, 64, 0), originalPath = f.bot.pathfinder.getPathTo;
  f.cells.set(hazard.toString(), 'lava');
  f.bot.pathfinder.getPathTo = (movements, goal) => {
    // A public path result can precede a server block update. Recovery must
    // recheck actual route cells, rather than trusting that older result.
    f.cells.delete(hazard.toString()); const path = originalPath(movements, goal); f.cells.set(hazard.toString(), 'lava'); return path;
  };
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  await assert.rejects(recovery.approach(new Vec3(8.5, 64, 0.5)), ConditionWait); recovery.state.destinationsUsed = 5;
  const wait = recovery.wait('blocked route'); assert.ok((wait.checkpoint.resourcePositions as Position[]).some(p => p.x === hazard.x && p.y === hazard.y && p.z === hazard.z)); assert.equal(f.moved.length, 0);
  f.cells.delete(hazard.toString()); f.bot.pathfinder.getPathTo = originalPath;
  const changed = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  assert.equal(changed.state.destinationsUsed, 0); assert.equal(await changed.move(), true);
});

test('a filtered immature crop is exactly watched without exploration permission and actual maturity resumes collection', async () => {
  const f = fixture(), crop = new Vec3(2, 64, 0); f.add(crop, 'potatoes'); f.ages.set(crop.toString(), 0); f.executor.options.config.allowedActions = ['collect'];
  await assert.rejects(f.executor.ensureItem('potato', 1, f.services), error => {
    assert.ok(error instanceof ConditionWait); const wait = error.checkpoint.waitingFor as { resourcePositions: Position[] };
    assert.ok(wait.resourcePositions.some(p => p.x === crop.x && p.y === crop.y && p.z === crop.z)); return true;
  });
  assert.equal(f.dug.length, 0); assert.equal(f.moved.length, 0);
  f.ages.set(crop.toString(), 7); await f.executor.ensureItem('potato', 1, f.services); assert.equal(f.stock.get('potato'), 1);
});

test('eight failed approaches leave the remaining exploration moves usable and arrival opens a new stand budget', async () => {
  const f = fixture(), destination = new Vec3(8.5, 64, 0.5);
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  const near = f.services.near; f.services.near = async () => { throw new ConditionWait('NoPath'); };
  for (let n = 0; n < 8; n++) await assert.rejects(recovery.approach(destination), ConditionWait);
  await assert.rejects(recovery.approach(destination), ConditionWait);
  assert.equal(recovery.state.approachesUsed, 8); assert.equal(recovery.state.status, 'searching'); assert.equal(recovery.state.destinationsUsed, 0);
  f.services.near = near;
  assert.equal(await recovery.move(), true); assert.equal(recovery.state.destinationsUsed, 1); assert.equal(recovery.state.approachesUsed, 0);
});

test('a source stand loop that reaches eight failures still walks and collects the newly observed source', async () => {
  const f = fixture(), discovered = new Vec3(12, 64, 5);
  for (const x of [6, 8, 10]) f.add(new Vec3(x, 64, 0), 'stone'); f.add(discovered, 'stone');
  f.loaded = p => !p.equals(discovered) || f.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) > 4;
  let failedApproaches = 0;
  f.routeAllowed = p => { if (p.x >= 3 && p.x <= 12 && Math.abs(p.z) <= 2) { failedApproaches++; return false; } return true; };
  await f.executor.ensureItem('cobblestone', 1, f.services);
  assert.equal(failedApproaches, 8); assert.equal(f.stock.get('cobblestone'), 1); assert.deepEqual(f.dug, [discovered]);
  assert.ok(f.services.observations.some(o => o.kind === 'exploration'));
});

test('only the exact premature-exhaustion checkpoint regains its remaining moves without resetting origin or budgets', async () => {
  const reason = '자원 접근 예산을 소진했습니다. 실제 자원이나 접근 지형의 변화를 기다립니다.';
  for (const [destinationsUsed, elapsedMs, approachesUsed, checkpointReason, expected] of [[2, 1791, 8, reason, 'searching'], [5, 1791, 8, reason, 'exhausted'], [2, 60000, 8, reason, 'exhausted'], [2, 1791, 7, reason, 'exhausted'], [2, 1791, 8, 'actual search exhausted', 'exhausted']] as const) {
    const f = fixture(), recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 1);
    recovery.state.visited = [{ x: 8, y: 64, z: 0 }, { x: 16, y: 64, z: 0 }]; recovery.state.destinationsUsed = destinationsUsed; recovery.state.elapsedMs = elapsedMs; recovery.state.approachesUsed = approachesUsed; recovery.state.reason = checkpointReason;
    recovery.wait(checkpointReason, 1); const before = JSON.parse(JSON.stringify(recovery.state));
    f.bot.entity.position = new Vec3(16.5, 64, 0.5);
    const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 1);
    assert.deepEqual(restored.state, { ...before, status: expected, ...(expected === 'searching' ? { approachBudgetRepairApplied: true } : {}) });
    if (expected === 'searching') {
      assert.equal(await restored.move(), true); assert.equal(restored.state.destinationsUsed, 3); assert.equal(restored.state.elapsedMs, 1791); assert.equal(restored.state.approachesUsed, 0); assert.equal(restored.state.visited.length, 3);
      assert.deepEqual(restored.state.origin, { x: 0, y: 64, z: 0 });
    } else assert.equal(await restored.move(), false);
  }
});

test('a migrated checkpoint with no safe destination is repaired only once across repeated checkpoint restores', async () => {
  const f = fixture(), reason = '자원 접근 예산을 소진했습니다. 실제 자원이나 접근 지형의 변화를 기다립니다.';
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 1);
  recovery.state.visited = [{ x: 8, y: 64, z: 0 }, { x: 16, y: 64, z: 0 }]; recovery.state.destinationsUsed = 2; recovery.state.approachesUsed = 8; recovery.state.elapsedMs = 1791; recovery.wait(reason, 1);
  f.bot.entity.position = new Vec3(16.5, 64, 0.5); f.loaded = p => Math.abs(p.x - 16) <= 2 && Math.abs(p.z) <= 2;
  const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 1);
  assert.equal(restored.state.status, 'searching'); assert.equal(await restored.move(), false);
  const result = restored.wait(reason, 1);
  WorkerMessageSchema.parse({ protocolVersion: 1, messageId: 'repaired-result', controllerEpoch: 'epoch', botId: 'bot', sessionId: 'session', sentAt: 1, type: 'task.result', taskId: 'task', attemptId: 'attempt', payload: { outcome: 'condition-wait', checkpoint: result.checkpoint } });
  for (let n = 0; n < 5; n++) {
    const next = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 100000 + n);
    assert.equal(next.state.status, 'exhausted'); assert.equal(next.state.approachBudgetRepairApplied, true); assert.equal(next.state.destinationsUsed, 2); assert.equal(next.state.approachesUsed, 8); assert.equal(next.state.elapsedMs, 1791); assert.equal(next.state.visited.length, 2); assert.deepEqual(next.state.origin, { x: 0, y: 64, z: 0 }); assert.equal(await next.move(), false);
  }
});

function displacedFoodRecovery(f: ReturnType<typeof fixture>, canExplore = true, protectedPosition: (p: Position) => boolean = () => false) {
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], canExplore, protectedPosition);
  Object.assign(recovery.state, { origin: { x: 80, y: 64, z: 0 }, visited: [{ x: 72, y: 64, z: 0 }], destinationsUsed: 5, approachesUsed: 3, elapsedMs: 180069, foodSearchExpanded: true, status: 'exhausted', reason: '원정의 마지막 도착 위치와 현재 위치 사이의 안전한 연결을 확인해야 합니다.', foodJourney: { center: { x: 80, y: 64, z: 0 }, visited: [{ x: 80, y: 64, z: 0 }], deadEnds: [{ x: 88, y: 64, z: 0 }], moves: 61, elapsedMs: 1539, pending: false, status: 'blocked' } });
  return recovery;
}

test('food search displaced beyond its saved observation area resumes from actual stable ground while retaining all spent budgets and history', async () => {
  const f = fixture(), recovery = displacedFoodRecovery(f), before = structuredClone(recovery.state);
  assert.equal(foodSearchCanExpand(f.services.checkpoint, f.bot as unknown as Bot), true);
  assert.equal(await recovery.reanchorFoodJourney(), true);
  assert.deepEqual(recovery.state.origin, before.origin); assert.deepEqual(recovery.state.visited, before.visited);
  for (const field of ['destinationsUsed', 'approachesUsed', 'elapsedMs'] as const) assert.equal(recovery.state[field], before[field]);
  const journey = recovery.state.foodJourney!;
  assert.equal(journey.moves, 61); assert.equal(journey.elapsedMs, 1539); assert.deepEqual(journey.deadEnds, before.foodJourney!.deadEnds);
  assert.deepEqual(journey.visited[0], { x: 80, y: 64, z: 0 }); assert.deepEqual(journey.center, { x: 0, y: 64, z: 0 });
  assert.deepEqual(journey.displacements, [{ from: { x: 80, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 } }]);
  assert.equal(journey.displacementCount, 1); assert.equal(f.moved.length, 0, 'reconciliation never invents walking back to an old waypoint');
  recovery.wait('no food source yet');
  for (let i = 0; i < 4; i++) {
    const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false, () => 1000000 * (i + 1));
    assert.equal(await restored.reanchorFoodJourney(), false); assert.equal(foodSearchCanExpand(f.services.checkpoint, f.bot as unknown as Bot), false);
    assert.equal(restored.state.foodJourney!.displacementCount, 1); assert.equal(restored.state.elapsedMs, before.elapsedMs);
  }
});

for (const condition of ['hostile', 'unloaded', 'falling', 'dead', 'protected', 'no-explore', 'paused'] as const) test(`displaced food search preserves its blocked anchor when ${condition} prevents verified relocation`, async () => {
  const f = fixture(), recovery = displacedFoodRecovery(f, condition !== 'no-explore', () => condition === 'protected');
  if (condition === 'hostile') Object.assign(f.bot.entities, { 7: { id: 7, name: 'zombie', position: new Vec3(4,64,0) } });
  if (condition === 'unloaded') f.loaded = () => false;
  if (condition === 'falling') f.bot.entity.position = new Vec3(.5,64.4,.5);
  if (condition === 'dead') f.bot.health = 0;
  if (condition === 'paused') recovery.state.foodJourney!.status = 'paused';
  const before = structuredClone(recovery.state);
  assert.equal(await recovery.reanchorFoodJourney(), false); assert.deepEqual(recovery.state, before); assert.equal(f.moved.length, 0);
});

test('a moving body cannot certify the current food-search landing and raw-material return paths remain strict', async () => {
  const f = fixture(), food = displacedFoodRecovery(f), before = structuredClone(food.state);
  f.services.pause = async () => { f.bot.entity.position = f.bot.entity.position.offset(.2,0,0); };
  assert.equal(await food.reanchorFoodJourney(), false); assert.deepEqual(food.state, before);
  const resource = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'sand', ['sand'], true, () => false);
  resource.state.resourceJourney = structuredClone(before.foodJourney)!; resource.state.resourceJourney.center = { x: 80, y: 64, z: 0 };
  const old = structuredClone(resource.state); assert.equal(await resource.reanchorFoodJourney(), false); assert.deepEqual(resource.state, old);
});

test('a critical displaced food episode actually harvests a nearby crop outside its old observation area', async () => {
  const f = fixture(), old = displacedFoodRecovery(f); f.bot.health = 1; f.bot.food = 16;
  f.add(new Vec3(4,64,0), 'potatoes');
  await f.executor.ensureFood(f.services);
  assert.ok((f.stock.get('potato') ?? 0) > 0); assert.equal(f.cells.get(new Vec3(4,64,0).toString()), 'air');
  const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, '$food', ['potatoes'], true, () => false);
  assert.equal(restored.state.foodJourney!.displacementCount, 1); assert.equal(restored.state.foodJourney!.moves, 61);
  assert.deepEqual(restored.state.origin, old.state.origin); assert.equal(f.bot.health, 1, 'harvesting does not fabricate healing');
});
