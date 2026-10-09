import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { FleetController } from '../packages/core/src';
import { verifyCompletion } from '../packages/core/src/verification';
import { FleetCheckpointSchema, FleetSnapshotSchema, type CentralMessage, type ContainerRef, type ObservationInput } from '../packages/contracts/src';

const world = '127.0.0.1:25566', dimension = 'overworld';
const warehouse: ContainerRef = { id: 'warehouse', position: { x: 3, y: 64, z: 3 }, world, dimension };
function fixture(botCount = 1, decide?: ConstructorParameters<typeof FleetController>[0]['decide']) {
  let now = 100000;
  const sent: CentralMessage[] = [];
  const events: { type: string; commandId?: string }[] = [];
  const core = new FleetController({ controllerEpoch: 'epoch', now: () => now, send: (_id, message) => sent.push(message), onChange: (_state, event) => events.push(event), rules: { autonomyEnabled: false, world, dimension, warehouse, center: { x: 0, y: 64, z: 0 } }, decide });
  function receive(botId: string, type: string, payload: unknown, task?: Extract<CentralMessage, { type: 'task.assign' }>, extra = {}) {
    return core.onWorkerMessage({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: core.controllerEpoch, botId, sessionId: core.getSnapshot().agents.find(a => a.id === botId)?.session?.id, sentAt: now, type, payload, ...(task ? { taskId: task.taskId, attemptId: task.attemptId } : {}), ...extra });
  }
  function status(botId: string, inventory: { name: string; count: number }[] = [], mode = 'idle', capabilities = ['collect', 'store', 'explore', 'home', 'guard', 'build', 'fight', 'hunt']) {
    return receive(botId, 'bot.status', { ready: true, world, dimension, position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory, action: 'idle', reason: 'ready', mode, capabilities, rulesVersion: core.getSnapshot().rules.version });
  }
  function ready(botId: string) { status(botId); receive(botId, 'rules.applied', { version: core.getSnapshot().rules.version }); }
  for (let i = 0; i < botCount; i++) { core.addAgent({ id: `bot-${i}`, name: `Worker${i}`, role: 'gatherer' }); core.startSession(`bot-${i}`, `session-${i}`); ready(`bot-${i}`); }
  function obs(kind: string, data: unknown): ObservationInput { return { id: randomUUID(), kind, data, world, dimension, observedAt: now } as ObservationInput; }
  function observeStock(count: number, botId = 'bot-0', item = 'oak_log') { receive(botId, 'world.observed', { observations: [obs('container', { container: warehouse, items: [{ name: item, count }] })] }); }
  function assignments() { return sent.filter((m): m is Extract<CentralMessage, { type: 'task.assign' }> => m.type === 'task.assign'); }
  function latest(botId = 'bot-0') { const assignment = assignments().filter(m => m.botId === botId).at(-1); assert.ok(assignment); return assignment; }
  function begin(task = latest()) { receive(task.botId, 'task.accepted', {}, task); receive(task.botId, 'task.started', {}, task); }
  function result(task: Extract<CentralMessage, { type: 'task.assign' }>, payload: unknown) { return receive(task.botId, 'task.result', { observations: [], evidence: [], checkpoint: {}, ...payload as object }, task); }
  return { core, sent, events, receive, status, ready, observeStock, assignments, latest, begin, result, obs, advance: (ms: number) => { now += ms; }, now: () => now };
}

for (const count of [0, 1, 5, 20]) test(`dynamic registration and exclusive execution with ${count} workers`, () => {
  const f = fixture(count);
  for (let i = 0; i < Math.max(1, count); i++) f.core.createGoal({ kind: 'home', params: { position: { x: i + 10, y: 64, z: 0 } } });
  assert.equal(f.assignments().length, count);
  assert.equal(new Set(f.assignments().map(m => m.attemptId)).size, count);
  assert.equal(new Set(f.assignments().map(m => m.botId)).size, count);
  for (const message of f.assignments()) f.begin(message);
  f.core.tick();
  assert.equal(f.assignments().length, count, 'repeated scheduler ticks cannot assign an active bot twice');
});

test('accepted work differs from started work; duplicate and stale messages cannot mutate execution', () => {
  const f = fixture(); f.core.createGoal({ kind: 'home', params: { position: { x: 10, y: 64, z: 0 } } });
  const task = f.latest();
  f.receive(task.botId, 'task.accepted', {}, task);
  assert.equal(f.core.getSnapshot().tasks.find(t => t.id === task.taskId)?.state, 'accepted');
  assert.equal(f.core.getSnapshot().attempts[0].startedAt, undefined);
  f.receive(task.botId, 'task.started', {}, task);
  assert.equal(f.core.getSnapshot().tasks[0].state, 'running');
  assert.equal(f.receive(task.botId, 'task.result', { outcome: 'completed' }, task, { controllerEpoch: 'old-epoch' }), false);
  assert.equal(f.receive(task.botId, 'task.result', { outcome: 'completed' }, task, { sessionId: 'old-session' }), false);
  assert.equal(f.receive(task.botId, 'task.result', { outcome: 'completed' }, task, { attemptId: 'old-attempt' }), false);
  f.result(task, { outcome: 'completed', observations: [f.obs('position', { position: { x: 10, y: 64, z: 0 } })] });
  const revision = f.core.getSnapshot().revision;
  assert.equal(f.result(task, { outcome: 'completed' }), false);
  assert.equal(f.core.getSnapshot().revision, revision);
});

test('a success claim without actual observations is held', () => {
  const f = fixture(); const goal = f.core.createGoal({ kind: 'home', params: { position: { x: 10, y: 64, z: 0 } } });
  f.result(f.latest(), { outcome: 'completed' });
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)?.state, 'held');
});

test('collect total uses existing shared stock, then requires paired delivery evidence', () => {
  const f = fixture(); f.observeStock(10);
  const goal = f.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 32 });
  const collect = f.latest(); assert.equal(collect.payload.task.kind, 'collect'); assert.equal(collect.payload.task.params.quantity, 22);
  f.begin(collect);
  f.result(collect, { outcome: 'completed', observations: [f.obs('inventory', { items: [{ name: 'oak_log', count: 22 }] })] });
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)?.state, 'active', 'inventory does not complete warehouse goals');
  const store = f.latest(); assert.equal(store.payload.task.kind, 'store'); assert.equal(store.botId, collect.botId);
  f.begin(store);
  f.result(store, { outcome: 'completed', observations: [f.obs('inventory', { items: [] }), f.obs('container', { container: warehouse, items: [{ name: 'oak_log', count: 32 }] })], evidence: [{ kind: 'transfer', container: warehouse, item: 'oak_log', quantity: 22, direction: 'store', beforeInventory: 22, afterInventory: 0, beforeContainer: 10, afterContainer: 32 }] });
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)?.state, 'completed');
  const attempts = f.assignments().length; f.observeStock(0); f.core.tick();
  assert.equal(f.assignments().length, attempts, 'once-completed collection does not silently become maintenance');
});

test('additional quantity freezes warehouse baseline; maintain stock reactivates only after shortage', () => {
  const f = fixture(2); f.observeStock(10);
  const additional = f.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 32, quantityMode: 'additional' });
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === additional.id)?.targetQuantity, 42);
  const maintain = f.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 8, mode: 'maintain' });
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === maintain.id)?.state, 'maintaining');
  f.advance(1); f.observeStock(3);
  assert.notEqual(f.core.getSnapshot().goals.find(g => g.id === maintain.id)?.state, 'maintaining');
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === additional.id)?.targetQuantity, 42);
});

test('container reservations serialize store tasks while resource acquisition can run in parallel', () => {
  const f = fixture(2); f.observeStock(0);
  f.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 8 });
  f.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 8 });
  const collects = f.assignments(); assert.equal(collects.length, 2);
  for (const collect of collects) f.result(collect, { outcome: 'completed', observations: [f.obs('inventory', { items: [{ name: 'oak_log', count: 8 }] })] });
  assert.equal(f.assignments().filter(m => m.payload.task.kind === 'store').length, 1);
  assert.equal(f.core.getSnapshot().reservations.filter(r => r.key.startsWith('container:')).length, 1);
});

test('transient errors allow the initial execution plus five retries, then hold', () => {
  const f = fixture(); f.core.createGoal({ kind: 'home', params: { position: { x: 10, y: 64, z: 0 } } });
  for (let i = 0; i < 6; i++) {
    const task = f.latest(); f.begin(task); f.result(task, { outcome: 'failed', error: { code: 'PATH', message: 'temporary obstruction', retryable: true, effectsKnown: true } });
    f.advance(40000); f.status('bot-0'); f.core.tick();
  }
  assert.equal(f.assignments().length, 6);
  assert.equal(f.core.getSnapshot().tasks[0].retryCount, 5);
  assert.equal(f.core.getSnapshot().tasks[0].state, 'held');
});

test('uncertain effects are held instead of retried; heartbeat loss does not release ownership', () => {
  const f = fixture(2); f.core.createGoal({ kind: 'home', params: { position: { x: 10, y: 64, z: 0 } } });
  const task = f.latest('bot-0'); f.begin(task); f.advance(10000); f.core.tick();
  assert.equal(f.core.getSnapshot().agents[0].status, 'abnormal');
  assert.equal(f.core.getSnapshot().agents[0].session?.activeAttemptId, task.attemptId);
  f.status('bot-1'); assert.equal(f.assignments().length, 1);
  f.result(task, { outcome: 'failed', error: { code: 'LOST', message: 'unknown effect', retryable: true, effectsKnown: false } });
  f.advance(30000); f.status('bot-0'); assert.equal(f.assignments().length, 1);
});

test('safe removal waits for cancellation and actual process exit, then reassigns remaining work', () => {
  const f = fixture(2); const goal = f.core.createGoal({ kind: 'home', params: { position: { x: 10, y: 64, z: 0 } }, preferredBotId: 'bot-0' });
  const task = f.latest('bot-0'); f.begin(task); f.core.removeAgent('bot-0', 'remove-command');
  assert.equal(f.core.getSnapshot().agents[0].status, 'removing');
  assert.equal(f.assignments().length, 1);
  assert.equal(f.events.some(e => e.commandId === 'remove-command' && e.type === 'command.applied'), false);
  f.receive('bot-0', 'task.cancelled', { safeStopped: true, checkpoint: { visited: 3 }, observations: [] }, task);
  assert.ok(f.sent.some(m => m.type === 'bot.shutdown'));
  assert.equal(f.core.getSnapshot().agents[0].status, 'removing');
  f.core.confirmWorkerStopped('bot-0', 'session-0');
  assert.equal(f.core.getSnapshot().agents[0].status, 'removed');
  assert.ok(f.events.some(e => e.commandId === 'remove-command' && e.type === 'command.applied'));
  const replacement = f.latest('bot-1'); assert.equal(replacement.payload.task.goalId, goal.id);
});

test('emergency interruption preserves progress and does not consume error retries', () => {
  const f = fixture(); f.core.createGoal({ kind: 'home', params: { position: { x: 10, y: 64, z: 0 } } }); const task = f.latest(); f.begin(task);
  f.receive('bot-0', 'task.interrupted', { safeStopped: true, reason: 'counterattack', checkpoint: { progress: 0.4 }, observations: [] }, task);
  assert.equal(f.core.getSnapshot().tasks[0].retryCount, 0); assert.equal(f.assignments().length, 1);
  f.status('bot-0'); const resumed = f.latest(); assert.notEqual(resumed.attemptId, task.attemptId); assert.equal(resumed.payload.checkpoint.progress, 0.4);
});

test('role changes apply after actual ack and old config acknowledgements cannot apply the new role', () => {
  const f = fixture(); f.core.createGoal({ kind: 'home', params: { position: { x: 10, y: 64, z: 0 } } }); const task = f.latest();
  f.core.updateAgent('bot-0', { role: 'guard' }, 'queued', 'role-command');
  assert.equal(f.core.getSnapshot().agents[0].config.role, 'gatherer');
  f.receive('bot-0', 'rules.applied', { version: 1 }); assert.equal(f.core.getSnapshot().agents[0].config.role, 'gatherer');
  f.result(task, { outcome: 'completed', observations: [f.obs('position', { position: { x: 10, y: 64, z: 0 } })] });
  f.receive('bot-0', 'rules.applied', { version: f.core.getSnapshot().rules.version });
  assert.equal(f.core.getSnapshot().agents[0].config.role, 'guard'); assert.ok(f.events.some(e => e.commandId === 'role-command' && e.type === 'command.applied'));
});

test('restarted controller fences old results and requires stopped worker plus postrestart warehouse observation', () => {
  const f = fixture(); f.observeStock(0); const goal = f.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 32 }); const oldTask = f.latest(); f.begin(oldTask);
  const sent: CentralMessage[] = []; const restored = new FleetController({ now: f.now, controllerEpoch: 'new-epoch', send: (_id, m) => sent.push(m), checkpoint: f.core.checkpoint() });
  assert.equal(restored.getSnapshot().tasks[0].state, 'held');
  assert.equal(restored.onWorkerMessage({ ...oldTask, type: 'task.result', payload: { outcome: 'completed' } }), false);
  restored.startSession('bot-0', 'new-session');
  const receive = (type: string, payload: unknown) => restored.onWorkerMessage({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: 'new-epoch', botId: 'bot-0', sessionId: 'new-session', sentAt: f.now(), type, payload });
  receive('bot.ready', { ready: true, world, dimension, health: 20, food: 20, inventory: [], mode: 'idle', action: 'idle', reason: 'ready', capabilities: ['collect', 'store'], rulesVersion: 1 });
  receive('rules.applied', { version: 1 });
  receive('world.observed', { observations: [f.obs('container', { container: warehouse, items: [] })] });
  assert.equal(sent.some(m => m.type === 'task.assign'), false);
  restored.confirmWorkerStopped('bot-0', 'session-0');
  assert.equal(restored.getSnapshot().goals.find(g => g.id === goal.id)?.state, 'active');
  assert.equal(sent.filter(m => m.type === 'task.assign').length, 1);
});

test('repeated transfer proof cannot inflate quantity and disappearance cannot prove a kill', () => {
  const f = fixture(); const evidence = { kind: 'transfer' as const, container: warehouse, item: 'oak_log', quantity: 8, direction: 'store' as const, beforeInventory: 8, afterInventory: 0, beforeContainer: 0, afterContainer: 8 };
  const context = { observations: [f.obs('inventory', { items: [] }), f.obs('container', { container: warehouse, items: [{ name: 'oak_log', count: 8 }] })].map(o => ({ ...o, receivedAt: f.now(), controllerEpoch: 'epoch', botId: 'bot-0', sessionId: 'session-0' })), evidence: [evidence, evidence], now: f.now(), maxAgeMs: 30000, world, dimension };
  assert.equal(verifyCompletion({ kind: 'transfer', container: warehouse, item: 'oak_log', quantity: 16, direction: 'store' }, context).complete, false);
  assert.equal(verifyCompletion({ kind: 'entity-death', minimum: 1, targetName: 'zombie' }, context).complete, false);
});

test('Laya choices are bounded to current eligible tasks and never override priority', async () => {
  let resolve: (decision: { id: string; source: 'laya'; reason: string }) => void = () => {};
  const f = fixture(0, () => new Promise(r => { resolve = r; }));
  f.core.addAgent({ id: 'bot-0', name: 'Worker0' }); f.core.startSession('bot-0', 'session-0');
  const a = f.core.createGoal({ kind: 'home', params: { position: { x: 5, y: 64, z: 0 } } });
  f.core.createGoal({ kind: 'home', params: { position: { x: 8, y: 64, z: 0 } } });
  f.ready('bot-0'); await Promise.resolve();
  f.core.cancelGoal(a.id);
  resolve({ id: f.core.getSnapshot().tasks.find(t => t.goalId === a.id)!.id, source: 'laya', reason: 'late choice' });
  await new Promise(r => setImmediate(r));
  assert.equal(f.assignments().length, 1);
  assert.notEqual(f.assignments()[0].payload.task.goalId, a.id);
  assert.ok(f.core.getSnapshot().events.some(e => e.type === 'scheduler.decision' && e.data?.source === 'code'));
});

test('immediate switch preserves old progress and resumes after the new goal finishes', () => {
  const f = fixture(); const old = f.core.createGoal({ kind: 'home', params: { position: { x: 20, y: 64, z: 0 } } }); const active = f.latest();
  const urgent = f.core.createGoal({ kind: 'home', params: { position: { x: 5, y: 64, z: 0 } }, preferredBotId: 'bot-0', executionMode: 'immediate' });
  assert.equal(f.assignments().length, 1);
  f.receive('bot-0', 'task.cancelled', { safeStopped: true, checkpoint: { pathStep: 4 }, observations: [] }, active);
  const switched = f.latest(); assert.equal(switched.payload.task.goalId, urgent.id);
  f.result(switched, { outcome: 'completed', observations: [f.obs('position', { position: { x: 5, y: 64, z: 0 } })] });
  const resumed = f.latest(); assert.equal(resumed.payload.task.goalId, old.id); assert.equal(resumed.payload.checkpoint.pathStep, 4); assert.notEqual(resumed.attemptId, active.attemptId);
});

test('preferred incapable bots fall back; the primary role is chosen before permitted helpers', () => {
  const f = fixture(2); f.status('bot-0', [], 'idle', ['collect']);
  const goal = f.core.createGoal({ kind: 'home', preferredBotId: 'bot-0', params: { position: { x: 5, y: 64, z: 0 } } });
  assert.equal(f.latest('bot-1').payload.task.goalId, goal.id);
  const g = fixture(0);
  g.core.addAgent({ id: 'bot-0', name: 'Helper01', role: 'general' }); g.core.startSession('bot-0', 'session-0'); g.ready('bot-0');
  g.core.addAgent({ id: 'bot-1', name: 'Guard01', role: 'guard' }); g.core.startSession('bot-1', 'session-1'); g.ready('bot-1');
  g.core.createGoal({ kind: 'fight', quantity: 1, params: { targetName: 'zombie' } });
  assert.equal(g.assignments()[0].botId, 'bot-1');
});

test('goal cancellation and pause complete only after actual safe stop and applied settings', () => {
  const f = fixture(); const goal = f.core.createGoal({ kind: 'home', params: { position: { x: 8, y: 64, z: 0 } } }); const active = f.latest();
  f.core.cancelGoal(goal.id, 'cancel-goal');
  assert.equal(f.core.getSnapshot().goals[0].state, 'cancelling'); assert.equal(f.events.some(e => e.commandId === 'cancel-goal' && e.type === 'command.applied'), false);
  f.receive('bot-0', 'task.cancelled', { safeStopped: true, observations: [], checkpoint: {} }, active);
  assert.equal(f.core.getSnapshot().goals[0].state, 'cancelled'); assert.ok(f.events.some(e => e.commandId === 'cancel-goal' && e.type === 'command.applied'));
  f.core.pauseAgent('bot-0', 'pause-command'); assert.equal(f.core.getSnapshot().agents[0].config.enabled, true);
  f.receive('bot-0', 'rules.applied', { version: f.core.getSnapshot().rules.version });
  assert.equal(f.core.getSnapshot().agents[0].config.enabled, false);
  assert.ok(f.events.some(e => e.commandId === 'pause-command' && e.type === 'command.applied'));
  const restored = new FleetController({ checkpoint: f.core.checkpoint(), now: f.now, send: () => {} });
  assert.equal(restored.getSnapshot().agents[0].status, 'paused');
});

test('superseded queued settings are failed rather than falsely marked applied', () => {
  const f = fixture(); f.core.createGoal({ kind: 'home', params: { position: { x: 8, y: 64, z: 0 } } }); const active = f.latest();
  f.core.updateAgent('bot-0', { role: 'farmer' }, 'queued', 'role-first');
  f.core.updateAgent('bot-0', { role: 'guard' }, 'queued', 'role-second');
  f.result(active, { outcome: 'completed', observations: [f.obs('position', { position: { x: 8, y: 64, z: 0 } })] });
  f.receive('bot-0', 'rules.applied', { version: f.core.getSnapshot().rules.version });
  assert.ok(f.events.some(e => e.commandId === 'role-first' && e.type === 'command.failed'));
  assert.equal(f.events.some(e => e.commandId === 'role-first' && e.type === 'command.applied'), false);
  assert.ok(f.events.some(e => e.commandId === 'role-second' && e.type === 'command.applied'));
});

test('guard is ongoing, validates patrol arrivals and waits 30 seconds between cycles', () => {
  const f = fixture(); const goal = f.core.createGoal({ kind: 'guard' }); const active = f.latest();
  assert.equal(goal.input.mode, 'maintain');
  f.result(active, { outcome: 'completed', observations: [f.obs('position', { position: { x: 0, y: 64, z: 0 } })] });
  assert.equal(f.core.getSnapshot().goals[0].state, 'maintaining'); assert.equal(f.assignments().length, 1);
  f.advance(29000); f.status('bot-0'); assert.equal(f.assignments().length, 1);
  f.advance(1000); f.status('bot-0'); assert.equal(f.assignments().length, 2);
});

test('farm harvest verifies actual harvested quantity then requires delivery to the shared warehouse', () => {
  const f = fixture(); f.status('bot-0', [], 'idle', ['farm', 'store']);
  const goal = f.core.createGoal({ kind: 'farm', quantity: 8, params: { crop: 'wheat', mode: 'harvest', plots: 8 } }); const farm = f.latest();
  assert.equal(farm.payload.task.kind, 'farm');
  f.result(farm, { outcome: 'condition-wait', observations: [f.obs('farm', { id: 'village', crop: 'wheat', plots: 8, planted: 8, watered: 8, ripe: 0, harvested: 3 })], checkpoint: { farm: { harvested: 3 } } });
  assert.equal(f.core.getSnapshot().tasks[0].retryCount, 0);
  f.advance(5000); f.status('bot-0', [{ name: 'wheat', count: 3 }], 'idle', ['farm', 'store']); const resumed = f.latest();
  assert.deepEqual(resumed.payload.checkpoint.farm, { harvested: 3 });
  f.result(resumed, { outcome: 'completed', observations: [f.obs('farm', { id: 'village', crop: 'wheat', plots: 8, planted: 8, watered: 8, ripe: 0, harvested: 8 }), f.obs('inventory', { items: [{ name: 'wheat', count: 8 }] })], checkpoint: { farm: { harvested: 8 } } });
  const store = f.latest(); assert.equal(store.payload.task.kind, 'store'); assert.equal(store.botId, farm.botId); assert.notEqual(f.core.getSnapshot().goals.find(g => g.id === goal.id)?.state, 'completed');
  f.result(store, { outcome: 'completed', observations: [f.obs('inventory', { items: [] }), f.obs('container', { container: warehouse, items: [{ name: 'wheat', count: 8 }] })], evidence: [{ kind: 'transfer', container: warehouse, item: 'wheat', quantity: 8, direction: 'store', beforeInventory: 8, afterInventory: 0, beforeContainer: 0, afterContainer: 8 }] });
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)?.state, 'completed');
});

test('additional craft quantities freeze the assigned bot inventory baseline across retries', () => {
  const f = fixture(); f.status('bot-0', [{ name: 'stick', count: 2 }], 'idle', ['craft']);
  const goal = f.core.createGoal({ kind: 'craft', item: 'stick', quantity: 3, quantityMode: 'additional' }); const craft = f.latest();
  assert.equal(craft.payload.task.params.quantity, 5); assert.equal(craft.payload.task.completion.kind, 'inventory');
  f.result(craft, { outcome: 'completed', observations: [f.obs('inventory', { items: [{ name: 'stick', count: 5 }] })] });
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)?.targetQuantity, 5);
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)?.state, 'completed');
});

test('autonomous buildings respect the full footprint and shrinking bounds stops active construction', () => {
  const f = fixture(); f.core.updateRules({ radius: 8, warehouse: null, autonomyEnabled: true }, 'queued'); f.receive('bot-0', 'rules.applied', { version: f.core.getSnapshot().rules.version });
  const outside = f.core.createGoal({ kind: 'build', source: 'autonomous', params: { design: 'cabin', origin: { x: 7, y: 64, z: 0 } } });
  assert.equal(outside.state, 'condition-wait'); assert.equal(f.assignments().length, 0);
  const inside = f.core.createGoal({ kind: 'build', source: 'autonomous', params: { design: 'cabin', origin: { x: 0, y: 64, z: 0 } } }); const build = f.latest();
  assert.equal(build.payload.task.source, 'autonomous');
  f.core.updateRules({ radius: 2 }, 'queued'); assert.ok(f.sent.some(m => m.type === 'task.cancel' && m.taskId === build.taskId));
  f.receive('bot-0', 'task.cancelled', { safeStopped: true, checkpoint: { placed: 3 }, observations: [] }, build);
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === inside.id)?.state, 'condition-wait');
});

test('autonomy creates village plans, keeps user priority and respects disabling and explicit cancellation', () => {
  const f = fixture(0); f.core.createGoal({ kind: 'home', params: { position: { x: 5, y: 64, z: 0 } } });
  f.core.updateRules({ autonomyEnabled: true }, 'queued'); f.core.addAgent({ id: 'bot-0', name: 'Worker0' }); f.core.startSession('bot-0', 'session-0'); f.ready('bot-0');
  assert.equal(f.latest().payload.task.kind, 'home');
  const stock = f.core.getSnapshot().goals.find(g => g.input.source === 'autonomous' && g.input.kind === 'collect')!;
  assert.ok(f.core.getSnapshot().goals.some(g => g.input.source === 'autonomous' && g.input.params.developmentId === 'village-house'), JSON.stringify({ goals: f.core.getSnapshot().goals.map(g => g.input), caps: f.core.getSnapshot().agents[0].session?.report?.capabilities }));
  assert.ok(f.core.getSnapshot().goals.some(g => g.input.source === 'autonomous' && g.input.params.developmentId === 'village-warehouse'));
  f.core.cancelGoal(stock.id); f.core.tick();
  assert.equal(f.core.getSnapshot().goals.filter(g => g.input.source === 'autonomous' && g.input.item === stock.input.item).length, 1);
  f.core.updateRules({ autonomyEnabled: false }, 'queued');
  f.result(f.latest(), { outcome: 'completed', observations: [f.obs('position', { position: { x: 5, y: 64, z: 0 } })] });
  f.receive('bot-0', 'rules.applied', { version: f.core.getSnapshot().rules.version });
  assert.equal(f.assignments().length, 1);
});

test('snapshot and checkpoint runtime validators round-trip trusted observations and task ownership', () => {
  const f = fixture(); f.observeStock(0); f.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 8 });
  assert.equal(FleetSnapshotSchema.parse(f.core.getSnapshot()).tasks[0].source, 'user');
  assert.equal(FleetCheckpointSchema.parse(f.core.checkpoint()).controllerEpoch, 'epoch');
  assert.equal(FleetCheckpointSchema.safeParse({ ...f.core.checkpoint(), schemaVersion: 99 }).success, false);
});

test('partial rule and connection updates preserve existing world and user settings', () => {
  const f = fixture(0); const before = f.core.getSnapshot().rules;
  f.core.updateRules({ radius: 80, combat: { proactiveRoles: ['guard'] } });
  f.core.updateRules({ combat: { retreatHealth: 7 } });
  const rules = f.core.getSnapshot().rules;
  assert.deepEqual(rules.center, before.center); assert.deepEqual(rules.warehouse, before.warehouse); assert.equal(rules.radius, 80); assert.deepEqual(rules.combat.proactiveRoles, ['guard']);
  f.core.addAgent({ id: 'bot-0', name: 'Worker0', connection: { host: 'private.example', port: 25566, auth: 'microsoft' } });
  f.core.updateAgent('bot-0', { connection: { port: 25567 } }, 'queued', 'port-update');
  assert.deepEqual(f.core.getSnapshot().agents[0].config.connection, { host: 'private.example', port: 25567, auth: 'microsoft' });
  assert.ok(f.events.some(e => e.type === 'command.applied' && e.commandId === 'port-update'));
});

test('running autonomous work yields safely to a newly registered user goal', () => {
  const f = fixture(); f.core.updateRules({ autonomyEnabled: true, warehouse: null }); f.receive('bot-0', 'rules.applied', { version: f.core.getSnapshot().rules.version });
  const autonomous = f.core.createGoal({ kind: 'home', source: 'autonomous', params: { position: { x: 20, y: 64, z: 0 } } }); const active = f.latest();
  const user = f.core.createGoal({ kind: 'home', params: { position: { x: 5, y: 64, z: 0 } } });
  assert.ok(f.sent.some(m => m.type === 'task.cancel' && m.taskId === active.taskId)); assert.equal(f.assignments().length, 1);
  f.receive('bot-0', 'task.cancelled', { safeStopped: true, checkpoint: { waypoint: 3 }, observations: [] }, active);
  const switched = f.latest(); assert.equal(switched.payload.task.goalId, user.id);
  f.result(switched, { outcome: 'completed', observations: [f.obs('position', { position: { x: 5, y: 64, z: 0 } })] });
  assert.equal(f.latest().payload.task.goalId, autonomous.id); assert.equal(f.latest().payload.checkpoint.waypoint, 3);
});

test('an unconfirmed cancellation retains ownership until a later real safe-stop acknowledgement', () => {
  const f = fixture(); const goal = f.core.createGoal({ kind: 'home', params: { position: { x: 5, y: 64, z: 0 } } }); const active = f.latest();
  f.core.cancelGoal(goal.id, 'cancel-goal');
  f.receive('bot-0', 'task.cancelled', { safeStopped: false, checkpoint: {}, observations: [] }, active);
  assert.equal(f.core.getSnapshot().agents[0].session?.activeAttemptId, active.attemptId);
  assert.equal(f.core.getSnapshot().goals[0].state, 'cancelling');
  assert.equal(f.receive('bot-0', 'task.cancelled', { safeStopped: true, checkpoint: {}, observations: [] }, active), true);
  assert.equal(f.core.getSnapshot().goals[0].state, 'cancelled');
});

test('ongoing patrol history remains bounded while current ownership survives compaction', () => {
  const f = fixture(); const goal = f.core.createGoal({ kind: 'guard' });
  for (let i = 0; i < 30; i++) {
    f.result(f.latest(), { outcome: 'completed', observations: [f.obs('position', { position: { x: 0, y: 64, z: 0 } })] });
    f.advance(30000); f.status('bot-0');
  }
  const snapshot = f.core.getSnapshot();
  assert.equal(snapshot.goals.find(g => g.id === goal.id)?.state, 'active');
  assert.ok(snapshot.tasks.length <= 3); assert.ok(snapshot.attempts.length <= 3); assert.equal(snapshot.agents[0].session?.activeAttemptId, f.latest().attemptId);
});
