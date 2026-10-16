import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, WorkerMessageSchema, type BaseShelter, type ContainerRef, type JsonObject, type ObservationInput, type ResultPayload, type RecoveryState, type SurvivalRecovery, type TaskSpec, type WorkerMessage } from '../packages/contracts/src';
import { MinecraftWorker } from '../packages/minecraft/src/worker';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { foodRecoveryFingerprint, type FoodRecoveryKnowledge } from '../packages/minecraft/src/worker-recovery';
import { ConditionWait, type ActionServices } from '../packages/minecraft/src/services';
import { ResourceRecovery } from '../packages/minecraft/src/resource-recovery';

function fixture(options: { health?: number; food?: number; restore?: SurvivalRecovery; recovery?: RecoveryState; warehouse?: ContainerRef; baseShelter?: BaseShelter; ensureFood?(s: ActionServices): Promise<void> } = {}) {
  const events = new EventEmitter(), messages: WorkerMessage[] = [], items: { name: string; count: number }[] = [];
  let now = Date.now(), executions = 0, foodAttempts = 0, foodRunning = false, overlap = false, retreats = 0, warehouseObservations = 0;
  const cells = new Map<string, { name: string; age?: number }>(), warehouseItems: { name: string; count: number }[] = [];
  const launch = WorkerLaunchSchema.parse({ botId: 'health', sessionId: 'session', controllerEpoch: 'epoch', config: { name: 'HealthWorker' }, rules: { world: '127.0.0.1:25566', warehouse: options.warehouse ?? null, baseShelter: options.baseShelter ?? null }, ...(options.restore ? { restoreSurvivalRecovery: options.restore } : {}),...(options.recovery?{restoreRecovery:options.recovery}:{}) });
  const bot = Object.assign(events, { health: options.health ?? 20, food: options.food ?? 20, game: { dimension: 'overworld' }, entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {} as Record<number, Entity>, players: {},
    inventory: { items: () => items, slots: Array.from({ length: 46 }, () => null) },
    pathfinder: { setGoal() {}, setMovements() {}, thinkTimeout: 0 }, findBlocks() { return []; },
    blockAt(p: Vec3) { const cell = cells.get(`${p.x},${p.y},${p.z}`); return cell ? { name: cell.name, position: p, getProperties: () => cell.age === undefined ? {} : { age: cell.age } } : null; },
    clearControlStates() {}, deactivateItem() {}, stopDigging() {}, quit(reason: string) { events.emit('end', reason); },
  }) as unknown as Bot;
  class Executor extends MineflayerExecutor {
    override canObserveContainerHere(container:ContainerRef):boolean{return bot.entity.position.distanceTo(new Vec3(container.position.x,container.position.y,container.position.z))<=4;}
    override async ensureFood(s: ActionServices): Promise<void> { foodAttempts++; foodRunning = true; try { if (options.ensureFood) await options.ensureFood(s); else throw new ConditionWait('실제 식량이 없습니다.'); } finally { foodRunning = false; } }
    override async eat(): Promise<boolean> { const bread = items.find(item => item.name === 'bread' && item.count > 0); if (!bread) return false; bread.count--; if (!bread.count) items.splice(items.indexOf(bread), 1); bot.food = Math.min(20, bot.food + 5); return true; }
    override async execute(_task: TaskSpec, s: ActionServices): Promise<ResultPayload> { executions++; overlap ||= foodRunning; s.checkpoint.step = 7; await s.pause(120000); throw new Error('fixture timeout'); }
    override async retreat(_target: Entity, s: ActionServices): Promise<void> { retreats++; await s.pause(120000); }
    override async observeContainer(container: ContainerRef, s: ActionServices): Promise<ObservationInput> { warehouseObservations++; const observation: ObservationInput = { id: randomUUID(), observedAt: now, world: launch.rules.world, dimension: 'overworld', kind: 'container', data: { container, items: warehouseItems.map(item => ({ ...item })) } }; s.observations.push(observation); return observation; }
  }
  const worker = new MinecraftWorker(launch, bot, message => { WorkerMessageSchema.parse(message); messages.push(message); }, { timers: false, now: () => now, movementsFactory: () => ({}) as Movements, executorFactory: (bot, config) => new Executor(bot, config) });
  const task: TaskSpec = { id: 'build', goalId: 'goal', kind: 'build', params: {}, completion: { kind: 'manual', reason: 'actual building' }, dependencies: [], reservationKeys: [] };
  const envelope = (type: string, payload: unknown, extra = {}) => ({ protocolVersion: 1, messageId: randomUUID(), botId: launch.botId, sessionId: launch.sessionId, controllerEpoch: launch.controllerEpoch, sentAt: now, type, payload, ...extra });
  const assign = (attemptId: string) => envelope('task.assign', { task, checkpoint: {}, rulesVersion: launch.rules.version }, { taskId: task.id, attemptId });
  events.emit('spawn'); events.emit('health');
  return { worker, bot, events, launch, messages, items, cells, warehouseItems, envelope, assign, advance(ms = 10001) { now += ms; }, get executions() { return executions; }, get foodAttempts() { return foodAttempts; }, get overlap() { return overlap; }, get retreats() { return retreats; }, get warehouseObservations() { return warehouseObservations; } };
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
function status(messages: WorkerMessage[]) { const message = messages.filter(message => message.type === 'bot.status' || message.type === 'bot.ready').at(-1); assert.ok(message?.type === 'bot.status' || message?.type === 'bot.ready'); return message.payload; }


test('a persisted closed night shelter keeps priority even at full health and hunger until its actual exit completes',async()=>{
  const f=fixture({health:20,food:20,restore:{startedAt:Date.now()-1000,targetHealth:20,checkpoint:{nightBurrowPending:true,nightBurrow:{outside:{x:0,y:64,z:0},direction:{x:1,y:0,z:0},phase:'closed'}}}});
  try{
    await f.worker.receive(f.assign('sealed-shelter'));assert.equal(f.executions,0);assert.equal(status(f.messages).mode,'survival');assert.equal(status(f.messages).survivalRecovery!.checkpoint.nightBurrowPending,true);
  }finally{await f.worker.shutdown();}
});

test('moderate low health takes recovery priority, keeps its episode through 10.1 health and requires full health plus regenerative hunger', async () => {
  const f = fixture();
  try {
    f.bot.health = 6.333; f.bot.food = 17; f.items.push({ name: 'bread', count: 1 }); f.worker.pollSafety(); await settle();
    assert.equal(f.bot.food, 20); assert.equal(f.bot.health, 6.333); await f.worker.receive(f.assign('low')); assert.equal(f.executions, 0);
    assert.equal(status(f.messages).mode, 'survival'); assert.equal(status(f.messages).survivalRecovery!.targetHealth, 20);
    const startedAt = status(f.messages).survivalRecovery!.startedAt;
    f.bot.health = 10.1; f.events.emit('health'); await f.worker.receive(f.assign('middle')); assert.equal(f.executions, 0);
    assert.equal(status(f.messages).survivalRecovery!.startedAt, startedAt);
    f.bot.health = 20; f.bot.food = 17; await f.worker.receive(f.assign('hungry')); assert.equal(f.executions, 0);
    f.bot.food = 18; await f.worker.receive(f.assign('healed')); assert.equal(f.executions, 1); assert.equal(f.overlap, false);
    assert.equal(status(f.messages).survivalRecovery, undefined);
  } finally { await f.worker.shutdown(); }
});

test('a healthy distant resource trip provisions at hunger 18 while preserving its interrupted work',async()=>{
  const f=fixture({ensureFood:async()=>{f.items.push({name:'bread',count:1});}});
  try{
    f.bot.entity.position=new Vec3(80,64,0);f.bot.food=18;
    const assignment=f.assign('outbound'),task={...(assignment.payload as {task:TaskSpec}).task,kind:'collect',params:{item:'oak_log',quantity:32,returnTo:{x:0,y:64,z:0}},completion:{kind:'inventory',item:'oak_log',minimum:32}};
    assignment.payload={...assignment.payload as object,task,checkpoint:{resourceTrip:{item:'oak_log',minimum:32,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0},{x:80,y:64,z:0}],phase:'outbound',returns:0}}};
    await f.worker.receive(assignment);await settle();f.worker.pollSafety();await settle();
    assert.equal(f.executions,1);assert.equal(f.foodAttempts,1);assert.equal(f.bot.health,20);assert.equal(f.bot.food,20);
    const stopped=f.messages.find(m=>m.type==='task.interrupted'&&m.attemptId==='outbound');assert.ok(stopped?.type==='task.interrupted');assert.equal((stopped.payload.checkpoint.resourceTrip as JsonObject).phase,'outbound');
  }finally{await f.worker.shutdown();}
});

test('a healthy short return deposits its supplies before starting another food detour',async()=>{
  const f=fixture();
  try{
    f.bot.entity.position=new Vec3(80,64,0);f.bot.food=17;
    const assignment=f.assign('returning'),task={...(assignment.payload as {task:TaskSpec}).task,kind:'collect',params:{item:'oak_log',quantity:32,returnTo:{x:0,y:64,z:0}},completion:{kind:'inventory',item:'oak_log',minimum:32}};
    assignment.payload={...assignment.payload as object,task,checkpoint:{resourceTrip:{item:'oak_log',minimum:32,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0},{x:80,y:64,z:0}],phase:'returning',returns:0}}};
    await f.worker.receive(assignment);await settle();f.worker.pollSafety();await settle();
    assert.equal(f.executions,1);assert.equal(f.foodAttempts,0);assert.equal(f.messages.some(m=>m.type==='task.interrupted'),false);
  }finally{await f.worker.shutdown();}
});

test('recovery admission publishes actual survival status before rejecting a stale ordinary assignment', async () => {
  const f = fixture();
  try {
    f.bot.health = 6.333; f.bot.food = 17; await f.worker.receive(f.assign('race'));
    const rejected = f.messages.findIndex(message => message.type === 'task.rejected' && message.attemptId === 'race');
    assert.ok(rejected > 0); const prior = f.messages[rejected - 1]!; assert.equal(prior.type, 'bot.status');
    if (prior.type === 'bot.status') { assert.equal(prior.payload.health, 6.333); assert.equal(prior.payload.mode, 'survival'); assert.ok(prior.payload.survivalRecovery); }
    assert.equal(f.executions, 0);
  } finally { await f.worker.shutdown(); }
});

test('low-health food waits survive heartbeats, own movement, pause and central disconnection without resetting the exhausted search', async () => {
  let checkpoint: JsonObject | undefined;
  const f = fixture({ async ensureFood(s) {
    checkpoint ??= s.checkpoint; assert.equal(s.checkpoint, checkpoint);
    s.checkpoint.resourceRecovery = { $food: { origin: { x: 0, y: 64, z: 0 }, destinationsUsed: 5, status: 'exhausted', probes: [{ position: { x: 1, y: 64, z: 1 }, name: 'wheat' }] } };
    throw new ConditionWait('식량 탐색 예산 소진', { resourceNames: ['wheat'], resourcePositions: [{ x: 1, y: 64, z: 1 }] });
  } });
  try {
    f.cells.set('1,64,1', { name: 'wheat', age: 0 }); f.bot.health = 6.333; f.bot.food = 17; f.worker.pollSafety(); await settle();
    assert.equal(f.foodAttempts, 1); assert.equal(status(f.messages).mode, 'survival'); assert.equal(status(f.messages).action, '식량 대기');
    const wait = status(f.messages).survivalRecovery!.wait!.fingerprint;
    for (let i = 0; i < 4; i++) { f.advance(); f.bot.entity.position.x++; f.worker.pollSafety(); await settle(); }
    assert.equal(f.foodAttempts, 1);
    await f.worker.receive(f.envelope('rules.update', { mode: 'immediate', rules: { ...f.launch.rules, version: 2 }, config: { ...f.launch.config, enabled: false } }));
    f.worker.centralDisconnected(); f.advance(); f.worker.pollSafety(); await settle();
    assert.equal(f.foodAttempts, 1); await f.worker.receive(f.assign('paused'));
    const restored = status(f.messages).survivalRecovery!; assert.equal(restored.wait!.fingerprint, wait);
    assert.equal((restored.checkpoint.resourceRecovery as Record<string, JsonObject>).$food.destinationsUsed, 5); assert.equal(f.executions, 0);
    assert.equal(status(f.messages).mode, 'survival');
  } finally { await f.worker.shutdown(); }
});

test('an existing food wait advances through expansion and a distinct journey on resume, while paused or blocked stages retain their budgets', async () => {
  let attempts = 0;
  const f = fixture({ async ensureFood(s) {
    const recovery = new ResourceRecovery(s.bot, s, '$food', ['wheat'], true, () => false);
    const attempt = attempts++;
    if (attempt === 0) { recovery.state.destinationsUsed = 5; recovery.state.elapsedMs = 23000; }
    else {
      assert.equal(recovery.state.destinationsUsed, 5); assert.equal(recovery.state.elapsedMs, 23000);
      if (attempt === 1) assert.equal(recovery.expandFoodSearch(), true);
      else assert.equal(recovery.beginFoodJourney(), true);
    }
    throw recovery.wait('실제 식량을 확인하지 못했습니다.');
  } });
  try {
    f.bot.health = 3; f.bot.food = 17; f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1);
    await f.worker.receive(f.envelope('rules.update', { mode: 'immediate', rules: { ...f.launch.rules, version: 2 }, config: { ...f.launch.config, enabled: false } }));
    f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1);
    await f.worker.receive(f.envelope('rules.update', { mode: 'immediate', rules: { ...f.launch.rules, version: 3 }, config: { ...f.launch.config, enabled: true } }));
    f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 2);
    for (let i = 0; i < 3; i++) { f.advance(); f.worker.pollSafety(); await settle(); }
    assert.equal(f.foodAttempts, 3);
    const saved = status(f.messages).survivalRecovery!.checkpoint.resourceRecovery as Record<string, JsonObject>;
    assert.equal(saved.$food.foodSearchExpanded, true); assert.equal(saved.$food.destinationsUsed, 5); assert.equal(saved.$food.elapsedMs, 23000);
    assert.equal((saved.$food.foodJourney as JsonObject).status, 'blocked');
  } finally { await f.worker.shutdown(); }
});

test('restarted partial recovery restores its exact wait/cache/budget and does not restart an exhausted search until real crop change', async () => {
  let saved: SurvivalRecovery;
  const original = fixture({ async ensureFood(s) { s.checkpoint.resourceRecovery = { $food: { origin: { x: 0, y: 64, z: 0 }, destinationsUsed: 5, status: 'exhausted', probes: [{ position: { x: 1, y: 64, z: 1 }, name: 'wheat' }] } }; throw new ConditionWait('식량 대기', { resourceNames: ['wheat'], resourcePositions: [{ x: 1, y: 64, z: 1 }] }); } });
  try { original.bot.health = 6.333; original.bot.food = 17; original.cells.set('1,64,1', { name: 'wheat', age: 0 }); original.worker.pollSafety(); await settle(); saved = status(original.messages).survivalRecovery!; }
  finally { await original.worker.shutdown(); }
  let checkpoint: JsonObject | undefined;
  const f = fixture({ health: 14, food: 17, restore: saved!, async ensureFood(s) { checkpoint = s.checkpoint; throw new ConditionWait('실제 변경을 확인한 뒤 식량을 재평가했습니다.'); } });
  try {
    assert.equal(status(f.messages).mode, 'survival'); assert.equal(status(f.messages).survivalRecovery!.startedAt, saved!.startedAt);
    assert.equal(status(f.messages).action, '식량 대기'); assert.equal(status(f.messages).reason, saved!.wait!.reason);
    f.cells.set('1,64,1', { name: 'wheat', age: 0 });
    f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 0);
    f.cells.delete('1,64,1'); f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 0, 'unknown chunks preserve known proof');
    await f.worker.receive(f.assign('restored-middle')); assert.equal(f.executions, 0);
    f.cells.set('1,64,1', { name: 'wheat', age: 7 }); f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1);
    assert.equal((checkpoint!.resourceRecovery as Record<string, JsonObject>).$food.destinationsUsed, 5);
  } finally { await f.worker.shutdown(); }
});

test('a healthy bot with moderate hunger still yields local food work to an ordinary central assignment', async () => {
  const f = fixture({ async ensureFood(s) { await s.pause(120000); } });
  try {
    f.bot.food = 17; f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1);
    await f.worker.receive(f.assign('ordinary')); assert.equal(f.executions, 1); assert.equal(f.overlap, false); assert.equal(status(f.messages).survivalRecovery, undefined);
  } finally { await f.worker.shutdown(); }
});

test('danger still interrupts low-health food work and respawn clears the previous body recovery episode', async () => {
  const f = fixture({ async ensureFood(s) { s.checkpoint.resourceRecovery = { $food: { destinationsUsed: 3 } }; s.checkpoint.nightBasePending=true; s.checkpoint.nightBase={phase:'entering'}; await s.pause(120000); } });
  try {
    f.bot.health = 6.333; f.bot.food = 17; f.worker.pollSafety(); await settle();
    const skeleton = { id: 2, uuid: 'threat', name: 'skeleton', position: new Vec3(2, 64, 0) } as unknown as Entity; f.bot.entities[2] = skeleton; f.events.emit('entityHurt', f.bot.entity, skeleton);
    f.worker.pollSafety(); await settle(); assert.equal(f.retreats, 1); assert.equal(f.foodAttempts, 1); assert.equal(f.overlap, false);
    assert.equal(status(f.messages).mode, 'emergency');
    f.bot.health = 0; f.events.emit('death'); await settle(); delete f.bot.entities[2]; f.bot.health = 20; f.bot.food = 20; f.events.emit('spawn'); f.events.emit('health'); await settle();
    assert.equal(status(f.messages).survivalRecovery, undefined); assert.equal(status(f.messages).mode, 'recovering');
  } finally { await f.worker.shutdown(); }
});

test('a real observed warehouse stock change wakes waiting food recovery while unchanged warehouse contents do not', async () => {
  const warehouse: ContainerRef = { id: 'food', world: '127.0.0.1:25566', dimension: 'overworld', position: { x: 2, y: 64, z: 2 } };
  let saved: SurvivalRecovery;
  const f = fixture({ warehouse, async ensureFood(s) { s.checkpoint.foodWarehouse = { container: { ...warehouse }, items: [] }; throw new ConditionWait('창고와 주변에 식량이 없습니다.'); } });
  try {
    f.bot.health = 6.333; f.bot.food = 17; f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1);
    f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.warehouseObservations, 1); assert.equal(f.foodAttempts, 1);
    saved = status(f.messages).survivalRecovery!;
  } finally { await f.worker.shutdown(); }
  const restarted = fixture({ warehouse, health: 14, food: 17, restore: saved!, async ensureFood(s) {
    const stock = s.checkpoint.foodWarehouse as { items?: { name: string; count: number }[] } | undefined;
    assert.ok(stock?.items?.some(item => item.name === 'bread' && item.count > 0)); restarted.items.push({ name: 'bread', count: 1 });
  } });
  try {
    restarted.warehouseItems.push({ name: 'bread', count: 1 }); restarted.worker.pollSafety(); await settle();
    assert.equal(restarted.warehouseObservations, 1); assert.equal(restarted.foodAttempts, 0, 'only the real container observation changes the waiting input');
    restarted.advance(); restarted.worker.pollSafety(); await settle(); assert.equal(restarted.foodAttempts, 1); assert.equal(restarted.bot.food, 20);
    assert.deepEqual(restarted.items, []); assert.equal(status(restarted.messages).mode, 'survival', 'actual health has not yet recovered');
  } finally { await restarted.worker.shutdown(); }
});

test('food warehouse waiting compares identity and aggregate stock while timestamps and split stacks do not create a new condition', async () => {
  const f = fixture();
  try {
    const knowledge: FoodRecoveryKnowledge = { blocks: new Map() }, container = { id: 'food', world: '127.0.0.1:25566', dimension: 'overworld', position: { x: 2, y: 64, z: 2 } };
    const checkpoint: JsonObject = { foodWarehouse: { container, items: [{ name: 'bread', count: 1 }, { name: 'carrot', count: 2 }, { name: 'bread', count: 2 }], observedAt: 1 } };
    const initial = foodRecoveryFingerprint(f.bot, checkpoint, 6, knowledge);
    checkpoint.foodWarehouse = { container, items: [{ name: 'bread', count: 3 }, { name: 'carrot', count: 2 }], observedAt: 999999 };
    assert.equal(foodRecoveryFingerprint(f.bot, checkpoint, 6, knowledge), initial);
    checkpoint.foodWarehouse = { container, items: [{ name: 'bread', count: 4 }, { name: 'carrot', count: 2 }] };
    assert.notEqual(foodRecoveryFingerprint(f.bot, checkpoint, 6, knowledge), initial);
    checkpoint.foodWarehouse = { container: { ...container, id: 'other' }, items: [{ name: 'bread', count: 3 }, { name: 'carrot', count: 2 }] };
    assert.notEqual(foodRecoveryFingerprint(f.bot, checkpoint, 6, knowledge), initial);
  } finally { await f.worker.shutdown(); }
});

test('a critical worker wakes an unchanged food wait after real displacement and then remains passive when the new region is still empty', async () => {
  let checks = 0;
  const f = fixture({ async ensureFood(s) {
    checks++;
    const search = new ResourceRecovery(s.bot, s, '$food', ['carrots'], true, () => false);
    if (!search.state.foodJourney) Object.assign(search.state, { origin: { x: 80, y: 64, z: 0 }, foodSearchExpanded: true, destinationsUsed: 5, elapsedMs: 180069, reason: '원정의 마지막 도착 위치와 현재 위치 사이의 안전한 연결을 확인해야 합니다.', foodJourney: { center: { x: 80, y: 64, z: 0 }, visited: [{ x: 80, y: 64, z: 0 }], deadEnds: [], moves: 61, elapsedMs: 1539, pending: false, status: 'blocked' } });
    const pause = s.pause; s.pause = async () => {};
    try { if (checks > 1) await search.reanchorFoodJourney(); } finally { s.pause = pause; }
    throw search.wait('실제 새 구간에도 식량 원천이 없습니다.');
  } });
  try {
    f.bot.blockAt = ((raw: Vec3) => { const p = raw.floored(), solid = p.y === 63; return { name: solid ? 'dirt' : 'air', position: p, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0,0,0,1,1,1]] : [], getProperties: () => ({}) }; }) as unknown as Bot['blockAt'];
    f.bot.health = 1; f.bot.food = 16; f.worker.pollSafety(); await settle();
    assert.equal(checks, 1); const startedAt = status(f.messages).survivalRecovery!.startedAt;
    f.advance(); f.worker.pollSafety(); await settle();
    assert.equal(checks, 2, 'the unchanged wait fingerprint cannot hide the displaced actual body');
    const saved = status(f.messages).survivalRecovery!, records = saved.checkpoint.resourceRecovery as Record<string, { elapsedMs: number; destinationsUsed: number; foodJourney: { center: unknown; moves: number; elapsedMs: number; displacementCount: number } }>;
    assert.equal(saved.startedAt, startedAt); assert.equal(records.$food!.elapsedMs, 180069); assert.equal(records.$food!.destinationsUsed, 5);
    assert.deepEqual(records.$food!.foodJourney.center, { x: 0, y: 64, z: 0 }); assert.equal(records.$food!.foodJourney.moves, 61); assert.equal(records.$food!.foodJourney.displacementCount, 1);
    for (let i = 0; i < 4; i++) { f.advance(); f.worker.pollSafety(); await settle(); }
    assert.equal(checks, 2); assert.equal(f.executions, 0); assert.equal(f.bot.health, 1); assert.equal(status(f.messages).mode, 'survival');
  } finally { await f.worker.shutdown(); }
});


test('restored shelter work reobserves its world once instead of retaining a previous worker wait',async()=>{
 const f=fixture({restore:{startedAt:Date.now()-1000,targetHealth:20,checkpoint:{nightBurrowPending:true,nightBurrow:{outside:{x:0,y:64,z:0},direction:{x:1,y:0,z:0},phase:'digging'}},wait:{fingerprint:'old-block-watch',reason:'old threat'}}});
 try{assert.equal(status(f.messages).survivalRecovery!.wait,undefined);assert.equal(status(f.messages).survivalRecovery!.checkpoint.nightBurrowPending,true);}finally{await f.worker.shutdown();}
});
for(const version of [1,2])test(`nearby soil shelter capability ${version===1?'reobserves one old refusal':'keeps its already observed refusal'} without replenishing resource work`,async()=>{
 const f=fixture({health:5,food:17,restore:{startedAt:1,targetHealth:20,checkpoint:{nightShelterUnavailable:true,nightSoilShaftSearchVersion:version,resourceRecovery:{$food:{destinationsUsed:5,elapsedMs:60000}}},wait:{fingerprint:'old-soil-watch',reason:'shallow soil'}}});
 try{const saved=status(f.messages).survivalRecovery!;assert.equal(saved.checkpoint.nightSoilShaftSearchVersion,2);assert.equal(saved.checkpoint.nightShelterUnavailable,version===1?undefined:true);assert.equal(saved.wait?.fingerprint,version===1?undefined:'old-soil-watch');assert.deepEqual(saved.checkpoint.resourceRecovery,{$food:{destinationsUsed:5,elapsedMs:60000}});}finally{await f.worker.shutdown();}
});

test('a healthy new body resolves its physical recovery before resuming an unfinished shelter',async()=>{
 const now=Date.now(),f=fixture({health:20,food:20,recovery:{deathId:'actual-new-body',occurredAt:now-1000,world:'127.0.0.1:25566',dimension:'overworld',priorInventory:[],phase:'recovering',reason:'new body',attemptCount:0,progress:{recoveredCount:0,remainingCount:0},safe:false,updatedAt:now,checkpoint:{}},restore:{startedAt:now-1000,targetHealth:20,checkpoint:{nightBurrowPending:true,nightBurrow:{outside:{x:0,y:64,z:0},direction:{x:1,y:0,z:0},phase:'digging'}}}});
 try{f.worker.pollSafety();await settle();assert.equal(status(f.messages).recovery!.phase,'resolved');assert.equal(status(f.messages).recovery!.safe,false);assert.equal(f.foodAttempts,0);}finally{await f.worker.shutdown();}
});

test('shelter waits watch real dusk, twenty-block threats and a displaced body without timer-based retries',async()=>{
 const f=fixture(),cp:JsonObject={nightBurrowPending:true,nightBurrow:{outside:{x:0,y:64,z:0},direction:{x:1,y:0,z:0},phase:'digging'},resourcePositions:[{x:0,y:64,z:0}]},knowledge:FoodRecoveryKnowledge={blocks:new Map()};
 try{
  f.cells.set('0,64,0',{name:'air'});Object.assign(f.bot,{time:{timeOfDay:18000,isDay:false}});const fp=()=>foodRecoveryFingerprint(f.bot,cp,6,knowledge);const night=fp();f.bot.time.timeOfDay=18001;assert.equal(fp(),night);
  const threat={id:2,name:'zombie',position:new Vec3(15,64,0)} as unknown as Entity;f.bot.entities[2]=threat;const near=fp();assert.notEqual(near,night);threat.position=new Vec3(21,64,0);assert.equal(fp(),night);
  f.bot.time.timeOfDay=1000;f.bot.time.isDay=true;const day=fp();assert.notEqual(day,night);f.bot.entity.position=new Vec3(5,64,0);assert.equal(fp(),day);f.bot.entity.position=new Vec3(7,64,0);const moved=fp();assert.notEqual(moved,day);f.bot.entity.position=new Vec3(9,64,0);assert.equal(fp(),moved);
 }finally{await f.worker.shutdown();}
});


const reserveWarehouse: ContainerRef = { id: 'reserve-base', world: '127.0.0.1:25566', dimension: 'overworld', position: { x: 2, y: 64, z: 0 } };
const reserveShelter: BaseShelter = { warehouseId: reserveWarehouse.id, world: reserveWarehouse.world, dimension: reserveWarehouse.dimension, door: { x: 1, y: 64, z: 0 }, outside: { x: 0, y: 64, z: 0 }, inside: { x: 2, y: 64, z: 0 }, blocks: Array.from({ length: 16 }, (_, x) => ({ position: { x, y: 63, z: 0 }, name: 'stone' })) };
const reserveHome: TaskSpec = { id: 'reserve-home', goalId: 'reserve-goal', kind: 'home', params: { position: reserveShelter.inside, radius: 1, basePassage: 'inside' }, completion: { kind: 'position', position: reserveShelter.inside, radius: 1 }, dependencies: [], reservationKeys: [] };

test('healthy reserve provisioning yields to an exact registered-base return while retaining its food budget', async () => {
  const budget = { destinationsUsed: 13, elapsedMs: 180000 };
  const f = fixture({ health: 20, food: 18, warehouse: reserveWarehouse, baseShelter: reserveShelter, restore: { startedAt: 1, targetHealth: 20, checkpoint: { expeditionFoodTarget: 19, resourceRecovery: { $food: budget } } }, ensureFood: s => s.pause(120000) });
  try {
    f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1);
    await f.worker.receive(f.assign('ordinary-building-rejected')); assert.equal(f.executions, 0);
    await f.worker.receive(f.envelope('task.assign', { task: reserveHome, checkpoint: {}, rulesVersion: f.launch.rules.version }, { taskId: reserveHome.id, attemptId: 'reserve-return' }));
    await settle(); f.worker.pollSafety(); await settle();
    assert.equal(f.executions, 1); assert.equal(f.overlap, false); assert.equal(f.foodAttempts, 1);
    assert.equal(f.messages.some(m => m.type === 'task.interrupted' && m.attemptId === 'reserve-return'), false);
    assert.deepEqual((status(f.messages).survivalRecovery!.checkpoint.resourceRecovery as JsonObject).$food, budget);
  } finally { await f.worker.shutdown(); }
});

test('reserve return exception cannot bypass injury, low hunger, a sealed shelter or an unrelated destination', async () => {
  for (const mode of ['injured', 'hungry', 'sealed', 'elsewhere'] as const) {
    const f = fixture({ health: mode === 'injured' ? 19 : 20, food: mode === 'hungry' ? 17 : 18, warehouse: reserveWarehouse, baseShelter: reserveShelter, restore: { startedAt: 1, targetHealth: 20, checkpoint: { expeditionFoodTarget: 19, ...(mode === 'sealed' ? { nightBurrowPending: true } : {}) } } });
    try {
      const task = mode === 'elsewhere' ? { ...reserveHome, params: { ...reserveHome.params, position: { x: 200, y: 64, z: 200 } } } : reserveHome;
      await f.worker.receive(f.envelope('task.assign', { task, checkpoint: {}, rulesVersion: f.launch.rules.version }, { taskId: task.id, attemptId: mode }));
      assert.equal(f.executions, 0, mode);
      assert.ok(f.messages.some(m => m.type === 'task.rejected' && m.attemptId === mode));
    } finally { await f.worker.shutdown(); }
  }
});

test('restored reserve provisioning proves stale death footing safe before starting food search or a base return', async () => {
  const budget = { destinationsUsed: 13, elapsedMs: 180000 }, now = Date.now();
  const f = fixture({ health: 20, food: 18, warehouse: reserveWarehouse, baseShelter: reserveShelter, restore: { startedAt: 1, targetHealth: 20, checkpoint: { expeditionFoodTarget: 19, resourceRecovery: { $food: budget } } }, recovery: { deathId: 'old-resolved-life', occurredAt: now - 1000000, world: reserveWarehouse.world, dimension: reserveWarehouse.dimension, priorInventory: [], phase: 'resolved', reason: 'prior footing', attemptCount: 0, progress: { recoveredCount: 0, remainingCount: 0 }, safe: false, updatedAt: now, checkpoint: { recoverySafety: { reason: 'prior body footing', status: 'waiting' } } }, ensureFood: s => s.pause(120000) });
  // This is the unit fixture's fake world, not a patched library instance.
  Object.assign(f.bot, { blockAt: (p: Vec3) => ({ name: p.y < 64 ? 'dirt' : 'air', position: p, boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }) });
  try {
    f.worker.pollSafety(); await settle();
    assert.ok(f.messages.some(m => m.type === 'bot.recovery' && m.payload.safe), 'Current observed ground must clear the old safety gate.');
    assert.equal(f.foodAttempts, 0);
    await f.worker.receive(f.envelope('task.assign', { task: reserveHome, checkpoint: {}, rulesVersion: f.launch.rules.version }, { taskId: reserveHome.id, attemptId: 'safe-reserve-return' }));
    assert.equal(f.executions, 1);
    assert.deepEqual((status(f.messages).survivalRecovery!.checkpoint.resourceRecovery as JsonObject).$food, budget);
  } finally { await f.worker.shutdown(); }
});
