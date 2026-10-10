import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, type CentralMessage, type ResultPayload, type TaskSpec, type WorkerMessage } from '../packages/contracts/src';
import { MinecraftWorker } from '../packages/minecraft/src/worker';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ActionFailure, ConditionWait, pause, type ActionServices } from '../packages/minecraft/src/services';

function fixture(options: { unknownAbort?: boolean; foodWait?: boolean; meal?: boolean; foodFailure?: boolean; unarmed?: boolean; shield?: boolean } = {}) {
  const emitter = new EventEmitter();
  const messages: WorkerMessage[] = [];
  let executions = 0;
  let fights = 0;
  let retreats = 0;
  let foodAttempts = 0;
  let mealAvailable = !!options.meal;
  const launch = WorkerLaunchSchema.parse({ botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch',
    config: { name: 'TestBot', role: 'gatherer', connection: { host: '127.0.0.1', port: 25566 } },
    rules: { world: '127.0.0.1:25566', center: { x: 0, y: 64, z: 0 } } });
  const bot = Object.assign(emitter, {
    health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {} as Record<number, Entity>, players: {} as Record<string, { entity: Entity }>,
    inventory: { items: () => options.unarmed ? [] : [{ name: 'iron_sword', count: 1 }], slots: Array.from({ length: 46 }, (_, index) => index === 45 && options.shield ? { name: 'shield', count: 1 } : null) },
    pathfinder: { setGoal() {}, setMovements() {}, thinkTimeout: 0 }, blockAt: () => null,
    clearControlStates() {}, deactivateItem() {}, stopDigging() {},
    quit(reason: string) { emitter.emit('end', reason); },
  }) as unknown as Bot;
  class ControlledExecutor extends MineflayerExecutor {
    override async execute(_task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
      executions += 1;
      try { await s.pause(120_000); }
      catch (error) { if (options.unknownAbort) throw new Error('서버 응답이 없어 실제 변경 결과를 확인해야 합니다.'); throw error; }
      throw new Error('test timeout');
    }
    override async fightEntity(_target: Entity, s: ActionServices): Promise<void> { fights += 1; await s.pause(120_000); }
    override async retreat(_target: Entity, s: ActionServices): Promise<void> { retreats += 1; await s.pause(120_000); }
    override async eat(): Promise<boolean> { if (!mealAvailable) return false; mealAvailable = false; bot.food = Math.min(20, bot.food + 4); return true; }
    override async ensureFood(s: ActionServices): Promise<void> {
      foodAttempts += 1;
      if (options.foodWait) await s.pause(120_000);
      if (options.foodFailure) throw new ActionFailure('섭취 효과를 다시 확인해야 합니다.', 'EAT_UNCERTAIN', false, false);
      throw new ConditionWait('현재 관측한 범위에서 확보 가능한 식량이나 재료를 확인하지 못했습니다.');
    }
  }
  const worker = new MinecraftWorker(launch, bot, message => messages.push(message), {
    timers: false, movementsFactory: () => ({}) as Movements,
    executorFactory: (bot, options) => new ControlledExecutor(bot, options),
  });
  const task: TaskSpec = { id: 'task', goalId: 'goal', kind: 'collect', params: { item: 'oak_log', quantity: 1 }, dependencies: [], reservationKeys: [], completion: { kind: 'inventory', item: 'oak_log', minimum: 1 } };
  const envelope = (type: string, payload: unknown, extra: object = {}) => ({ protocolVersion: 1, messageId: randomUUID(), botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch', sentAt: Date.now(), type, payload, ...extra });
  const assign = (attemptId: string = randomUUID(), extra: object = {}) => envelope('task.assign', { task, checkpoint: { step: 7 }, rulesVersion: launch.rules.version }, { taskId: 'task', attemptId, ...extra });
  return { worker, bot, emitter, launch, messages, envelope, assign,
    get executions() { return executions; }, get fights() { return fights; }, get retreats() { return retreats; }, get foodAttempts() { return foodAttempts; } };
}
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)); }

test('critical health waits for actual regeneration after a meal and resumes without requiring full health', async () => {
  const f = fixture({ meal: true }); f.emitter.emit('spawn'); f.emitter.emit('health');
  try {
    f.bot.health = 5; f.bot.food = 17; f.worker.pollSafety();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.bot.food, 20); assert.equal(f.bot.health, 5); assert.equal(f.foodAttempts, 0);
    const recovering = f.messages.filter(m => m.type === 'bot.status').at(-1);
    assert.ok(recovering?.type === 'bot.status'); assert.equal(recovering.payload.mode, 'survival'); assert.equal(recovering.payload.action, '회복 대기');
    await f.worker.receive(f.assign('critical')); assert.equal(f.executions, 0);
    f.bot.health = f.launch.rules.combat.retreatHealth + 1; f.emitter.emit('health');
    await new Promise(resolve => setTimeout(resolve, 1050));
    await f.worker.receive(f.assign('recovered')); assert.equal(f.executions, 1);
    assert.ok(f.bot.health < 20);
  } finally { await f.worker.shutdown(); }
});

test('critical health with sufficient hunger remains in recovery without unnecessary food acquisition', async () => {
  const f = fixture(); f.emitter.emit('spawn'); f.emitter.emit('health');
  try {
    f.bot.health = 5; f.worker.pollSafety(); await settle();
    assert.equal(f.foodAttempts, 0);
    const recovering = f.messages.filter(m => m.type === 'bot.status').at(-1);
    assert.ok(recovering?.type === 'bot.status'); assert.equal(recovering.payload.mode, 'survival'); assert.equal(recovering.payload.action, '회복 대기');
    await f.worker.receive(f.assign('still-critical')); assert.equal(f.executions, 0);
  } finally { await f.worker.shutdown(); }
});

test('missing observed food and uncertain food effects keep critical recovery visible', async () => {
  for (const foodFailure of [false, true]) {
    const f = fixture({ foodFailure }); f.emitter.emit('spawn'); f.emitter.emit('health');
    try {
      f.bot.health = 5; f.bot.food = 17; f.worker.pollSafety(); await settle();
      const waiting = f.messages.filter(m => m.type === 'bot.status').at(-1);
      assert.ok(waiting?.type === 'bot.status'); assert.equal(waiting.payload.mode, 'survival'); assert.equal(waiting.payload.action, '식량 대기');
      assert.match(waiting.payload.reason, foodFailure ? /섭취 효과/ : /현재 관측한 범위/);
      assert.equal(f.foodAttempts, 1);
      await f.worker.receive(f.assign('unsafe')); assert.equal(f.executions, 0);
    } finally { await f.worker.shutdown(); }
  }
});

test('viewer readiness cannot revive a viewer after the Minecraft session has ended', async () => {
  const f = fixture();
  let finishViewer!: (value: { version: string; close(): void }) => void;
  let closed = 0;
  const worker = new MinecraftWorker(f.launch, f.bot, message => f.messages.push(message), {
    timers: false, movementsFactory: () => ({}) as Movements,
    viewerFactory: () => new Promise(resolve => { finishViewer = resolve; }),
  });
  f.emitter.emit('spawn'); f.emitter.emit('health');
  const pending = worker.receive(f.envelope('viewer.start', { port: 4100, prefix: '/viewer/bot' }));
  await settle();
  f.emitter.emit('end', 'connection ended');
  finishViewer({ version: '1.20.4', close: () => { closed += 1; } });
  await pending;
  assert.equal(closed, 1); assert.equal(f.messages.some(message => message.type === 'viewer.ready'), false);
});

test('worker fences sessions, checks actual readiness, and deduplicates attempts', async () => {
  const f = fixture();
  try {
    await f.worker.receive(f.assign('stale', { sessionId: 'old' }));
    assert.equal(f.messages.length, 0);
    await f.worker.receive(f.assign('before-ready'));
    assert.ok(f.messages.some(message => message.type === 'task.rejected'));
    assert.equal(f.executions, 0);
    f.emitter.emit('spawn');
    assert.equal(f.messages.some(message => message.type === 'bot.ready'), false);
    f.emitter.emit('health');
    assert.ok(f.messages.some(message => message.type === 'bot.ready' && message.payload.ready));
    const assigned = f.assign('attempt');
    await f.worker.receive(assigned);
    await f.worker.receive(assigned);
    await f.worker.receive(f.assign('attempt'));
    assert.equal(f.executions, 1);
    assert.equal(f.messages.filter(message => message.type === 'task.accepted').length, 1);
    await f.worker.receive(f.envelope('task.cancel', { reason: '전환', preserveProgress: true }, { taskId: 'task', attemptId: 'attempt' }));
    const stopped = f.messages.find(message => message.type === 'task.cancelled');
    assert.ok(stopped?.type === 'task.cancelled'); assert.equal(stopped.payload.safeStopped, true); assert.equal(stopped.payload.checkpoint.step, 7);
  } finally { await f.worker.shutdown(); }
});

test('queued rules acknowledge after safe stop and uncertain API failures never claim safe cancellation', async () => {
  const f = fixture({ unknownAbort: true });
  f.emitter.emit('spawn'); f.emitter.emit('health');
  try {
    await f.worker.receive(f.assign('attempt'));
    const rules = { ...f.launch.rules, version: 2, radius: 90 };
    await f.worker.receive(f.envelope('rules.update', { rules, config: f.launch.config, mode: 'queued' }));
    assert.equal(f.messages.some(message => message.type === 'rules.applied' && message.payload.version === 2), false);
    await f.worker.receive(f.envelope('task.cancel', { reason: '전환', preserveProgress: true }, { taskId: 'task', attemptId: 'attempt' }));
    const stopped = f.messages.find(message => message.type === 'task.cancelled');
    assert.ok(stopped?.type === 'task.cancelled'); assert.equal(stopped.payload.safeStopped, false);
    assert.ok(f.messages.some(message => message.type === 'rules.applied' && message.payload.version === 2));
    assert.equal(f.launch.rules.radius, 90);
  } finally { await f.worker.shutdown(); }
});

test('urgent food interrupts normal work while moderate hunger preserves the current task', async () => {
  const f = fixture({ foodWait: true }); f.emitter.emit('spawn'); f.emitter.emit('health');
  try {
    await f.worker.receive(f.assign('attempt'));
    f.bot.food = 16; f.worker.pollSafety(); await settle();
    assert.equal(f.messages.some(message => message.type === 'task.interrupted'), false);
    assert.equal(f.foodAttempts, 0);
    f.bot.food = 6; f.worker.pollSafety(); await settle();
    const stopped = f.messages.find(message => message.type === 'task.interrupted');
    assert.ok(stopped?.type === 'task.interrupted'); assert.equal(stopped.payload.checkpoint.step, 7);
    assert.equal(f.foodAttempts, 1);
    await f.worker.receive(f.assign('too-hungry'));
    assert.equal(f.executions, 1);
  } finally { await f.worker.shutdown(); }
});

test('hostile damage interrupts long survival work and central jobs cannot displace emergency response', async () => {
  const f = fixture({ foodWait: true }); f.emitter.emit('spawn'); f.emitter.emit('health');
  try {
    f.bot.food = 10; f.worker.pollSafety(); await settle(); assert.equal(f.foodAttempts, 1);
    const zombie = { id: 2, name: 'zombie', type: 'mob', position: new Vec3(2, 64, 0) } as unknown as Entity;
    f.bot.entities[2] = zombie;
    f.emitter.emit('entityHurt', f.bot.entity, zombie); f.worker.pollSafety(); await settle();
    assert.equal(f.fights, 1);
    await f.worker.receive(f.assign('during-emergency'));
    assert.equal(f.executions, 0);
    assert.ok(f.messages.some(message => message.type === 'task.rejected'));
    assert.ok(f.messages.some(message => message.type === 'safety.alert' && message.payload.response === 'attack'));
    f.worker.centralDisconnected(); await settle();
    assert.equal(f.fights, 1); // Emergency defense may continue after controller loss.
  } finally { await f.worker.shutdown(); }
});

test('unfavorable support response withdraws with a shield rather than starting an unarmed fight', async () => {
  const f = fixture({ unarmed: true, shield: true }); f.emitter.emit('spawn'); f.emitter.emit('health');
  try {
    const zombie = { id: 2, name: 'zombie', type: 'mob', position: new Vec3(2, 64, 0) } as unknown as Entity;
    f.bot.entities[2] = zombie; f.bot.entities[3] = { ...zombie, id: 3 } as unknown as Entity;
    f.emitter.emit('entityHurt', f.bot.entity, zombie); f.worker.pollSafety(); await settle();
    assert.ok(f.messages.some(message => message.type === 'safety.alert' && message.payload.response === 'support' && message.payload.supportRequired));
    assert.equal(f.retreats, 1); assert.equal(f.fights, 0);
  } finally { await f.worker.shutdown(); }
});

test('combat executor considers nearby allies and counts only server entity-death evidence', async () => {
  const emitter = new EventEmitter();
  const target = { id: 2, uuid: 'zombie-2', name: 'zombie', type: 'mob', position: new Vec3(2, 64, 0), height: 1.8 } as unknown as Entity;
  let attacks = 0;
  let confirmDeath = true;
  const bot = Object.assign(emitter, {
    health: 20, food: 20, entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: { 2: target, 3: { ...target, id: 3 }, 4: { ...target, id: 4 } } as unknown as Record<number, Entity>,
    players: { ally: { entity: { ...target, id: 5, type: 'player' } } },
    inventory: { items: () => [{ name: 'iron_sword', count: 1 }], slots: Array.from({ length: 46 }, () => null) },
    world: { raycast: () => null }, blockAt: () => null,
    async equip() {}, async lookAt() {}, deactivateItem() {}, clearControlStates() {},
    attack(entity: Entity) { attacks += 1; delete bot.entities[entity.id]; if (confirmDeath) emitter.emit('entityDead', entity); },
  }) as unknown as Bot;
  const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'CombatBot' }, rules: {} });
  const executor = new MineflayerExecutor(bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => 'overworld' });
  const services = executor.services(new AbortController().signal); services.pause = async () => {};
  await executor.fightEntity(target, services);
  assert.equal(attacks, 1); assert.equal(services.observations.filter(o => o.kind === 'entity-death').length, 1);
  bot.entities[2] = target; confirmDeath = false;
  const unconfirmed = executor.services(new AbortController().signal); unconfirmed.pause = async () => {};
  await assert.rejects(executor.fightEntity(target, unconfirmed), /처치 확인/);
  assert.equal(unconfirmed.observations.some(o => o.kind === 'entity-death'), false);
});
