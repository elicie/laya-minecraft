import assert from 'node:assert/strict';
import test from 'node:test';
import { BotInputSchema, BotPatchSchema, BuildSiteSchema, BuildWaitingForSchema, CentralMessageSchema, GoalInputSchema, GoalPatchSchema, RulesPatchSchema, RulesSchema, WorkerMessageSchema, buildSiteCells, isBuildSiteAir, isBuildSiteGround, sameContainer } from '../packages/contracts/src';

const base = { protocolVersion: 1, messageId: 'message-1', controllerEpoch: 'epoch-1', botId: 'bot-1', sessionId: 'session-1', sentAt: 1000 };
const report = { ready: true, world: 'local:25566', dimension: 'overworld', health: 20, food: 20, inventory: [], action: 'idle', reason: 'ready', mode: 'idle', capabilities: ['collect'], rulesVersion: 1 };

test('strict worker contracts reject unknown protocol, malformed payloads and missing attempt ownership', () => {
  assert.equal(WorkerMessageSchema.parse({ ...base, type: 'bot.ready', payload: report }).type, 'bot.ready');
  assert.equal(WorkerMessageSchema.safeParse({ ...base, protocolVersion: 2, type: 'bot.ready', payload: report }).success, false);
  assert.equal(WorkerMessageSchema.safeParse({ ...base, type: 'bot.ready', payload: { ...report, health: 200 } }).success, false);
  assert.equal(WorkerMessageSchema.safeParse({ ...base, type: 'task.result', payload: { outcome: 'completed' } }).success, false);
  assert.equal(WorkerMessageSchema.safeParse({ ...base, type: 'task.started', taskId: 'task', attemptId: 'attempt', payload: { ready: true } }).success, false);
  assert.equal(WorkerMessageSchema.safeParse({ ...base, type: 'bot.status', payload: { ...report, capabilities: ['execute_arbitrary_code'] } }).success, false);
});

test('goal quantities, Minecraft account names and maintain semantics are validated', () => {
  const goal = GoalInputSchema.parse({ kind: 'collect', item: 'oak_log', quantity: 32 });
  assert.equal(goal.quantityMode, 'total');
  assert.equal(goal.mode, 'once');
  assert.equal(goal.executionMode, 'queued');
  assert.equal(GoalInputSchema.safeParse({ kind: 'collect', quantity: 32 }).success, false);
  assert.equal(GoalInputSchema.safeParse({ kind: 'collect', item: 'oak_log', quantity: -1 }).success, false);
  assert.equal(GoalInputSchema.safeParse({ kind: 'collect', item: 'oak_log', mode: 'maintain', quantityMode: 'additional' }).success, false);
  assert.equal(BotInputSchema.safeParse({ name: '../escape', role: 'guard' }).success, false);
  assert.equal(BotInputSchema.parse({ name: 'Guard01' }).connection.auth, 'offline');
  assert.equal(RulesSchema.parse({}).maxRetries, 5);
  assert.equal(RulesSchema.safeParse({ maxRetries: 6 }).success, false);
});

test('public viewer and shutdown contracts contain actual connection identity', () => {
  const viewer = CentralMessageSchema.parse({ ...base, type: 'viewer.start', payload: { port: 4100, prefix: '/viewer/bot-1' } });
  assert.equal(viewer.type, 'viewer.start');
  assert.equal(WorkerMessageSchema.safeParse({ ...base, type: 'viewer.ready', payload: { port: 4100, prefix: 'relative' } }).success, false);
  const container = { id: 'chest', position: { x: 1, y: 64, z: 2 }, world: 'local:25566', dimension: 'overworld' };
  assert.equal(sameContainer(container, { ...container, world: 'different:25566' }), false);
  assert.equal(sameContainer(container, { ...container, position: { x: 2, y: 64, z: 2 } }), false);
});

test('partial updates preserve omitted fields rather than injecting full configuration defaults', () => {
  assert.deepEqual(RulesPatchSchema.parse({ radius: 80 }), { radius: 80 });
  assert.deepEqual(RulesPatchSchema.parse({ combat: { retreatHealth: 7 } }), { combat: { retreatHealth: 7 } });
  assert.deepEqual(RulesPatchSchema.parse({}), {});
  assert.deepEqual(BotPatchSchema.parse({ connection: { port: 25567 } }), { connection: { port: 25567 } });
});

test('goal params can be replaced without reintroducing a removed build origin', () => {
  assert.deepEqual(GoalPatchSchema.parse({ params: { blueprint: 'warehouse', siteSelection: 'nearby' } }), { params: { blueprint: 'warehouse', siteSelection: 'nearby' } });
  assert.deepEqual(GoalPatchSchema.parse({ title: '창고' }), { title: '창고' });
  assert.equal(GoalPatchSchema.safeParse({ params: { origin: undefined } }).success, false);
});

test('site proof and typed waits use integer cells and full vacant ground clearance', () => {
  const site = { origin: { x: 1, y: 64, z: 2 }, design: 'warehouse', entrance: { x: 4, y: 64, z: 1 }, observedAt: 1000 };
  assert.deepEqual(BuildSiteSchema.parse(site), site);
  assert.equal(BuildSiteSchema.safeParse({ ...site, origin: { ...site.origin, x: 1.5 } }).success, false);
  assert.equal(BuildSiteSchema.safeParse({ ...site, entrance: undefined }).success, false);
  const cells = buildSiteCells(site.origin, 7, 5, 4);
  assert.equal(cells.length, 35 * 5 + 63 + 28 * 2);
  assert.ok(cells.some(c => c.requirement === 'air' && c.position.x === 2 && c.position.y === 68 && c.position.z === 3), 'roof height is inclusive');
  assert.ok(cells.some(c => c.requirement === 'ground' && c.position.x === 0 && c.position.y === 63 && c.position.z === 1), 'outside access ring has actual ground support');
  assert.equal(isBuildSiteAir('oak_planks'), false);
  for (const name of ['water', 'lava', 'magma_block', 'oak_leaves', 'oak_log', 'oak_planks', 'sand', 'gravel', 'ice', 'farmland', 'dirt_path']) assert.equal(isBuildSiteGround(name), false, name);
  assert.equal(isBuildSiteGround('grass_block'), true);
  const waiting = BuildWaitingForSchema.parse({ kind: 'blocks', causeCode: 'BUILD_SITE', positions: [site.origin], watchPosition: true });
  assert.equal(waiting.kind, 'blocks'); if (waiting.kind === 'blocks') assert.deepEqual(waiting.positions, [site.origin]);
  assert.equal(BuildWaitingForSchema.safeParse({ kind: 'blocks', causeCode: 'BUILD_SUPPORT', positions: [] }).success, false);
  assert.equal(BuildWaitingForSchema.safeParse({ kind: 'inventory', causeCode: 'BUILD_MATERIAL', item: 'oak_log', minimum: 0 }).success, false);
});
