import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, WorkerMessageSchema, type ContainerRef, type JsonObject, type ObservationInput, type ResultPayload, type SurvivalRecovery, type TaskSpec, type WorkerMessage } from '../packages/contracts/src';
import { MinecraftWorker } from '../packages/minecraft/src/worker';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { foodRecoveryFingerprint, type FoodRecoveryKnowledge } from '../packages/minecraft/src/worker-recovery';
import { ConditionWait, type ActionServices } from '../packages/minecraft/src/services';

function fixture(options: { health?: number; food?: number; restore?: SurvivalRecovery; warehouse?: ContainerRef; ensureFood?(s: ActionServices): Promise<void> } = {}) {
  const events = new EventEmitter(), messages: WorkerMessage[] = [], items: { name: string; count: number }[] = [];
  let now = Date.now(), executions = 0, foodAttempts = 0, foodRunning = false, overlap = false, retreats = 0, warehouseObservations = 0;
  const cells = new Map<string, { name: string; age?: number }>(), warehouseItems: { name: string; count: number }[] = [];
  const launch = WorkerLaunchSchema.parse({ botId: 'health', sessionId: 'session', controllerEpoch: 'epoch', config: { name: 'HealthWorker' }, rules: { world: '127.0.0.1:25566', warehouse: options.warehouse ?? null }, ...(options.restore ? { restoreSurvivalRecovery: options.restore } : {}) });
  const bot = Object.assign(events, { health: options.health ?? 20, food: options.food ?? 20, game: { dimension: 'overworld' }, entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {} as Record<number, Entity>, players: {},
    inventory: { items: () => items, slots: Array.from({ length: 46 }, () => null) },
    pathfinder: { setGoal() {}, setMovements() {}, thinkTimeout: 0 }, findBlocks() { return []; },
    blockAt(p: Vec3) { const cell = cells.get(`${p.x},${p.y},${p.z}`); return cell ? { name: cell.name, position: p, getProperties: () => cell.age === undefined ? {} : { age: cell.age } } : null; },
    clearControlStates() {}, deactivateItem() {}, stopDigging() {}, quit(reason: string) { events.emit('end', reason); },
  }) as unknown as Bot;
  class Executor extends MineflayerExecutor {
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
  const f = fixture({ async ensureFood(s) { s.checkpoint.resourceRecovery = { $food: { destinationsUsed: 3 } }; await s.pause(120000); } });
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
