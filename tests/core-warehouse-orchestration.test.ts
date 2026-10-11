import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FleetController } from '../packages/core/src';
import { verifyCompletion } from '../packages/core/src/verification';
import { FleetCheckpointSchema, blueprintPreset, buildSiteCells, sameContainer, type CentralMessage, type ContainerRef, type ObservationInput, type Position, type TaskSpec } from '../packages/contracts/src';
import { blueprint } from '../packages/contracts/src/blueprints';

const world = '127.0.0.1:25566', dimension = 'overworld', origin = { x: 5, y: 64, z: 5 };
type Assignment = Extract<CentralMessage, { type: 'task.assign' }>;
function fixture(botCount = 1, warehouse: ContainerRef | null = null, saved?: ReturnType<FleetController['checkpoint']>) {
  let now = 100000;
  const sent: CentralMessage[] = [];
  const core = new FleetController({ controllerEpoch: saved ? 'restored-epoch' : 'epoch', checkpoint: saved, now: () => now, send: (_id, message) => sent.push(message), rules: { world, dimension, center: null, warehouse, autonomyEnabled: false } });
  const receive = (botId: string, type: string, payload: unknown, assignment?: Assignment, extra = {}) => core.onWorkerMessage({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: core.controllerEpoch, botId, sessionId: core.getSnapshot().agents.find(agent => agent.id === botId)?.session?.id, sentAt: now, type, payload, ...(assignment ? { taskId: assignment.taskId, attemptId: assignment.attemptId } : {}), ...extra });
  const ready = (botId = 'bot-0') => { receive(botId, 'bot.ready', { ready: true, world, dimension, position: { x: 0.5, y: 64, z: 0.5 }, health: 20, food: 20, inventory: [], action: '대기', reason: '실제 관측', mode: 'idle', capabilities: ['build', 'explore', 'collect', 'craft', 'store'], rulesVersion: core.getSnapshot().rules.version }); receive(botId, 'rules.applied', { version: core.getSnapshot().rules.version }); };
  if (!saved) for (let index = 0; index < botCount; index++) { core.addAgent({ id: `bot-${index}`, name: `WarehouseBot${index}`, role: 'builder' }); core.startSession(`bot-${index}`, `session-${index}`); ready(`bot-${index}`); }
  const assignments = () => sent.filter((message): message is Assignment => message.type === 'task.assign');
  const latest = () => { const found = assignments().at(-1); assert.ok(found); return found; };
  const obs = (kind: string, data: unknown, at = now): ObservationInput => ({ id: randomUUID(), observedAt: at, world, dimension, kind, data } as ObservationInput);
  const result = (assignment: Assignment, payload: unknown, extra = {}) => receive(assignment.botId, 'task.result', { observations: [], evidence: [], checkpoint: {}, ...(payload as object) }, assignment, extra);
  const build = (params = {}) => { const goal = core.createGoal({ kind: 'build', params: { blueprint: 'warehouse', origin, ...params }, preferredBotId: 'bot-0' }); return { goal, assignment: latest() }; };
  const built = (assignment: Assignment) => { assert.equal(assignment.payload.task.completion.kind, 'blocks'); result(assignment, { outcome: 'completed', observations: [obs('blocks', { blocks: assignment.payload.task.completion.kind === 'blocks' ? assignment.payload.task.completion.blocks : [] })] }); return latest(); };
  const registration = (assignment: Assignment, options: { blocks?: boolean; container?: boolean; at?: number; differentContainer?: boolean } = {}) => {
    const completion = assignment.payload.task.completion; assert.equal(completion.kind, 'warehouse'); if (completion.kind !== 'warehouse') throw new Error('registration expected');
    return { outcome: 'completed', observations: [...(options.blocks === false ? [] : [obs('blocks', { blocks: completion.blocks }, options.at)]), ...(options.container === false ? [] : [obs('container', { container: options.differentContainer ? { ...completion.container, id: 'different' } : completion.container, items: [] }, options.at)])] };
  };
  return { core, sent, receive, ready, latest, assignments, obs, result, build, built, registration, advance: (ms: number) => now += ms, now: () => now };
}

test('a plain warehouse goal with empty inventory starts an actual nearby survey without requiring village coordinates', () => {
  const f = fixture(), goal = f.core.createGoal({ kind: 'build', params: { design: 'warehouse' } });
  assert.equal(goal.input.params.siteSelection, 'nearby'); const survey = f.latest(); assert.equal(survey.payload.task.kind, 'explore'); assert.equal(survey.payload.task.params.mode, 'build-site');
  assert.deepEqual(survey.payload.task.params.near, { x: 0.5, y: 64, z: 0.5 }); assert.deepEqual(f.core.getSnapshot().agents[0]!.session!.report!.inventory, []);
  const cells = buildSiteCells(origin, 7, 5, 4), entrance = { x: 8, y: 64, z: 4 };
  f.result(survey, { outcome: 'completed', checkpoint: { buildSite: { design: 'warehouse', origin, entrance, observedAt: f.now() } }, observations: [f.obs('blocks', { blocks: cells.map(cell => ({ position: cell.position, name: cell.requirement === 'air' ? 'air' : 'grass_block' })) }), f.obs('exploration', { position: { ...entrance, x: 8.5, z: 4.5 }, resources: [] })] });
  const build = f.latest(), tasks = f.core.getSnapshot().tasks.filter(task => task.goalId === goal.id && task.generation === 1);
  assert.equal(build.payload.task.completion.kind, 'blocks'); assert.equal(tasks.length, 2); assert.equal(tasks[1]!.params.mode, 'register-warehouse'); assert.deepEqual(tasks[1]!.dependencies, [build.taskId]); assert.notEqual(f.core.getSnapshot().goals[0]!.state, 'completed'); assert.equal(f.core.getSnapshot().rules.warehouse, null);
});

test('a building is not a completed warehouse until the complete building and actual empty container are verified and rules propagate', () => {
  const f = fixture(), { goal, assignment: build } = f.build(), version = f.core.getSnapshot().rules.version;
  const check = f.built(build); assert.equal(check.payload.task.params.mode, 'register-warehouse'); assert.notEqual(f.core.getSnapshot().goals[0]!.state, 'completed'); assert.equal(f.core.getSnapshot().rules.warehouse, null);
  f.result(check, f.registration(check)); const snapshot = f.core.getSnapshot(), completed = snapshot.goals.find(value => value.id === goal.id)!;
  assert.equal(completed.state, 'completed'); assert.ok(completed.input.params.verifiedWarehouse); assert.equal(snapshot.rules.version, version + 1);
  assert.ok(snapshot.rules.warehouse && check.payload.task.completion.kind === 'warehouse' && sameContainer(snapshot.rules.warehouse, check.payload.task.completion.container));
  assert.ok(f.sent.some(message => message.type === 'rules.update' && message.payload.rules.version === version + 1 && message.payload.rules.warehouse?.id === snapshot.rules.warehouse!.id));
  assert.equal(snapshot.agents[0]!.session!.rulesVersion, version, 'accepted policy and actual worker acknowledgement stay distinct');
  f.ready(); assert.equal(f.core.getSnapshot().agents[0]!.session!.rulesVersion, version + 1);
  assert.equal(f.result(check, f.registration(check)), false, 'duplicate attempt completion cannot register a second rules version'); assert.equal(f.core.getSnapshot().rules.version, version + 1); FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('registration refuses missing, stale and mismatched evidence, even when the original build was completely observed', () => {
  for (const options of [{ container: false }, { blocks: false }, { differentContainer: true }, { at: 99999 }]) {
    const f = fixture(), { assignment: build } = f.build(), check = f.built(build);
    f.result(check, f.registration(check, options)); assert.equal(f.core.getSnapshot().rules.warehouse, null); assert.equal(f.core.getSnapshot().tasks.find(task => task.id === check.taskId)!.state, 'held'); assert.notEqual(f.core.getSnapshot().goals[0]!.state, 'completed');
  }
  const f = fixture(), { assignment: build } = f.build(), check = f.built(build);
  assert.equal(f.result(check, f.registration(check), { controllerEpoch: 'old-epoch' }), false); assert.equal(f.core.getSnapshot().rules.warehouse, null);
  assert.equal(f.result(check, f.registration(check), { sessionId: 'former-session' }), false); assert.equal(f.core.getSnapshot().rules.warehouse, null);
});

test('building damage after construction prevents registration despite a real opened chest', () => {
  const f = fixture(), { assignment: build } = f.build(), check = f.built(build), payload = f.registration(check);
  const observation = payload.observations.find(value => value.kind === 'blocks')!; if (observation.kind === 'blocks') observation.data.blocks[0]!.name = 'air';
  f.result(check, payload); assert.equal(f.core.getSnapshot().rules.warehouse, null); assert.equal(f.core.getSnapshot().goals[0]!.state, 'held');
});

test('moving to a different dimension cannot use an old container reference to register a warehouse', () => {
  const f = fixture(), { assignment: build } = f.build(), check = f.built(build);
  f.receive('bot-0', 'bot.status', { ready: true, world, dimension: 'the_nether', position: origin, health: 20, food: 20, inventory: [], action: '대기', reason: 'dimension changed', mode: 'working', capabilities: ['build'], rulesVersion: f.core.getSnapshot().rules.version });
  const payload = f.registration(check); payload.observations = payload.observations.map(observation => ({ ...observation, dimension: 'the_nether' }));
  f.result(check, payload); assert.equal(f.core.getSnapshot().rules.warehouse, null); assert.equal(f.core.getSnapshot().goals[0]!.state, 'held');
});

test('an existing shared warehouse and an earlier inventory collect goal retain their pinned completion location', () => {
  const existing: ContainerRef = { id: 'original', world, dimension, position: { x: 30, y: 64, z: 30 } }, f = fixture(1, existing), version = f.core.getSnapshot().rules.version;
  const { assignment: build } = f.build(), check = f.built(build); f.result(check, f.registration(check));
  assert.deepEqual(f.core.getSnapshot().rules.warehouse, existing); assert.equal(f.core.getSnapshot().rules.version, version); assert.notDeepEqual(f.core.getSnapshot().goals[0]!.input.params.verifiedWarehouse, existing);
  const fresh = fixture(), inventoryGoal = fresh.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 32 });
  fresh.core.cancelGoal(inventoryGoal.id); const active = fresh.assignments().find(message => message.payload.task.goalId === inventoryGoal.id); if (active) fresh.receive(active.botId, 'task.cancelled', { safeStopped: true, observations: [], evidence: [], checkpoint: {} }, active);
  const built = fresh.build(), registration = fresh.built(built.assignment); fresh.result(registration, fresh.registration(registration));
  const pinned = fresh.core.getSnapshot().goals.find(goal => goal.id === inventoryGoal.id)!; assert.equal(pinned.completionLocation, 'inventory'); assert.equal(pinned.input.destination, undefined);
});

test('custom warehouse without chests completes its building and explicitly explains the missing warehouse connection', () => {
  const f = fixture(), preset = blueprintPreset('warehouse'), definition = f.core.createBlueprint({ ...preset, title: '상자 없는 창고 건물', furniture: { ...preset.furniture, chest: false } });
  const goal = f.core.createGoal({ kind: 'build', params: { blueprint: definition.id, origin } }), build = f.latest();
  f.result(build, { outcome: 'completed', observations: [f.obs('blocks', { blocks: blueprint(definition.id, origin, definition.wood, definition) })] });
  const finished = f.core.getSnapshot().goals.find(value => value.id === goal.id)!; assert.equal(finished.state, 'completed'); assert.match(finished.reason!, /상자가 없어/); assert.equal(f.core.getSnapshot().rules.warehouse, null); assert.equal(f.core.getSnapshot().tasks.some(task => task.completion.kind === 'warehouse'), false);
});

test('cancelled registration and direct injected registration modes cannot activate a warehouse', () => {
  const f = fixture(), { goal, assignment: build } = f.build(), check = f.built(build); f.core.cancelGoal(goal.id); f.result(check, f.registration(check));
  assert.equal(f.core.getSnapshot().rules.warehouse, null); assert.equal(f.core.getSnapshot().goals[0]!.state, 'cancelled'); assert.equal(f.core.getSnapshot().goals[0]!.input.params.verifiedWarehouse, undefined);
  const invalid = fixture(), injected = invalid.core.createGoal({ kind: 'build', params: { mode: 'register-warehouse', blueprint: 'warehouse', origin, verifiedWarehouse: { id: 'forged' } } });
  assert.equal(invalid.assignments().length, 0); assert.equal(injected.state, 'condition-wait'); assert.equal(injected.input.params.verifiedWarehouse, undefined);
});

test('registration survives restart with the same goal id and demands fresh build and container proof from the new session', () => {
  const f = fixture(), { goal, assignment: build } = f.build(), old = f.built(build), saved = f.core.checkpoint(), restored = fixture(0, null, saved);
  restored.core.confirmWorkerStopped('bot-0', 'session-0'); restored.core.startSession('bot-0', 'new-session'); restored.ready();
  const rebuild = restored.latest(); assert.equal(rebuild.payload.task.goalId, goal.id); assert.equal(rebuild.payload.task.completion.kind, 'blocks'); assert.equal(restored.core.getSnapshot().rules.warehouse, null);
  assert.equal(restored.result(old, f.registration(old), { controllerEpoch: f.core.controllerEpoch, sessionId: 'session-0' }), false);
  const check = restored.built(rebuild); restored.result(check, restored.registration(check)); assert.equal(restored.core.getSnapshot().goals[0]!.id, goal.id); assert.equal(restored.core.getSnapshot().goals[0]!.state, 'completed'); assert.ok(restored.core.getSnapshot().rules.warehouse); FleetCheckpointSchema.parse(restored.core.checkpoint());
});

test('another capable bot can perform read-only registration after the preferred builder is removed', () => {
  const f = fixture(2), { assignment: build } = f.build();
  f.core.removeAgent(build.botId); f.result(build, { outcome: 'completed', observations: [f.obs('blocks', { blocks: build.payload.task.completion.kind === 'blocks' ? build.payload.task.completion.blocks : [] })] });
  f.core.confirmWorkerStopped(build.botId, build.sessionId); f.core.tick(); const check = f.latest(); assert.equal(check.payload.task.completion.kind, 'warehouse'); assert.equal(check.botId, 'bot-1'); f.result(check, f.registration(check)); assert.equal(f.core.getSnapshot().goals[0]!.state, 'completed');
});

test('zero-quantity inventory and container completion still require a real current observation', () => {
  const context = { observations: [], now: 100000, maxAgeMs: 10000, world, dimension }, container: ContainerRef = { id: 'c', world, dimension, position: origin };
  assert.equal(verifyCompletion({ kind: 'inventory', item: 'oak_log', minimum: 0 }, context).complete, false);
  assert.equal(verifyCompletion({ kind: 'container', container, item: 'oak_log', minimum: 0 }, context).complete, false);
});

test('later collection protects the actual completed warehouse floor and access foundation through checkpoint restoration', () => {
  const f = fixture(), { assignment: build } = f.build(), check = f.built(build); f.result(check, f.registration(check)); f.ready();
  const warehouse = f.core.getSnapshot().rules.warehouse!;
  f.receive('bot-0', 'world.observed', { observations: [f.obs('container', { container: warehouse, items: [] })] });
  const goal = f.core.createGoal({ kind: 'collect', item: 'cobblestone', quantity: 2 });
  const collect = f.latest(); assert.equal(collect.payload.task.kind, 'collect'); assert.equal(collect.payload.task.goalId, goal.id);
  const cells = collect.payload.task.params.protectedPositions as Position[];
  assert.ok(cells.some(position => position.x === origin.x && position.y === origin.y && position.z === origin.z), 'placed cobblestone floor is protected');
  const saved = f.core.checkpoint(), restored = fixture(0, null, saved); restored.core.confirmWorkerStopped('bot-0', 'session-0'); restored.core.startSession('bot-0', 'next-session'); restored.ready();
  restored.receive('bot-0', 'world.observed', { observations: [restored.obs('container', { container: warehouse, items: [] })] });
  const resumed = restored.latest(); assert.equal(resumed.payload.task.kind, 'collect'); assert.ok((resumed.payload.task.params.protectedPositions as Position[]).some(position => position.x === origin.x && position.y === origin.y && position.z === origin.z));
});

test('verified warehouse ownership survives the gameplay log retention period', () => {
  const f = fixture(), { goal, assignment: build } = f.build(), check = f.built(build); f.result(check, f.registration(check));
  f.advance(31 * 86400000); f.ready(); f.core.tick();
  assert.equal(f.core.getSnapshot().goals.find(value => value.id === goal.id)?.state, 'completed');
  const warehouse = f.core.getSnapshot().rules.warehouse!;
  f.receive('bot-0', 'world.observed', { observations: [f.obs('container', { container: warehouse, items: [] })] });
  f.core.createGoal({ kind: 'collect', item: 'cobblestone', quantity: 1 });
  const collect = f.latest(); assert.equal(collect.payload.task.kind, 'collect');
  assert.ok((collect.payload.task.params.protectedPositions as Position[]).some(position => position.x === origin.x && position.y === origin.y && position.z === origin.z));
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('restored unplanned coordinate-free warehouse goals retain their identity and parameters while adopting nearby discovery', () => {
  const f = fixture(0), goal = f.core.createGoal({ kind: 'build', params: { design: 'warehouse', wood: 'birch', annotation: { request: 'original' } } });
  const saved = f.core.checkpoint(), legacy = saved.goals.find(value => value.id === goal.id)!;
  delete legacy.input.params.siteSelection; legacy.generation = 7;
  const originalParams = structuredClone(legacy.input.params), restored = fixture(0, null, saved);
  const migrated = restored.core.getSnapshot().goals.find(value => value.id === goal.id)!;
  assert.equal(migrated.id, legacy.id); assert.equal(migrated.generation, 7); assert.equal(migrated.createdAt, legacy.createdAt);
  assert.deepEqual(migrated.input.params, { ...originalParams, siteSelection: 'nearby' });
  restored.core.addAgent({ id: 'bot-0', name: 'RestoredBuilder', role: 'builder' }); restored.core.startSession('bot-0', 'restored-session'); restored.ready();
  const survey = restored.latest(); assert.equal(survey.payload.task.goalId, goal.id); assert.equal(survey.payload.task.params.mode, 'build-site');
  assert.equal(restored.core.getSnapshot().tasks.find(value => value.id === survey.taskId)!.generation, 7);
  assert.deepEqual(survey.payload.task.params.near, { x: 0.5, y: 64, z: 0.5 }); FleetCheckpointSchema.parse(restored.core.checkpoint());
});

test('restore compatibility preserves pinned versions, explicit coordinates and existing or terminal plans', () => {
  const f = fixture(0), preset = blueprintPreset('warehouse'), pinned = f.core.createBlueprint({ ...preset, title: '고정 버전 창고' });
  const custom = f.core.createGoal({ kind: 'build', params: { blueprint: pinned.id } });
  f.core.updateBlueprint(pinned.id, { ...preset, title: '고정 버전 창고', wood: 'birch' });
  const fixed = f.core.createGoal({ kind: 'build', params: { blueprint: 'warehouse', origin } });
  const position = f.core.createGoal({ kind: 'build', params: { blueprint: 'warehouse', position: origin } });
  const raw = f.core.createGoal({ kind: 'build', params: { requiredBlocks: [{ position: origin, name: 'stone' }] } });
  const planned = f.core.createGoal({ kind: 'build', params: { blueprint: 'warehouse', origin } });
  const completed = f.core.createGoal({ kind: 'build', params: { blueprint: 'warehouse' } });
  const cancelled = f.core.createGoal({ kind: 'build', params: { blueprint: 'warehouse' } });
  const saved = f.core.checkpoint();
  delete saved.goals.find(value => value.id === planned.id)!.input.params.origin;
  for (const value of saved.goals) if ([custom.id, completed.id, cancelled.id].includes(value.id)) delete value.input.params.siteSelection;
  saved.goals.find(value => value.id === completed.id)!.state = 'completed'; saved.goals.find(value => value.id === cancelled.id)!.state = 'cancelled';
  const restored = fixture(0, null, saved).core.getSnapshot();
  const customGoal = restored.goals.find(value => value.id === custom.id)!;
  assert.equal(customGoal.input.params.siteSelection, 'nearby'); assert.deepEqual(customGoal.input.params.blueprintDefinition, pinned);
  for (const id of [fixed.id, position.id, raw.id, planned.id, completed.id, cancelled.id]) assert.deepEqual(restored.goals.find(value => value.id === id)!.input.params, saved.goals.find(value => value.id === id)!.input.params);
  assert.equal(restored.tasks.filter(task => task.goalId === fixed.id).length, saved.tasks.filter(task => task.goalId === fixed.id).length);
});
