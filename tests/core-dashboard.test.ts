import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetController } from '../packages/core/src';
import { dashboardSnapshot } from '../packages/core/src/dashboard-snapshot';
import { dashboardSnapshot as compatibleProjection } from '../apps/server/src/dashboard-snapshot';
import { DEFAULT_RULES, FleetCheckpointSchema, FleetSnapshotSchema, GoalSchema, TaskSchema, type JsonObject } from '../packages/contracts/src';

function seed() {
  const now = 100000, privateProof = 'actual-private-checkpoint'.repeat(10000);
  const goal = GoalSchema.parse({ id: 'warehouse', title: '창고', input: { kind: 'build', params: { blueprint: 'warehouse', origin: { x: 1, y: 64, z: 1 }, meta: { source: 'original' } } }, state: 'active', taskIds: ['build'], generation: 0, createdAt: now, updatedAt: now, progress: { current: 0 } });
  const task = TaskSchema.parse({ id: 'build', goalId: goal.id, kind: 'build', params: { design: 'warehouse', origin: { x: 1, y: 64, z: 1 }, protectedPositions: [{ x: 1, y: 63, z: 1 }] }, completion: { kind: 'blocks', blocks: [{ position: { x: 1, y: 64, z: 1 }, name: 'chest' }] }, dependencies: [], reservationKeys: ['original-reservation'], generation: 0, state: 'condition-wait', checkpoint: { build: { placed: 3 }, buildRemaining: { count: 1 }, privateProof }, retryCount: 0, resumeCount: 0, progress: 0.5, createdAt: now, updatedAt: now });
  const checkpoint = FleetCheckpointSchema.parse({ schemaVersion: 1, controllerEpoch: 'prior', revision: 4, updatedAt: now, rules: DEFAULT_RULES, blueprints: [], agents: [], goals: [goal], tasks: [task], attempts: [{ id: 'prior-attempt', taskId: task.id, botId: 'prior-bot', sessionId: 'prior-session', controllerEpoch: 'prior', state: 'interrupted', reason: 'resume', assignedAt: now - 1000, finishedAt: now, result: { outcome: 'condition-wait', checkpoint: { privateProof }, evidence: [], observations: [] } }], observations: [], events: [{ id: 'proof', time: now, revision: 4, type: 'task.progress', message: '실제 상태', data: { privateProof } }], reservations: [], processedMessageIds: ['private-message'], pendingRuleCommands: [], pendingCommands: [], stoppedSessionIds: [] });
  return { now, checkpoint };
}

test('dashboard reads project before cloning and preserve the strict full snapshot and durable checkpoint', () => {
  const f = seed(), core = new FleetController({ checkpoint: f.checkpoint, now: () => f.now, send() {} });
  const full = core.getSnapshot(), durable = core.serializeCheckpoint(), view = core.getDashboardSnapshot();
  FleetSnapshotSchema.parse(view); assert.deepEqual(view, dashboardSnapshot(full, f.now)); assert.equal(compatibleProjection, dashboardSnapshot);
  assert.equal(core.serializeCheckpoint(), durable); assert.deepEqual(core.getSnapshot(), full);
  assert.ok(!('processedMessageIds' in view) && !('pendingCommands' in view) && !('stoppedSessionIds' in view));
  assert.equal(view.tasks[0]!.checkpoint.privateProof, undefined); assert.equal(view.attempts[0]!.result, undefined);
  assert.ok(core.checkpoint().tasks[0]!.checkpoint.privateProof); assert.ok(core.checkpoint().attempts[0]!.result);
});

test('mutating nested dashboard display fields cannot mutate controller state or later reads', () => {
  const f = seed(), core = new FleetController({ checkpoint: f.checkpoint, now: () => f.now, send() {} });
  const durable = core.serializeCheckpoint(), expected = core.getDashboardSnapshot(), view = core.getDashboardSnapshot();
  view.rules.combat.retreatHealth = 19; (view.goals[0]!.input.params.meta as JsonObject).source = 'changed';
  (view.tasks[0]!.params.origin as JsonObject).x = 999; (view.tasks[0]!.checkpoint.build as JsonObject).placed = 999;
  assert.ok(view.tasks[0]!.completion.kind === 'blocks'); view.tasks[0]!.completion.blocks[0]!.position.x = 999;
  view.events[0]!.message = 'changed'; view.goals.length = 0;
  assert.equal(core.serializeCheckpoint(), durable); assert.deepEqual(core.getDashboardSnapshot(), expected);
});

test('the dashboard getter never invokes the full snapshot read or checkpoint copy', () => {
  class DashboardOnly extends FleetController {
    override getSnapshot(): never { throw new Error('full snapshot must not be copied'); }
    override checkpoint(): never { throw new Error('durable state must not be copied'); }
  }
  const f = seed(), core = new DashboardOnly({ checkpoint: f.checkpoint, now: () => f.now, send() {} });
  const view = core.getDashboardSnapshot(f.now); FleetSnapshotSchema.parse(view);
  assert.equal(view.goals[0]!.id, 'warehouse'); assert.equal(view.tasks[0]!.checkpoint.privateProof, undefined);
});
