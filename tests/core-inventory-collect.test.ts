import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { FleetController } from '../packages/core/src';
import { FleetCheckpointSchema, type CentralMessage, type ContainerRef, type InventoryView } from '../packages/contracts/src';

const world = '127.0.0.1:25566', dimension = 'overworld', item = 'oak_log';
const warehouse: ContainerRef = { id: 'warehouse', world, dimension, position: { x: 3, y: 64, z: 3 } };
function fixture(counts: number[] = [0], withWarehouse = false) {
  let now = 100000;
  const sent: CentralMessage[] = [];
  const core = new FleetController({ controllerEpoch: 'inventory-epoch', now: () => now, send: (_id, message) => sent.push(message), rules: { world, dimension, autonomyEnabled: false, warehouse: withWarehouse ? warehouse : null } });
  const receive = (botId: string, type: string, payload: unknown, task?: Extract<CentralMessage, { type: 'task.assign' }>, extra = {}) => core.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: core.controllerEpoch, botId, sessionId: core.getSnapshot().agents.find(a => a.id === botId)?.session?.id, sentAt: now, type, payload, ...(task ? { taskId: task.taskId, attemptId: task.attemptId } : {}), ...extra });
  const report = (count: number, extra = {}) => ({ ready: true, world, dimension, position: { x: 0.5, y: 64, z: 0.5 }, health: 20, food: 20, inventory: count ? [{ name: item, count }] : [], action: '대기', reason: 'ready', mode: 'idle', capabilities: ['collect', 'store', 'hunt'], rulesVersion: core.getSnapshot().rules.version, ...extra });
  const status = (botId = 'bot-0', count = 0, extra = {}, envelope = {}) => receive(botId, 'bot.status', report(count, extra), undefined, envelope);
  const ready = (botId: string, count = 0) => { receive(botId, 'bot.ready', report(count)); receive(botId, 'rules.applied', { version: core.getSnapshot().rules.version }); };
  counts.forEach((count, i) => { const id = `bot-${i}`; core.addAgent({ id, name: `CollectBot${i}`, role: 'gatherer', allowedActions: ['collect', 'store', 'hunt'] }); core.startSession(id, `session-${i}`); ready(id, count); });
  const assignments = () => sent.filter((m): m is Extract<CentralMessage, { type: 'task.assign' }> => m.type === 'task.assign');
  const result = (task: Extract<CentralMessage, { type: 'task.assign' }>, count: number, outcome = 'completed', extra = {}) => receive(task.botId, 'task.result', { outcome, checkpoint: {}, evidence: [], observations: [{ id: randomUUID(), observedAt: now, world, dimension, kind: 'inventory', data: { items: count ? [{ name: item, count }] : [] } }], ...extra }, task);
  const stock = (count: number) => receive('bot-0', 'world.observed', { observations: [{ id: randomUUID(), observedAt: now, world, dimension, kind: 'container', data: { container: warehouse, items: count ? [{ name: item, count }] : [] } }] });
  return { core, sent, receive, status, report, ready, assignments, result, stock, now: () => now, advance: (ms: number) => now += ms };
}

test('without a warehouse, existing 10 logs count toward total 32 and only 22 are assigned', () => {
  const f = fixture([10]), goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 });
  assert.equal(goal.completionLocation, 'inventory'); assert.equal(goal.progress.current, 10); assert.equal(goal.input.destination, undefined);
  const assignment = f.assignments()[0]!; assert.equal(assignment.payload.task.params.quantity, 22); assert.deepEqual(assignment.payload.task.completion, { kind: 'inventory', item, minimum: 32 });
  assert.equal(f.core.getSnapshot().tasks.some(t => t.kind === 'store'), false);
  f.result(assignment, 32);
  const completed = f.core.getSnapshot().goals.find(g => g.id === goal.id)!;
  assert.equal(completed.state, 'completed'); assert.equal(completed.progress.current, 32); assert.equal(completed.completionSnapshot!.quantity, 32);
  assert.deepEqual(completed.completionSnapshot!.inventories.map(row => [row.botId, row.count]), [['bot-0', 32]]);
  assert.match(completed.reason!, /실제 인벤토리/);
  const proof = completed.completionSnapshot; f.status('bot-0', 0); f.core.tick();
  assert.equal(f.assignments().length, 1); assert.deepEqual(f.core.getSnapshot().goals[0]!.completionSnapshot, proof); assert.equal(f.core.getSnapshot().goals[0]!.state, 'completed');
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('several bots share the remaining quota and new inventory progress does not duplicate that quota', () => {
  const f = fixture([10, 0, 0]), goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 });
  const assigned = f.assignments(); assert.equal(assigned.length, 3); assert.equal(assigned.reduce((sum, task) => sum + Number(task.payload.task.params.quantity), 0), 22);
  assert.deepEqual(assigned.map(task => task.payload.task.params.quantity).sort((a, b) => Number(a) - Number(b)), [6, 8, 8]);
  assert.equal(new Set(assigned.map(task => task.botId)).size, 3);
  assert.equal(f.core.getSnapshot().reservations.filter(r => r.key.includes(`goal:${goal.id}:inventory`)).length, 3);
  const baseline = new Map([['bot-0', 10], ['bot-1', 0], ['bot-2', 0]]);
  for (const task of assigned) f.result(task, baseline.get(task.botId)! + Number(task.payload.task.params.quantity));
  assert.equal(f.core.getSnapshot().goals[0]!.state, 'completed'); assert.equal(f.core.getSnapshot().goals[0]!.progress.current, 32); assert.equal(f.assignments().length, 3);
});

test('additional quantities keep their observed baseline and maintain goals replenish actual inventory loss', () => {
  const f = fixture([10]), goal = f.core.createGoal({ kind: 'collect', item, quantity: 22, quantityMode: 'additional' });
  assert.equal(goal.targetQuantity, 32); const first = f.assignments()[0]!; f.result(first, 32); f.status('bot-0', 0);
  assert.equal(f.core.getSnapshot().goals[0]!.targetQuantity, 32); assert.equal(f.core.getSnapshot().goals[0]!.state, 'completed');
  const maintain = f.core.createGoal({ kind: 'collect', item, quantity: 8, mode: 'maintain' }), refill = f.assignments().at(-1)!;
  f.result(refill, 8); assert.equal(f.core.getSnapshot().goals.find(g => g.id === maintain.id)!.state, 'maintaining');
  f.status('bot-0', 3); const replenish = f.assignments().at(-1)!; assert.equal(replenish.payload.task.params.quantity, 5); assert.equal(replenish.payload.task.goalId, maintain.id);
  f.result(replenish, 8); assert.equal(f.core.getSnapshot().goals.find(g => g.id === maintain.id)!.state, 'maintaining');
});

test('warehouse addition keeps an existing inventory goal pinned and a new goal still requires actual deposit', () => {
  const f = fixture([10]), goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 }), first = f.assignments()[0]!;
  f.core.updateRules({ warehouse }); f.ready('bot-0', 10);
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)!.completionLocation, 'inventory'); assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)!.input.destination, undefined);
  f.result(first, 32); f.ready('bot-0', 32); assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)!.state, 'completed');
  const next = f.core.createGoal({ kind: 'collect', item, quantity: 32 }); assert.equal(next.completionLocation, 'warehouse'); assert.equal(next.state, 'condition-wait');
  f.stock(0); const acquire = f.assignments().at(-1)!; assert.equal(acquire.payload.task.kind, 'collect'); assert.equal(acquire.payload.task.params.quantity, 0, 'the existing held inventory can be explicitly transferred');
  f.result(acquire, 32); const store = f.assignments().at(-1)!; assert.equal(store.payload.task.kind, 'store');
  assert.notEqual(f.core.getSnapshot().goals.find(g => g.id === next.id)!.state, 'completed'); f.stock(32);
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === next.id)!.state, 'completed');
});

test('configured warehouse completion is unchanged and personal inventory alone cannot finish it', () => {
  const f = fixture([32], true), goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 });
  assert.equal(goal.completionLocation, 'warehouse'); assert.equal(f.assignments().length, 0); assert.equal(goal.state, 'condition-wait');
  f.stock(10); const acquire = f.assignments()[0]!; assert.equal(acquire.payload.task.params.quantity, 0); f.result(acquire, 32);
  assert.equal(f.assignments().at(-1)!.payload.task.kind, 'store'); assert.notEqual(f.core.getSnapshot().goals[0]!.state, 'completed');
  f.stock(32); assert.equal(f.core.getSnapshot().goals[0]!.state, 'completed');
});

test('inventory totals exclude disabled, stale, foreign-world and former-session observations', () => {
  const f = fixture([10, 99, 99, 99]); f.core.updateAgent('bot-1', { enabled: false }); f.status('bot-2', 99, { world: 'other-world' });
  f.core.confirmWorkerStopped('bot-3', 'session-3'); f.core.startSession('bot-3', 'replacement'); f.ready('bot-3', 0);
  f.receive('bot-0', 'world.observed', { observations: [{ id: randomUUID(), observedAt: f.now() - 40000, world, dimension, kind: 'inventory', data: { items: [{ name: item, count: 999 }] } }] });
  const goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 }); assert.equal(goal.progress.current, 10);
  assert.notEqual(goal.state, 'completed'); assert.equal(f.assignments().reduce((sum, m) => sum + Number(m.payload.task.params.quantity), 0), 22);
});

test('an asserted completed result without current inventory proof cannot complete an inventory goal', () => {
  const f = fixture(), goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 }), assignment = f.assignments()[0]!;
  f.receive('bot-0', 'task.result', { outcome: 'completed', checkpoint: {}, evidence: [], observations: [] }, assignment);
  assert.equal(f.core.getSnapshot().tasks[0]!.state, 'held'); assert.equal(f.core.getSnapshot().goals.find(g => g.id === goal.id)!.state, 'held');
  assert.equal(f.core.getSnapshot().goals[0]!.completionSnapshot, undefined);
});

test('a preferred collector gets the job, while an unavailable preferred bot permits another collector', () => {
  const f = fixture([0, 0]), first = f.core.createGoal({ kind: 'collect', item, quantity: 32, preferredBotId: 'bot-1' });
  assert.equal(f.assignments().length, 1); assert.equal(f.assignments()[0]!.botId, 'bot-1'); f.result(f.assignments()[0]!, 32);
  f.core.confirmWorkerStopped('bot-1', 'session-1'); const next = f.core.createGoal({ kind: 'collect', item, quantity: 3, preferredBotId: 'bot-1' });
  assert.equal(f.assignments().at(-1)!.botId, 'bot-0'); assert.equal(f.assignments().at(-1)!.payload.task.goalId, next.id); assert.equal(f.core.getSnapshot().goals.find(g => g.id === first.id)!.state, 'completed');
});

test('full inventories wait without repeated assignments and free slots permit an actual bounded partial quota', () => {
  const f = fixture([10]), slots: InventoryView['slots'] = Array.from({ length: 46 }, () => null);
  for (let i = 9; i <= 44; i++) slots[i] = { name: 'stone', count: 64, maxStackSize: 64 };
  slots[9] = { name: item, count: 10, maxStackSize: 10 };
  f.status('bot-0', 10, { inventoryView: { slots } }); const goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 });
  assert.equal(f.assignments().length, 0); assert.equal(goal.state, 'condition-wait'); assert.match(goal.reason!, /인벤토리 공간/);
  for (let i = 0; i < 5; i++) { f.advance(6000); f.status('bot-0', 10, { inventoryView: { slots } }); f.core.tick(); }
  assert.equal(f.assignments().length, 0);
  const opened = slots.map((s, i) => i === 9 ? { name: item, count: 10, maxStackSize: 14 } : s); f.status('bot-0', 10, { inventoryView: { slots: opened } });
  const partial = f.assignments()[0]!; assert.equal(partial.payload.task.params.quantity, 4); assert.equal(partial.payload.task.completion.kind === 'inventory' && partial.payload.task.completion.minimum, 14);
  f.result(partial, 12, 'condition-wait', { reason: '인벤토리 공간을 확보해야 합니다.' });
  f.advance(6000); f.status('bot-0', 12, { inventoryView: { slots: slots.map((s, i) => i === 9 ? { name: item, count: 12, maxStackSize: 12 } : s) } });
  assert.equal(f.assignments().length, 1); assert.notEqual(f.core.getSnapshot().goals[0]!.state, 'completed');
  f.advance(6000); f.status('bot-0', 12, { inventoryView: { slots: slots.map((s, i) => i === 10 ? null : i === 9 ? { name: item, count: 12, maxStackSize: 12 } : s) } });
  assert.equal(f.assignments().at(-1)!.payload.task.params.quantity, 20);
});

test('legacy warehouse-missing goals get inventory completion without replacing their id, input or generation', () => {
  const f = fixture([10]), goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 }); const checkpoint = f.core.checkpoint();
  const saved = checkpoint.goals.find(g => g.id === goal.id)!; delete saved.completionLocation; saved.state = 'condition-wait'; saved.reason = '공동 창고를 설정해야 합니다.'; saved.taskIds = []; checkpoint.tasks = []; checkpoint.attempts = []; checkpoint.reservations = []; checkpoint.agents[0]!.session!.activeAttemptId = undefined;
  const sent: CentralMessage[] = [], restored = new FleetController({ checkpoint, controllerEpoch: 'legacy-restored', now: f.now, send: (_id, message) => sent.push(message) });
  restored.confirmWorkerStopped('bot-0', 'session-0'); restored.startSession('bot-0', 'new-session');
  const receive = (type: string, payload: unknown) => restored.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: restored.controllerEpoch, botId: 'bot-0', sessionId: 'new-session', sentAt: f.now(), type, payload });
  receive('bot.ready', f.report(10)); receive('rules.applied', { version: 1 });
  const active = restored.getSnapshot().goals.find(g => g.id === goal.id)!; assert.equal(active.completionLocation, 'inventory'); assert.deepEqual(active.input, saved.input); assert.equal(active.generation, saved.generation);
  const task = sent.find((m): m is Extract<CentralMessage, { type: 'task.assign' }> => m.type === 'task.assign'); assert.ok(task); assert.equal(task.payload.task.params.quantity, 22);
  FleetCheckpointSchema.parse(restored.checkpoint());
});

test('an old status packet cannot substitute for a fresh actual inventory observation', () => {
  const f = fixture([10]); f.advance(40000);
  f.status('bot-0', 999, {}, { sentAt: f.now() - 40000 });
  const goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 });
  assert.equal(f.assignments().length, 0); assert.equal(goal.state, 'condition-wait'); assert.equal(goal.completionSnapshot, undefined);
  f.status('bot-0', 10); assert.equal(f.assignments().length, 1); assert.equal(f.assignments()[0]!.payload.task.params.quantity, 22);
});

test('a completed inventory goal keeps its proof across controller restart and later consumption', () => {
  const f = fixture([32]), goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 }); assert.equal(goal.state, 'completed');
  const sent: CentralMessage[] = [], restored = new FleetController({ checkpoint: f.core.checkpoint(), controllerEpoch: 'once-restored', now: f.now, send: (_id, message) => sent.push(message) });
  restored.confirmWorkerStopped('bot-0', 'session-0'); restored.startSession('bot-0', 'new-session');
  const receive = (type: string, payload: unknown) => restored.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: restored.controllerEpoch, botId: 'bot-0', sessionId: 'new-session', sentAt: f.now(), type, payload });
  receive('bot.ready', f.report(0)); receive('rules.applied', { version: 1 }); restored.updateRules({ warehouse });
  const saved = restored.getSnapshot().goals.find(g => g.id === goal.id)!;
  assert.equal(saved.state, 'completed'); assert.equal(saved.completionLocation, 'inventory'); assert.equal(saved.progress.current, 32); assert.deepEqual(saved.completionSnapshot, goal.completionSnapshot);
  assert.equal(sent.some(m => m.type === 'task.assign'), false); FleetCheckpointSchema.parse(restored.checkpoint());
});

test('cancelled legacy goals are never restarted by inventory completion migration', () => {
  const f = fixture([10]), goal = f.core.createGoal({ kind: 'collect', item, quantity: 32 }); f.core.cancelGoal(goal.id);
  const task = f.assignments()[0]!; f.receive(task.botId, 'task.cancelled', { safeStopped: true, checkpoint: {}, observations: [], evidence: [] }, task);
  const checkpoint = f.core.checkpoint(); delete checkpoint.goals[0]!.completionLocation;
  const sent: CentralMessage[] = [], restored = new FleetController({ checkpoint, now: f.now, send: (_id, message) => sent.push(message) }); restored.tick();
  assert.equal(restored.getSnapshot().goals[0]!.state, 'cancelled'); assert.equal(sent.some(m => m.type === 'task.assign'), false);
});
