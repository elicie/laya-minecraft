import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, type JsonObject, type ResultPayload, type TaskSpec, type WorkerMessage } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { MinecraftWorker } from '../packages/minecraft/src/worker';
import { ConditionWait, type ActionServices } from '../packages/minecraft/src/services';

function fixture(options: { timers?: boolean; ensureFood(s: ActionServices): Promise<void>; execute?(task: TaskSpec, s: ActionServices): Promise<ResultPayload> }) {
  const emitter = new EventEmitter(), messages: WorkerMessage[] = [];
  let now = Date.now(), executions = 0, foodAttempts = 0, foodRunning = false, overlap = false, fights = 0, retreats = 0;
  const items: { name: string; count: number }[] = [];
  const cells = new Map<string, { name: string; age?: number; stateId?: number }>();
  const sourceOrigins: { x: number; y: number; z: number }[] = [];
  const launch = WorkerLaunchSchema.parse({ botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch', config: { name: 'RecoveryBot' }, rules: { statusIntervalMs: 250 } });
  const bot = Object.assign(emitter, {
    health: 20, food: 20, game: { dimension: 'overworld' }, entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {} as Record<number, Entity>, players: {},
    inventory: { items: () => items, slots: Array.from({ length: 46 }, () => null) },
    pathfinder: { setGoal() {}, setMovements() {}, thinkTimeout: 0 },
    findBlocks({ matching, point }: { matching(block: { name: string }): boolean; point?: Vec3 }) { if (point) sourceOrigins.push({ x: point.x, y: point.y, z: point.z }); return [...cells].filter(([, block]) => matching(block)).map(([key]) => new Vec3(...key.split(',').map(Number) as [number, number, number])); },
    blockAt(p: Vec3) { const cell = cells.get(`${p.x},${p.y},${p.z}`); return cell ? { name: cell.name, position: p, stateId: cell.stateId, getProperties: () => cell.age === undefined ? {} : { age: cell.age } } : null; },
    clearControlStates() {}, deactivateItem() {}, stopDigging() {}, quit(reason: string) { emitter.emit('end', reason); },
  }) as unknown as Bot;
  class RecoveryExecutor extends MineflayerExecutor {
    override async ensureFood(s: ActionServices): Promise<void> {
      foodAttempts++; foodRunning = true;
      try { await options.ensureFood(s); } finally { foodRunning = false; }
    }
    override async eat(): Promise<boolean> {
      const food = items.find(item => item.name === 'bread' && item.count > 0);
      if (!food) return false;
      food.count--; if (!food.count) items.splice(items.indexOf(food), 1);
      bot.food = Math.min(20, bot.food + 5); return true;
    }
    override async execute(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
      executions++; if (foodRunning) overlap = true;
      if (options.execute) return options.execute(task, s);
      await s.pause(120000); throw new Error('fixture timeout');
    }
    override async fightEntity(_entity: Entity, s: ActionServices): Promise<void> { fights++; await s.pause(120000); }
    override async retreat(_entity: Entity, s: ActionServices): Promise<void> { retreats++; await s.pause(120000); }
  }
  const worker = new MinecraftWorker(launch, bot, message => messages.push(message), { timers: options.timers ?? false, now: () => now, movementsFactory: () => ({}) as Movements, executorFactory: (bot, options) => new RecoveryExecutor(bot, options) });
  const envelope = (type: string, payload: unknown, extra: object = {}) => ({ protocolVersion: 1, messageId: randomUUID(), botId: launch.botId, sessionId: launch.sessionId, controllerEpoch: launch.controllerEpoch, sentAt: Date.now(), type, payload, ...extra });
  const task: TaskSpec = { id: 'task', goalId: 'goal', kind: 'collect', params: { item: 'oak_log', quantity: 1 }, completion: { kind: 'inventory', item: 'oak_log', minimum: 1 }, dependencies: [], reservationKeys: [] };
  const assign = (attemptId: string, assigned = task, checkpoint: JsonObject = {}) => envelope('task.assign', { task: assigned, checkpoint, rulesVersion: launch.rules.version }, { taskId: assigned.id, attemptId });
  emitter.emit('spawn'); emitter.emit('health');
  return { worker, bot, emitter, launch, messages, cells, items, sourceOrigins, envelope, assign, advance(ms = 10001) { now += ms; }, get executions() { return executions; }, get foodAttempts() { return foodAttempts; }, get overlap() { return overlap; }, get fights() { return fights; }, get retreats() { return retreats; } };
}
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)); }
function lastStatus(messages: WorkerMessage[]) { const message = messages.filter(message => message.type === 'bot.status').at(-1); assert.ok(message?.type === 'bot.status'); return message.payload; }

test('exhausted food recovery waits through heartbeats and its own movement, then rechecks a real crop change and consumes', async () => {
  let saved: JsonObject | undefined;
  const f = fixture({ async ensureFood(s) {
    if (saved) assert.equal(s.checkpoint, saved, 'recovery must reuse its checkpoint object');
    saved = s.checkpoint;
    if ((f.cells.get('1,64,1')?.age ?? 0) >= 7) { f.items.push({ name: 'bread', count: 1 }); return; }
    s.checkpoint.resourceRecovery = { $food: { origin: { x: 0, y: 64, z: 0 }, destinationsUsed: 5, status: 'exhausted', probes: [{ position: { x: 1, y: 64, z: 1 }, name: 'wheat' }] } };
    s.progress('자원 탐색', '안전한 이동 5/5를 마쳐 실제 식량 변화를 기다립니다.');
    throw new ConditionWait('식량 탐색 범위에서 익은 작물을 찾지 못했습니다.', { missingFood: true, resourceNames: ['wheat'], resourcePositions: [{ x: 1, y: 64, z: 1 }] });
  } });
  try {
    f.cells.set('1,64,1', { name: 'wheat', age: 0 }); f.bot.food = 17;
    f.worker.pollSafety(); await settle();
    assert.equal(f.foodAttempts, 1); assert.equal(lastStatus(f.messages).action, '식량 대기'); assert.equal(lastStatus(f.messages).mode, 'idle');
    assert.match(lastStatus(f.messages).reason, /익은 작물/);
    for (let i = 0; i < 4; i++) { f.advance(); f.bot.entity.position.x += 1; f.worker.pollSafety(); await settle(); }
    assert.equal(f.foodAttempts, 1, 'clock and search movement are not new resources');
    assert.ok(f.sourceOrigins.length > 0);
    assert.ok(f.sourceOrigins.every(origin => origin.x === 0 && origin.y === 64 && origin.z === 0), 'source observation remains anchored to the original recovery position');
    assert.equal((saved!.resourceRecovery as Record<string, JsonObject>).$food.destinationsUsed, 5);
    f.cells.delete('1,64,1'); f.advance(); f.worker.pollSafety(); await settle();
    assert.equal(f.foodAttempts, 1, 'temporarily unloaded crops are not new empty ground');
    f.cells.set('1,64,1', { name: 'wheat', age: 7 }); f.advance(); f.worker.pollSafety();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.foodAttempts, 2); assert.equal(f.bot.food, 20); assert.deepEqual(f.items, []);
    assert.equal(lastStatus(f.messages).action, '대기'); assert.doesNotMatch(lastStatus(f.messages).reason, /탐색.*중/);
    assert.equal(f.overlap, false);
  } finally { await f.worker.shutdown(); }
});

test('moderate local food search yields before central execution, keeps progress and preserves paused survival limits', async () => {
  let saved: JsonObject | undefined;
  const f = fixture({ async ensureFood(s) {
    if (saved) assert.equal(s.checkpoint, saved);
    saved = s.checkpoint;
    s.checkpoint.resourceRecovery ??= { $food: { origin: { x: 0, y: 64, z: 0 }, destinationsUsed: 2, status: 'searching' } };
    s.progress('자원 탐색', '안전한 이동 2/5 → 재관측');
    await s.pause(120000);
  } });
  try {
    f.bot.food = 17; f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1);
    await f.worker.receive(f.assign('central')); assert.equal(f.executions, 1); assert.equal(f.overlap, false);
    assert.equal((saved!.resourceRecovery as Record<string, JsonObject>).$food.destinationsUsed, 2);
    await f.worker.receive(f.envelope('task.cancel', { reason: '일시정지', preserveProgress: true }, { taskId: 'task', attemptId: 'central' }));
    const paused = { ...f.launch.config, enabled: false };
    await f.worker.receive(f.envelope('rules.update', { mode: 'immediate', rules: { ...f.launch.rules, version: 2 }, config: paused }));
    f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1, 'paused moderate hunger must not start a long search');
    f.bot.food = 6; f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 2, 'critical basic survival remains available while paused');
    await f.worker.receive(f.assign('paused')); assert.equal(f.executions, 1); assert.equal(f.overlap, false);
    await f.worker.receive(f.envelope('rules.update', { mode: 'immediate', rules: { ...f.launch.rules, version: 3 }, config: paused }));
    assert.equal((saved!.resourceRecovery as Record<string, JsonObject>).$food.destinationsUsed, 2, 'safe stops retain the search budget');
  } finally { await f.worker.shutdown(); }
});

test('emergency withdrawal cancels food work and cannot overlap a central task or discard its progress', async () => {
  let saved: JsonObject | undefined;
  const f = fixture({ async ensureFood(s) {
    saved = s.checkpoint; s.checkpoint.resourceRecovery = { $food: { origin: { x: 0, y: 64, z: 0 }, destinationsUsed: 3 } };
    await s.pause(120000);
  } });
  try {
    f.bot.food = 17; f.worker.pollSafety(); await settle();
    f.bot.health = 5;
    const zombie = { id: 2, name: 'zombie', type: 'mob', position: new Vec3(2, 64, 0) } as unknown as Entity;
    f.bot.entities[2] = zombie; f.emitter.emit('entityHurt', f.bot.entity, zombie);
    f.worker.pollSafety(); await settle();
    assert.equal(f.retreats, 1); assert.equal(f.fights, 0); assert.equal(f.foodAttempts, 1);
    await f.worker.receive(f.assign('unsafe')); assert.equal(f.executions, 0);
    assert.equal((saved!.resourceRecovery as Record<string, JsonObject>).$food.destinationsUsed, 3);
    assert.equal(f.overlap, false);
  } finally { await f.worker.shutdown(); }
});

test('generic resource waits report same-name crop maturation at odd exact coordinates without inventing unknown cells or rerunning tasks', async () => {
  const f = fixture({ timers: true, async ensureFood() { throw new ConditionWait('식량 없음'); }, async execute(_task, s) {
    throw new ConditionWait('작물이 익기를 기다립니다.', { ...s.checkpoint, waitingFor: { kind: 'inventory', causeCode: 'RESOURCE_MISSING', item: 'wheat', minimum: 1, resourceNames: ['wheat'], resourcePositions: [{ x: 1, y: 63, z: 1 }] } });
  } });
  try {
    const task: TaskSpec = { id: 'crop', goalId: 'goal', kind: 'collect', params: { item: 'wheat', quantity: 1 }, completion: { kind: 'inventory', item: 'wheat', minimum: 1 }, dependencies: [], reservationKeys: [] };
    await f.worker.receive(f.assign('crop-attempt', task)); await settle();
    assert.ok(f.messages.some(message => message.type === 'task.result' && message.payload.outcome === 'condition-wait'));
    f.advance(5001); await new Promise(resolve => setTimeout(resolve, 300));
    const reports = f.messages.filter(message => message.type === 'world.observed');
    assert.equal(reports.some(message => message.type === 'world.observed' && message.payload.observations.some(o => o.kind === 'blocks' && o.data.blocks.some(b => b.position.x === 1 && b.position.z === 1))), false, 'unloaded source remains unknown');
    for (const stateId of [123, 124]) {
      f.cells.set('1,63,1', { name: 'wheat', stateId }); f.advance(5001); await new Promise(resolve => setTimeout(resolve, 300));
      assert.ok(f.messages.some(message => message.type === 'world.observed' && message.payload.observations.some(o => o.kind === 'blocks' && o.data.blocks.some(b => b.name === 'wheat' && b.stateId === stateId && b.position.x === 1 && b.position.y === 63 && b.position.z === 1))), `same-name crop state ${stateId} reaches central observations`);
    }
    f.cells.set('1,63,1', { name: 'wheat', stateId: -1 }); f.advance(5001); await new Promise(resolve => setTimeout(resolve, 300));
    const lastObservation = f.messages.filter(message => message.type === 'world.observed').at(-1);
    assert.ok(lastObservation?.type === 'world.observed');
    const actual = lastObservation.payload.observations.flatMap(o => o.kind === 'blocks' ? o.data.blocks : []).find(b => b.position.x === 1 && b.position.y === 63 && b.position.z === 1);
    assert.ok(actual); assert.equal(actual.name, 'wheat'); assert.equal(actual.stateId, undefined, 'invalid state IDs are omitted without changing the real block name');
    await f.worker.receive(f.assign('crop-attempt', task)); assert.equal(f.executions, 1, 'map observation never runs an assignment again');
  } finally { await f.worker.shutdown(); }
});

test('idle food recovery inherits the unfinished build footprint and protected facilities', async () => {
  let protection: JsonObject | undefined;
  const f = fixture({ async ensureFood(s) { protection = structuredClone(s.checkpoint); throw new ConditionWait('보호된 기초를 유지하며 식량 조건을 기다립니다.'); }, async execute(_task, s) {
    s.checkpoint.buildProtection = { origin: { x: 1, y: 64, z: 1 }, width: 5, depth: 5, height: 4 };
    s.checkpoint.buildPreparationProtection = [{ x: 1, y: 63, z: 1 }];
    throw new ConditionWait('건설 재료 대기', { ...s.checkpoint, waitingFor: { kind: 'inventory', causeCode: 'BUILD_MATERIAL', item: 'oak_log', minimum: 1 } });
  } });
  try {
    const task: TaskSpec = { id: 'build', goalId: 'goal', kind: 'build', params: { protectedPositions: [{ x: 2, y: 64, z: 2 }] }, completion: { kind: 'manual', reason: '건축 검증' }, dependencies: [], reservationKeys: [] };
    await f.worker.receive(f.assign('build-attempt', task)); await settle();
    f.bot.food = 17; f.worker.pollSafety(); await settle();
    assert.deepEqual(protection?.buildProtection, { origin: { x: 1, y: 64, z: 1 }, width: 5, depth: 5, height: 4 });
    assert.deepEqual(protection?.buildPreparationProtection, [{ x: 1, y: 63, z: 1 }]);
    assert.deepEqual(protection?.protectedPositions, [{ x: 2, y: 64, z: 2 }]);
  } finally { await f.worker.shutdown(); }
});

test('critical hunger interrupts immediately during the recovery cooldown and protects in-flight building progress', async () => {
  let protection: JsonObject | undefined;
  const f = fixture({ async ensureFood(s) { protection = structuredClone(s.checkpoint); throw new ConditionWait('기초를 보호하며 새 식량을 기다립니다.'); }, async execute(_task, s) {
    s.checkpoint.buildProtection = { origin: { x: 3, y: 64, z: 3 }, width: 5, depth: 5, height: 4 };
    await s.pause(120000); throw new Error('fixture timeout');
  } });
  try {
    f.bot.food = 17; f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1);
    const task: TaskSpec = { id: 'build', goalId: 'goal', kind: 'build', params: {}, completion: { kind: 'manual', reason: '건축 검증' }, dependencies: [], reservationKeys: [] };
    await f.worker.receive(f.assign('build-active', task)); assert.equal(f.executions, 1);
    f.bot.food = 6; f.worker.pollSafety(); await settle();
    assert.equal(f.foodAttempts, 2, 'critical work interruption must not wait for the ten-second check');
    assert.ok(f.messages.some(message => message.type === 'task.interrupted' && message.payload.safeStopped));
    assert.deepEqual(protection?.buildProtection, { origin: { x: 3, y: 64, z: 3 }, width: 5, depth: 5, height: 4 });
    assert.equal(lastStatus(f.messages).mode, 'survival'); assert.equal(lastStatus(f.messages).action, '식량 대기');
    assert.equal(f.overlap, false);
  } finally { await f.worker.shutdown(); }
});
