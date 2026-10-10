import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BuildWaitingForSchema, ExpectedBlockSchema, FleetCheckpointSchema, ObservationInputSchema, resourceNamesFor, type CentralMessage, type JsonObject, type ObservedBlock, type Position } from '../packages/contracts/src';
import { FleetController } from '../packages/core/src';

const world = '127.0.0.1:25566', dimension = 'overworld', source = { x: 17, y: 62, z: 9 }, approach = { x: 17, y: 64, z: 9 };
function fixture(kind: 'build' | 'collect' | 'craft' = 'build') {
  let now = 100000;
  const sent: CentralMessage[] = [];
  const warehouse = { id: 'warehouse', position: { x: 4, y: 64, z: 4 }, world, dimension };
  const core = new FleetController({ controllerEpoch: 'epoch', now: () => now, send: (_bot, message) => sent.push(message), rules: { world, dimension, warehouse, autonomyEnabled: false } });
  function receive(type: string, payload: unknown, task?: Extract<CentralMessage, { type: 'task.assign' }>, botId = 'bot') {
    return core.onWorkerMessage({ protocolVersion: 1, controllerEpoch: core.controllerEpoch, messageId: randomUUID(), sentAt: now, botId, sessionId: core.getSnapshot().agents.find(a => a.id === botId)?.session?.id, type, payload, ...(task ? { taskId: task.taskId, attemptId: task.attemptId } : {}) });
  }
  function status(position: Position = { x: 0, y: 64, z: 0 }, inventory: { name: string; count: number }[] = [], botId = 'bot') {
    receive('bot.status', { ready: true, world, dimension, health: 20, food: 20, position, inventory, action: 'idle', reason: 'ready', mode: 'idle', capabilities: ['collect', 'craft', 'store', 'build', 'explore'], rulesVersion: core.getSnapshot().rules.version }, undefined, botId);
  }
  function ready(botId = 'bot') { status(undefined, [], botId); receive('rules.applied', { version: core.getSnapshot().rules.version }, undefined, botId); }
  core.addAgent({ id: 'bot', name: 'ResourceWait', role: 'builder' }); core.startSession('bot', 'session'); ready();
  const assignments = () => sent.filter((message): message is Extract<CentralMessage, { type: 'task.assign' }> => message.type === 'task.assign');
  const latest = () => { const task = assignments().at(-1); assert.ok(task); return task; };
  const blocks = (values: ObservedBlock[]) => ({ id: randomUUID(), kind: 'blocks', observedAt: now, world, dimension, data: { blocks: values } });
  const observe = (values: ObservedBlock[]) => receive('world.observed', { observations: [blocks(values)] });
  const wait = (checkpoint: JsonObject, observed: ObservedBlock[] = []) => receive('task.result', { outcome: 'condition-wait', reason: '실제 원천 자원 대기', checkpoint, evidence: [], observations: observed.length ? [blocks(observed)] : [] }, latest());
  if (kind === 'collect') receive('world.observed', { observations: [{ id: randomUUID(), kind: 'container', observedAt: now, world, dimension, data: { container: warehouse, items: [] } }] });
  core.createGoal(kind === 'build' ? { kind: 'build', preferredBotId: 'bot', params: { requiredBlocks: [{ position: { x: 8, y: 64, z: 8 }, name: 'cobblestone' }] } } : { kind, preferredBotId: 'bot', item: kind === 'collect' ? 'cobblestone' : 'crafting_table', quantity: 1 });
  return { core, receive, status, ready, assignments, latest, observe, wait, now: () => now, advance: (ms: number) => { now += ms; } };
}
const materialWait = (details: JsonObject = {}): JsonObject => ({ waitingFor: { kind: 'inventory', causeCode: 'BUILD_MATERIAL', item: 'cobblestone', minimum: 1, resourceNames: ['cobblestone'], ...details } });

test('inventory waits validate bounded integer resource coordinates and normalize actual raw sources', () => {
  const wait = { kind: 'inventory', causeCode: 'BUILD_MATERIAL', item: 'cobblestone', minimum: 1, resourcePositions: [source], failedCause: 'NO_SAFE_ACCESS' };
  assert.equal(BuildWaitingForSchema.safeParse(wait).success, true);
  assert.equal(BuildWaitingForSchema.safeParse({ ...wait, causeCode: 'RESOURCE_MISSING' }).success, true);
  assert.equal(BuildWaitingForSchema.safeParse({ ...wait, resourcePositions: Array(65).fill(source) }).success, false);
  assert.equal(BuildWaitingForSchema.safeParse({ ...wait, resourcePositions: [{ ...source, x: 17.5 }] }).success, false);
  assert.equal(BuildWaitingForSchema.safeParse({ ...wait, failedCause: 'x'.repeat(501) }).success, false);
  assert.deepEqual(resourceNamesFor('cobblestone', ['cobblestone']), ['stone', 'cobblestone']);
  assert.deepEqual(resourceNamesFor('oak_planks'), ['oak_log']); assert.deepEqual(resourceNamesFor('warped_planks'), ['warped_stem']);
});

test('actual block state is optional observation data and cannot redefine a goal block requirement', () => {
  const block = { position: source, name: 'wheat', stateId: 123 };
  const observation = { id: 'crop', kind: 'blocks', observedAt: 1, world, dimension, data: { blocks: [block] } };
  assert.equal(ObservationInputSchema.safeParse(observation).success, true);
  assert.equal(ObservationInputSchema.safeParse({ ...observation, kind: 'exploration', data: { position: source, resources: [block] } }).success, true);
  for (const stateId of [-1, 1.5, NaN]) assert.equal(ObservationInputSchema.safeParse({ ...observation, data: { blocks: [{ ...block, stateId }] } }).success, false);
  assert.equal(ExpectedBlockSchema.safeParse(block).success, false, 'goal block requirements remain name-only');
});

for (const explicit of [true, false]) test(`a ${explicit ? 'probed' : 'named'} crop changing actual state while keeping wheat as its name resumes the resource wait once`, () => {
  const f = fixture('craft'), checkpoint: JsonObject = { waitingFor: { kind: 'inventory', causeCode: 'RESOURCE_MISSING', item: 'wheat', minimum: 3, resourceNames: ['wheat'], watchPosition: false, ...(explicit ? { resourcePositions: [source] } : {}) }, resourceRecovery: { wheat: { destinationsUsed: 5, elapsedMs: 60000, status: 'exhausted' } } };
  f.wait(checkpoint, [{ position: source, name: 'wheat', stateId: 123 }]);
  for (let i = 0; i < 4; i++) { f.advance(6000); f.status(); f.observe([{ position: source, name: 'wheat', stateId: 123 }]); }
  assert.equal(f.assignments().length, 1);
  f.advance(600000); f.status(); f.observe([]); f.observe([{ position: source, name: 'wheat' }]); f.core.tick();
  assert.equal(f.assignments().length, 1, 'expiration, unloaded cells and optional state omission preserve the last actual state');
  f.observe([{ position: { x: 25, y: 64, z: 25 }, name: 'dirt', stateId: 4 }]); f.observe([{ position: { x: 25, y: 64, z: 25 }, name: 'dirt', stateId: 5 }]);
  assert.equal(f.assignments().length, 1, 'unrelated terrain state is not a crop maturation');
  f.observe([{ position: source, name: 'wheat', stateId: 130 }]); assert.equal(f.assignments().length, 2);
  assert.deepEqual(f.latest().payload.checkpoint.resourceRecovery, checkpoint.resourceRecovery);
  f.wait(checkpoint, [{ position: source, name: 'wheat', stateId: 130 }]);
  for (let i = 0; i < 8; i++) { f.advance(6000); f.status(); f.observe([{ position: source, name: 'wheat', stateId: 130 }]); }
  assert.equal(f.assignments().length, 2); FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('construction block waits ignore a state-only change and still require an actual name change', () => {
  const f = fixture(), checkpoint: JsonObject = { waitingFor: { kind: 'blocks', causeCode: 'BUILD_SUPPORT', positions: [source] } };
  f.wait(checkpoint, [{ position: source, name: 'grass_block', stateId: 1 }]);
  f.observe([{ position: source, name: 'grass_block', stateId: 2 }]); assert.equal(f.assignments().length, 1);
  f.observe([{ position: source, name: 'stone', stateId: 3 }]); assert.equal(f.assignments().length, 2);
});

for (const kind of ['collect', 'craft'] as const) test(`${kind} exhausted resource waits stay passive across ticks and resume once for each actual source, access or stock change`, () => {
  const f = fixture(kind), first = f.latest(), recovery = { cobblestone: { origin: { x: 0, y: 64, z: 0 }, visited: [], destinationsUsed: 5, elapsedMs: 60000, status: 'exhausted' } };
  assert.equal(first.payload.task.kind, kind);
  const checkpoint = { ...materialWait({ causeCode: 'RESOURCE_MISSING', resourcePositions: [source, approach], watchPosition: false }), resourceRecovery: recovery };
  const observed = (name: string, access = 'dirt') => [{ position: source, name }, { position: approach, name: access }];
  const passive = () => { for (let i = 0; i < 8; i++) { f.advance(6000); f.status({ x: i % 2, y: 64, z: 0 }); f.observe([{ position: { x: 30, y: 64, z: 30 }, name: i % 2 ? 'dirt' : 'air' }]); f.core.tick(); } };
  f.wait(checkpoint, observed('air')); passive(); assert.equal(f.assignments().length, 1, 'an exhausted search is not reaccepted every five seconds');
  f.observe(observed('stone')); assert.equal(f.assignments().length, 2); assert.equal(f.latest().taskId, first.taskId); assert.deepEqual(f.latest().payload.checkpoint.resourceRecovery, recovery);
  f.wait(checkpoint, observed('stone')); passive(); assert.equal(f.assignments().length, 2);
  f.observe(observed('stone', 'air')); assert.equal(f.assignments().length, 3);
  f.wait(checkpoint, observed('stone', 'air')); passive(); assert.equal(f.assignments().length, 3);
  f.status(undefined, [{ name: 'cobblestone', count: 1 }]); assert.equal(f.assignments().length, 4);
  assert.equal(f.core.getSnapshot().tasks[0].retryCount, 0); FleetCheckpointSchema.parse(f.core.checkpoint());
});

for (const kind of ['collect', 'craft'] as const) test(`${kind} resource watches restore only after the old worker is confirmed stopped and keep their bounded checkpoint`, () => {
  const f = fixture(kind), recovery = { cobblestone: { origin: { x: 0, y: 64, z: 0 }, visited: [source], destinationsUsed: 5, elapsedMs: 60000, status: 'exhausted' } };
  const checkpoint = { ...materialWait({ causeCode: 'RESOURCE_MISSING', resourcePositions: [source], watchPosition: false }), resourceRecovery: recovery };
  f.wait(checkpoint, [{ position: source, name: 'stone' }]);
  const sent: CentralMessage[] = [], restored = new FleetController({ controllerEpoch: 'replacement-epoch', checkpoint: f.core.checkpoint(), now: f.now, send: (_bot, message) => sent.push(message) });
  const assignments = () => sent.filter((message): message is Extract<CentralMessage, { type: 'task.assign' }> => message.type === 'task.assign');
  restored.startSession('bot', 'replacement-session');
  function receive(type: string, payload: unknown, task?: Extract<CentralMessage, { type: 'task.assign' }>) {
    restored.onWorkerMessage({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: restored.controllerEpoch, botId: 'bot', sessionId: 'replacement-session', sentAt: f.now(), type, payload, ...(task ? { taskId: task.taskId, attemptId: task.attemptId } : {}) });
  }
  const status = () => receive('bot.status', { ready: true, world, dimension, health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, inventory: [], action: 'idle', reason: 'ready', mode: 'idle', capabilities: ['collect', 'craft', 'store', 'build', 'explore'], rulesVersion: restored.getSnapshot().rules.version });
  status(); receive('rules.applied', { version: restored.getSnapshot().rules.version }); assert.equal(assignments().length, 0, 'a new session alone does not replace the old passive owner');
  restored.confirmWorkerStopped('bot', 'session'); assert.equal(assignments().length, 1); const resumed = assignments()[0]!;
  assert.deepEqual(resumed.payload.checkpoint.resourceRecovery, recovery);
  receive('task.result', { outcome: 'condition-wait', reason: '원천 자원 대기', checkpoint, evidence: [], observations: [{ id: randomUUID(), kind: 'blocks', observedAt: f.now(), world, dimension, data: { blocks: [{ position: source, name: 'stone' }] } }] }, resumed);
  for (let i = 0; i < 8; i++) { f.advance(6000); status(); restored.tick(); }
  assert.equal(assignments().length, 1); assert.deepEqual(restored.getSnapshot().tasks[0].checkpoint.resourceRecovery, recovery); FleetCheckpointSchema.parse(restored.checkpoint());
});

test('legacy item-only material waits resume on newly observed stone and preserve the remaining build', () => {
  const f = fixture(), first = f.latest(); f.wait({ ...materialWait(), build: { placed: 7 } });
  assert.deepEqual((f.core.getSnapshot().tasks[0].checkpoint.waitingFor as { resourceNames: string[] }).resourceNames, ['stone', 'cobblestone']);
  for (let i = 0; i < 8; i++) { f.advance(6000); f.status(); f.core.tick(); }
  assert.equal(f.assignments().length, 1);
  f.observe([{ position: source, name: 'stone' }]); assert.equal(f.assignments().length, 2);
  assert.equal(f.latest().taskId, first.taskId); assert.notEqual(f.latest().attemptId, first.attemptId); assert.deepEqual(f.latest().payload.checkpoint.build, { placed: 7 });
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('fresh report ids, expiration, unobserved coordinates and unrelated blocks do not reset a resource wait', () => {
  const f = fixture(); f.wait(materialWait({ resourcePositions: [source, approach] }), [{ position: source, name: 'stone' }, { position: approach, name: 'dirt' }]);
  for (let i = 0; i < 8; i++) { f.advance(6000); f.status(); f.observe([{ position: source, name: 'stone' }, { position: approach, name: 'dirt' }, { position: { x: 30, y: 64, z: 30 }, name: i % 2 ? 'dirt' : 'air' }]); }
  f.advance(600000); f.status(); f.observe([]); f.core.tick();
  assert.equal(f.assignments().length, 1); assert.equal(f.core.getSnapshot().goals[0].state, 'condition-wait');
  f.observe([{ position: approach, name: 'air' }]); assert.equal(f.assignments().length, 2, 'an observed opening at the exact odd coordinate is an access change');
});

test('observed source exhaustion is a real change even though air is not a resource name', () => {
  const f = fixture(); f.wait(materialWait({ resourcePositions: [source] }), [{ position: source, name: 'stone' }]);
  f.observe([{ position: source, name: 'air' }]); assert.equal(f.assignments().length, 2);
});

test('actual bot movement revalidates once without resetting exhausted recovery budgets', () => {
  const f = fixture(), recovery: JsonObject = { cobblestone: { origin: { x: 0, y: 64, z: 0 }, visited: [source], probes: [{ position: source, name: 'air' }], failed: [{ position: source, name: 'air', reason: 'empty' }], destinationsUsed: 5, maxDestinations: 5, elapsedMs: 60000, status: 'exhausted' } };
  const checkpoint = { ...materialWait({ watchPosition: true, resourcePositions: [source] }), resourceRecovery: recovery };
  f.wait(checkpoint, [{ position: source, name: 'air' }]); f.status({ x: 1, y: 64, z: 0 });
  assert.equal(f.assignments().length, 2); assert.deepEqual(f.latest().payload.checkpoint.resourceRecovery, recovery);
  f.wait(checkpoint, [{ position: source, name: 'air' }]);
  for (let i = 0; i < 8; i++) { f.advance(6000); f.status({ x: 1, y: 64, z: 0 }); }
  assert.equal(f.assignments().length, 2, 'repeated reports at the new position do not consume another attempt');
  assert.deepEqual(f.core.getSnapshot().tasks[0].checkpoint.resourceRecovery, recovery);
});

test('only executing bot stock or a confirmed new worker session restores a passive resource watch', () => {
  const f = fixture(); f.wait(materialWait());
  f.core.addAgent({ id: 'other', name: 'OtherWorker', allowedActions: ['collect'] }); f.core.startSession('other', 'other-session'); f.ready('other'); f.status(undefined, [{ name: 'cobblestone', count: 64 }], 'other');
  assert.equal(f.assignments().length, 1);
  f.core.confirmWorkerStopped('bot', 'session'); f.core.startSession('bot', 'session-new'); f.ready(); assert.equal(f.assignments().length, 2);
  f.wait(materialWait()); f.advance(6000); f.status(); assert.equal(f.assignments().length, 2);
  f.status(undefined, [{ name: 'cobblestone', count: 1 }]); assert.equal(f.assignments().length, 3);
});
