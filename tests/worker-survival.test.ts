import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import { Movements } from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { RecoveryStateSchema, WorkerLaunchSchema, type ItemStack, type JsonObject, type Position, type RecoveryState, type ResultPayload, type TaskSpec, type WorkerMessage } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { recoverDeathStep } from '../packages/minecraft/src/death-recovery';
import { MinecraftWorker } from '../packages/minecraft/src/worker';
import { checkAbort, ConditionWait, type ActionServices } from '../packages/minecraft/src/services';

function fixture(options: { restore?: RecoveryState; movementsFactory?(bot: Bot): Movements; execute?(task: TaskSpec, s: ActionServices): Promise<ResultPayload>; retreat?(entity: Entity, s: ActionServices): Promise<void> } = {}) {
  const emitter = new EventEmitter(), messages: WorkerMessage[] = [], items: ItemStack[] = [], moved: Position[] = [];
  let clock = Date.now(), executions = 0, retreats = 0, fights = 0, collected = 0;
  const cells = new Map<string, { name: string; boundingBox: 'empty' | 'block'; stateId?: number } | null>();
  const launch = WorkerLaunchSchema.parse({ botId: 'SurvivalBot', sessionId: 'session', controllerEpoch: 'epoch', config: { name: 'SurvivalBot' }, rules: { world: '127.0.0.1:25566' }, ...(options.restore ? { restoreRecovery: options.restore } : {}) });
  const bot = Object.assign(emitter, {
    health: 20, food: 20, game: { dimension: 'overworld' }, entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {} as Record<number, Entity>, players: {},
    inventory: Object.assign(new EventEmitter(), { items: () => items, slots: Array.from({ length: 46 }, () => null) }),
    currentWindow: { items: () => [{ name: 'diamond', count: 64 }] },
    pathfinder: {
      movements: {} as Movements, setGoal() {}, setMovements(m: Movements) { this.movements = m; }, thinkTimeout: 0,
      getPathTo(_m: Movements, goal: Position) {
        const p = bot.entity.position.floored(), path: Position[] = [];
        while (p.z !== goal.z) { p.z += Math.sign(goal.z - p.z); path.push({ x: p.x, y: p.y, z: p.z }); }
        while (p.x !== goal.x) { p.x += Math.sign(goal.x - p.x); path.push({ x: p.x, y: p.y, z: p.z }); }
        return { status: 'success', path };
      },
    },
    findBlocks() { return []; },
    blockAt(raw: Vec3) {
      const p = raw.floored(), k = `${p.x},${p.y},${p.z}`;
      const value = cells.has(k) ? cells.get(k) : { name: p.y < 64 ? 'grass_block' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', stateId: p.y < 64 ? 1 : 0 };
      return value ? { ...value, position: p, getProperties: () => ({}) } : null;
    },
    clearControlStates() {}, deactivateItem() {}, stopDigging() {}, quit(reason: string) { emitter.emit('end', reason); },
  }) as unknown as Bot;
  class Executor extends MineflayerExecutor {
    override async near(p: Position, signal: AbortSignal): Promise<void> {
      checkAbort(signal); moved.push({ ...p }); bot.entity.position = new Vec3(p.x, p.y, p.z);
      for (const [id, entity] of Object.entries(bot.entities)) {
        if (entity.name !== 'item' || entity.position.distanceTo(bot.entity.position) > 1.5) continue;
        const drop = entity.getDroppedItem?.(); if (!drop) continue;
        const existing = items.find(item => item.name === drop.name);
        if (existing) existing.count += drop.count; else items.push({ name: drop.name, count: drop.count });
        delete bot.entities[Number(id)]; collected += drop.count;
      }
      checkAbort(signal);
    }
    override async execute(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
      executions++; s.checkpoint.buildProtection = { origin: { x: 1, y: 64, z: 1 }, width: 5, depth: 5, height: 4 };
      s.checkpoint.placedBlocks = 7;
      if (options.execute) return options.execute(task, s);
      await s.pause(120000); throw new Error('fixture timeout');
    }
    override async retreat(e: Entity, s: ActionServices): Promise<void> { retreats++; if (options.retreat) return options.retreat(e, s); await s.pause(120000); }
    override async fightEntity(_e: Entity, s: ActionServices): Promise<void> { fights++; await s.pause(120000); }
  }
  const worker = new MinecraftWorker(launch, bot, message => messages.push(message), { timers: false, now: () => clock, movementsFactory: options.movementsFactory ?? (() => ({}) as Movements), executorFactory: (b, o) => new Executor(b, o) });
  const envelope = (type: string, payload: unknown, extra = {}) => ({ protocolVersion: 1, messageId: randomUUID(), botId: launch.botId, sessionId: launch.sessionId, controllerEpoch: launch.controllerEpoch, sentAt: clock, type, payload, ...extra });
  const task: TaskSpec = { id: 'warehouse', goalId: 'original-goal', kind: 'build', params: {}, completion: { kind: 'manual', reason: '실제 건물 확인' }, dependencies: [], reservationKeys: [] };
  const assign = (attemptId: string) => envelope('task.assign', { task, checkpoint: {}, rulesVersion: launch.rules.version }, { taskId: task.id, attemptId });
  emitter.emit('spawn'); emitter.emit('health');
  return { worker, bot, emitter, messages, launch, items, cells, moved, envelope, assign, task, now: () => clock,
    advance(ms = 10001) { clock += ms; },
    async die() { bot.health = 0; items.length = 0; emitter.emit('death'); await settle(); },
    respawn() { bot.entity.position = new Vec3(0, 64, 0); bot.health = 20; bot.food = 20; emitter.emit('spawn'); emitter.emit('health'); },
    drop(id: number, name: string, count: number, p = new Vec3(3.5, 64, 0.5)) {
      bot.entities[id] = { id, name: 'item', position: p, getDroppedItem: () => ({ name, count }) } as unknown as Entity;
    },
    service(state: RecoveryState) { const s = worker.executor.services(new AbortController().signal, state.checkpoint); s.pause = async () => {}; return s; },
    get executions() { return executions; }, get retreats() { return retreats; }, get fights() { return fights; }, get collected() { return collected; },
  };
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
function latestRecovery(messages: WorkerMessage[]): RecoveryState {
  const message = messages.filter(message => message.type === 'bot.recovery').at(-1);
  assert.ok(message?.type === 'bot.recovery'); return message.payload;
}
function recovery(now: number, prior: ItemStack[] = [{ name: 'oak_log', count: 4 }]): RecoveryState {
  return RecoveryStateSchema.parse({ deathId: randomUUID(), occurredAt: now, world: '127.0.0.1:25566', dimension: 'overworld', position: { x: 3, y: 64, z: 0 }, priorInventory: prior, phase: 'recovering', reason: '실제 회수 확인', attemptCount: 0, progress: { recoveredCount: 0, remainingCount: prior.reduce((sum, item) => sum + item.count, 0) }, updatedAt: now });
}

test('movement never uses recovered dirt as an implicit bridge or tower inside a reserved building', async () => {
  const f = fixture({ movementsFactory(bot) { Object.assign(bot, { registry: minecraftData('1.21.1') }); return new Movements(bot); } });
  try {
    f.items.push({ name: 'dirt', count: 1, ...{ type: f.bot.registry.itemsByName.dirt!.id } });
    assert.equal(new Movements(f.bot).countScaffoldingItems(), 1, 'the installed library normally accepts this dirt for bridges');
    assert.equal(f.bot.pathfinder.movements.countScaffoldingItems(), 0);
    assert.equal(f.bot.pathfinder.movements.getScaffoldingItem(), null);
    await f.die(); f.respawn(); await settle();
    f.items.push({ name: 'dirt', count: 1, ...{ type: f.bot.registry.itemsByName.dirt!.id } });
    assert.equal(f.bot.pathfinder.movements.countScaffoldingItems(), 0, 'respawn also prevents the real library from using recovered dirt');
  } finally { await f.worker.shutdown(); }
});

test('idle and local-combat deaths always retain the last live player inventory and exact death location', async () => {
  for (const combat of [false, true]) {
    const f = fixture();
    try {
      f.items.push({ name: 'oak_log', count: 4 }); f.emitter.emit('health');
      if (combat) {
        const skeleton = { id: 2, uuid: 'actual-threat', name: 'skeleton', position: new Vec3(2, 64, 0) } as unknown as Entity;
        f.bot.entities[2] = skeleton; f.emitter.emit('entityHurt', f.bot.entity, skeleton);
        f.worker.pollSafety(); await settle(); assert.equal(f.retreats, 1);
      }
      f.bot.entity.position = new Vec3(7.25, 65, -3.5); await f.die(); f.emitter.emit('death');
      const deaths = f.messages.filter(message => message.type === 'bot.died'); assert.equal(deaths.length, 1);
      assert.ok(deaths[0]?.type === 'bot.died');
      assert.deepEqual(deaths[0].payload.priorInventory, [{ name: 'oak_log', count: 4 }]);
      assert.deepEqual(deaths[0].payload.position, { x: 7.25, y: 65, z: -3.5 });
      assert.equal(latestRecovery(f.messages).phase, 'waiting-respawn');
      assert.equal(latestRecovery(f.messages).safe, false);
      assert.equal(f.messages.some(message => message.type === 'task.result'), false);
    } finally { await f.worker.shutdown(); }
  }
});

test('death preserves the original build attempt and gates assignment until actual matching items are recovered safely', async () => {
  const f = fixture();
  try {
    f.items.push({ name: 'oak_log', count: 4 }); f.emitter.emit('health');
    await f.worker.receive(f.assign('original')); f.bot.entity.position = new Vec3(3, 64, 0); await f.die();
    const interrupted = f.messages.find(message => message.type === 'task.interrupted');
    assert.ok(interrupted?.type === 'task.interrupted'); assert.equal(interrupted.payload.safeStopped, true);
    assert.equal(interrupted.payload.checkpoint.placedBlocks, 7);
    assert.equal(f.messages.some(message => message.type === 'task.result' && message.payload.outcome === 'completed'), false);
    f.respawn(); await f.worker.receive(f.assign('too-early')); assert.equal(f.executions, 1);
    f.drop(3, 'oak_log', 4); f.worker.pollSafety(); await new Promise(resolve => setTimeout(resolve, 280));
    const confirmed = latestRecovery(f.messages);
    assert.equal(confirmed.phase, 'resolved'); assert.equal(confirmed.safe, true);
    assert.deepEqual(confirmed.progress, { recoveredCount: 4, remainingCount: 0, lostCount: 0 });
    assert.deepEqual(confirmed.checkpoint.buildProtection, { origin: { x: 1, y: 64, z: 1 }, width: 5, depth: 5, height: 4 });
    await f.worker.receive(f.assign('after-recovery')); assert.equal(f.executions, 2);
  } finally { await f.worker.shutdown(); }
});

test('an unfinished old-life combat action cannot overlap the respawn or start another action after cleanup', async () => {
  let release!: () => void;
  const oldLifeBarrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ async retreat(_entity, s) { await oldLifeBarrier; s.check(); throw new Error('old life must be aborted'); } });
  try {
    const skeleton = { id: 2, uuid: 'skeleton-uuid', name: 'skeleton', position: new Vec3(2, 64, 0) } as unknown as Entity;
    f.bot.entities[2] = skeleton; f.emitter.emit('entityHurt', f.bot.entity, skeleton);
    f.worker.pollSafety(); await settle(); assert.equal(f.retreats, 1);
    f.bot.health = 0; f.emitter.emit('death'); f.respawn(); await settle();
    assert.equal(f.messages.filter(message => message.type === 'bot.ready').length, 1, 'new-life readiness waits for actual old-action settlement');
    await f.worker.receive(f.assign('overlap')); assert.equal(f.executions, 0);
    delete f.bot.entities[2]; release(); await settle();
    assert.equal(f.messages.filter(message => message.type === 'bot.ready').length, 2);
    f.worker.pollSafety(); await settle();
    assert.equal(latestRecovery(f.messages).phase, 'resolved'); assert.equal(f.retreats, 1);
    assert.equal(f.fights, 0);
    const status = f.messages.filter(message => message.type === 'bot.status').at(-1);
    assert.ok(status?.type === 'bot.status'); assert.equal(status.payload.action, '대기');
  } finally { release(); await f.worker.shutdown(); }
});

test('partial death recovery credits only actual matching inventory increases and keeps its finite budget across restart', async () => {
  const f = fixture();
  const state = recovery(f.now());
  try {
    f.drop(3, 'oak_log', 2); f.drop(4, 'diamond', 64, new Vec3(20, 64, 0));
    await recoverDeathStep(f.bot, state, f.service(state), () => {}, true, f.now);
    assert.equal(state.phase, 'held'); assert.equal(state.progress.recoveredCount, 2); assert.equal(state.progress.remainingCount, 2);
    assert.equal(f.items.some(item => item.name === 'diamond'), false);
    const restored = structuredClone(state);
    restored.attemptCount = 4;
    const second = fixture({ restore: restored });
    try {
      second.items.push({ name: 'oak_log', count: 2 }); second.drop(5, 'oak_log', 2);
      second.worker.pollSafety(); await new Promise(resolve => setTimeout(resolve, 280));
      const result = latestRecovery(second.messages);
      assert.equal(result.attemptCount, 5, 'restart does not renew the attempt budget');
      assert.equal(result.progress.recoveredCount, 4); assert.equal(result.progress.remainingCount, 0); assert.equal(result.safe, true);
      const cp = result.checkpoint.deathRecovery as JsonObject;
      assert.deepEqual(cp.anchor, { x: 0, y: 64, z: 0 }, 'first-respawn search origin is preserved');
    } finally { await second.worker.shutdown(); }
  } finally { await f.worker.shutdown(); }
});

test('one bounded recovery step collects several matching stacks and skips an unsafe nearer drop without blocking safe supplies', async () => {
  const f = fixture(), state = recovery(f.now(), [{ name: 'oak_log', count: 100 }, { name: 'chest', count: 2 }, { name: 'bread', count: 8 }]);
  try {
    state.position = { x: 5, y: 64, z: 0 };
    f.drop(2, 'oak_log', 10, new Vec3(3.5, 64, 0.5));
    f.cells.set('3,64,0', { name: 'water', boundingBox: 'empty' });
    f.drop(3, 'oak_log', 64, new Vec3(5.5, 64, 3.5));
    f.drop(4, 'oak_log', 26, new Vec3(6.5, 64, 3.5));
    f.drop(5, 'chest', 2, new Vec3(7.5, 64, 1.5));
    f.drop(6, 'bread', 8, new Vec3(6.5, 64, -2.5));
    await recoverDeathStep(f.bot, state, f.service(state), () => {}, true, f.now);
    assert.equal(state.attemptCount, 1, 'one destination/stack does not consume a whole retry');
    assert.equal(state.progress.recoveredCount, 100); assert.equal(state.progress.remainingCount, 10);
    assert.equal(f.items.find(item => item.name === 'oak_log')?.count, 90);
    assert.equal(f.items.find(item => item.name === 'chest')?.count, 2);
    assert.equal(f.items.find(item => item.name === 'bread')?.count, 8);
    assert.equal(f.moved.some(p => Math.floor(p.x) === 3 && Math.floor(p.z) === 0), false);
    assert.ok((state.checkpoint.deathRecovery as JsonObject).failed);
  } finally { await f.worker.shutdown(); }
});

test('matching drops scattered beyond six blocks and just below a block boundary use the actually safe observed floor', async () => {
  const f = fixture(), state = recovery(f.now(), [{ name: 'bread', count: 8 }, { name: 'oak_log', count: 2 }]);
  try {
    const belowBoundary = new Vec3(9.53, 63.9525, 1.373);
    const aboveBoundary = new Vec3(11.2, 65.0001, 1.6);
    f.drop(3, 'bread', 8, belowBoundary); f.drop(4, 'oak_log', 2, aboveBoundary);
    assert.ok(belowBoundary.distanceTo(new Vec3(3, 64, 0)) > 6);
    await recoverDeathStep(f.bot, state, f.service(state), () => {}, true, f.now);
    assert.equal(state.phase, 'resolved'); assert.equal(state.progress.recoveredCount, 10); assert.equal(state.progress.remainingCount, 0);
    assert.equal(state.attemptCount, 1);
    assert.ok(f.moved.some(p => Math.floor(p.x) === 9 && p.y === 64), 'y=63.95 is picked up from the loaded ground at feet y=64');
    assert.ok(f.moved.some(p => Math.floor(p.x) === 11 && p.y === 64), 'y=65.0001 does not require an unsupported floating stand');
    assert.equal(f.moved.some(p => p.y !== 64), false, 'no underground or floating destination is executed');
    assert.equal(f.collected, 10);
  } finally { await f.worker.shutdown(); }
});

test('actual material consumption in rapid task progress updates the last-live inventory before death', async () => {
  const f = fixture({ async execute(_task, s) {
    f.items[0]!.count = 71;
    s.progress('건설', '실제 블록 17개를 설치했습니다.');
    await s.pause(120000); throw new Error('fixture timeout');
  } });
  try {
    f.items.push({ name: 'oak_planks', count: 88 }); f.emitter.emit('health');
    await f.worker.receive(f.assign('rapid-build'));
    await f.die();
    const death = f.messages.find(message => message.type === 'bot.died');
    assert.ok(death?.type === 'bot.died');
    assert.deepEqual(death.payload.priorInventory, [{ name: 'oak_planks', count: 71 }], 'already placed materials are not presented as missing death drops');
  } finally { await f.worker.shutdown(); }
});

test('public player-window slot changes update the live cache without a heartbeat while a death clear cannot overwrite it', async () => {
  const f = fixture();
  try {
    f.items.push({ name: 'oak_planks', count: 88 }); f.emitter.emit('health');
    f.items[0]!.count = 71; f.bot.inventory.emit('updateSlot', 36, null, null);
    await settle();
    f.items.length = 0; f.bot.inventory.emit('updateSlot', 36, null, null);
    f.bot.health = 0; f.emitter.emit('death'); await settle();
    const death = f.messages.find(message => message.type === 'bot.died');
    assert.ok(death?.type === 'bot.died');
    assert.deepEqual(death.payload.priorInventory, [{ name: 'oak_planks', count: 71 }]);
    assert.equal(f.bot.inventory.listenerCount('updateSlot'), 1);
  } finally { await f.worker.shutdown(); assert.equal(f.bot.inventory.listenerCount('updateSlot'), 0); }
});

test('unsafe corpse terrain and absent matching drops resolve honestly after five attempts without entering danger', async () => {
  for (const obstacle of ['water', 'unknown', 'no-drop']) {
    const f = fixture(), state = recovery(f.now());
    try {
      if (obstacle !== 'no-drop') {
        f.drop(3, 'oak_log', 4);
        f.cells.set('3,64,0', obstacle === 'unknown' ? null : { name: 'water', boundingBox: 'empty' });
      }
      for (let i = 0; i < 5; i++) { await recoverDeathStep(f.bot, state, f.service(state), () => {}, true, f.now); f.advance(); }
      assert.equal(state.phase, 'resolved'); assert.equal(state.attemptCount, 5);
      assert.deepEqual(state.progress, { recoveredCount: 0, remainingCount: 4, lostCount: 4 });
      assert.equal(state.safe, true, 'the actual respawn remains safe even when the corpse is inaccessible');
      assert.equal(f.collected, 0);
      if (obstacle !== 'no-drop') assert.equal(f.moved.length, 0, 'water and unknown cells never receive a movement action');
    } finally { await f.worker.shutdown(); }
  }
});

test('paused recovery and expired drops preserve truthful counts without optional movement; unloaded current ground remains unsafe', async () => {
  const f = fixture(), state = recovery(f.now());
  try {
    f.drop(3, 'oak_log', 4);
    await recoverDeathStep(f.bot, state, f.service(state), () => {}, false, f.now);
    assert.equal(state.phase, 'held'); assert.equal(state.attemptCount, 0); assert.equal(f.moved.length, 0);
    f.advance(300001); f.cells.set('0,63,0', null);
    await recoverDeathStep(f.bot, state, f.service(state), () => {}, true, f.now);
    assert.equal(state.phase, 'resolved'); assert.equal(state.safe, false); assert.equal(state.progress.recoveredCount, 0); assert.equal(state.progress.remainingCount, 4);
    assert.equal(f.moved.length, 0);
    f.cells.delete('0,63,0');
    await recoverDeathStep(f.bot, state, f.service(state), () => {}, true, f.now);
    assert.equal(state.safe, true, 'resolved recovery is revalidated against an actually loaded current stand');
  } finally { await f.worker.shutdown(); }
});

test('a nearby recovery threat requests deduplicated support, preserves recovery, and never approaches the hostile corpse', async () => {
  const f = fixture({ restore: recovery(Date.now()) });
  try {
    f.bot.entities[2] = { id: 2, uuid: 'death-area-hostile', name: 'zombie', position: new Vec3(10, 64, 0) } as unknown as Entity;
    for (let i = 0; i < 3; i++) { f.worker.pollSafety(); await settle(); f.advance(); }
    const requests = f.messages.filter(message => message.type === 'safety.alert' && message.payload.supportRequired);
    assert.equal(requests.length, 1); assert.ok(requests[0]?.type === 'safety.alert');
    assert.equal(requests[0].payload.threats[0]?.entityId, 'death-area-hostile');
    assert.equal(latestRecovery(f.messages).phase, 'held'); assert.equal(latestRecovery(f.messages).safe, false);
    assert.equal(f.moved.length, 0); assert.equal(f.fights, 0); assert.equal(f.retreats, 0);
    await f.worker.receive(f.assign('dangerous')); assert.equal(f.executions, 0);
    f.advance(300001); f.worker.pollSafety(); await settle();
    assert.equal(latestRecovery(f.messages).phase, 'resolved', 'expired drops do not remain an endless held recovery');
    assert.equal(latestRecovery(f.messages).progress.remainingCount, 4);
    assert.equal(latestRecovery(f.messages).safe, false, 'expired recovery does not invent a safe ordinary-work state');
    await f.worker.receive(f.assign('expired-but-dangerous')); assert.equal(f.executions, 0);
  } finally { await f.worker.shutdown(); }
});

test('failed emergency response does not retry on a clock or unknown terrain; a confirmed terrain or threat change permits one retry', async () => {
  const f = fixture({ async retreat(entity, s) {
    s.checkpoint.retreatRecovery = { anchor: { x: 0, y: 64, z: 0 }, threatId: entity.uuid ?? `${entity.id}`, threatName: 'skeleton', threatPosition: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, attempts: 6, elapsedMs: 30000, probes: [{ position: { x: 1, y: 64, z: 1 }, name: 'air', stateId: 0 }], failed: [], status: 'waiting', reason: '안전한 엄폐 경로 없음' };
    throw new ConditionWait('안전한 엄폐 경로 없음', s.checkpoint);
  } });
  try {
    const skeleton = { id: 2, uuid: 'support-uuid', name: 'skeleton', position: new Vec3(2, 64, 0) } as unknown as Entity;
    f.bot.entities[2] = skeleton; f.emitter.emit('entityHurt', f.bot.entity, skeleton);
    f.worker.pollSafety(); await settle(); assert.equal(f.retreats, 1); assert.equal(f.fights, 0);
    const initialAlerts = f.messages.filter(message => message.type === 'safety.alert').length;
    for (let i = 0; i < 10; i++) { f.advance(1000); f.worker.pollSafety(); await settle(); }
    assert.equal(f.retreats, 1); assert.equal(f.messages.filter(message => message.type === 'safety.alert').length, initialAlerts);
    f.cells.set('1,64,1', null); f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.retreats, 1);
    f.cells.set('1,64,1', { name: 'air', boundingBox: 'empty', stateId: 1 });
    f.advance(); f.worker.pollSafety(); await settle(); assert.equal(f.retreats, 2, 'a loaded state change can re-evaluate the safe route');
    skeleton.position.x += 1; f.advance(100); f.worker.pollSafety(); await settle(); assert.equal(f.retreats, 2, 'real changes still obey minimum cooldown');
    f.advance(5001); f.worker.pollSafety(); await settle(); assert.equal(f.retreats, 3);
    const support = f.messages.filter(message => message.type === 'safety.alert').at(-1);
    assert.ok(support?.type === 'safety.alert'); assert.equal(support.payload.threats[0]?.entityId, 'support-uuid');
  } finally { await f.worker.shutdown(); }
});
