import assert from 'node:assert/strict';
import test from 'node:test';
import { BotInputSchema, CentralMessageSchema, GoalInputSchema, RulesSchema, WorkerMessageSchema, sameContainer } from '../packages/contracts/src';

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
