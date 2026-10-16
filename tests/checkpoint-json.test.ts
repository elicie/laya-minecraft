import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetCheckpointSchema } from '../packages/contracts/src';
import { FleetController } from '../packages/core/src';
import { CheckpointJson } from '../packages/core/src/checkpoint-json';

test('cached evidence serialization preserves the complete checkpoint and refreshes mutable fields and replaced results', () => {
  const core = new FleetController({ send() {}, rules: { autonomyEnabled: false } });
  core.addAgent({ name: 'CacheEvidence' });
  const state = core.checkpoint(), writer = new CheckpointJson();
  const observation = { id: 'observed', observedAt: 1, world: state.rules.world, dimension: state.rules.dimension, botId: state.agents[0]!.id, sessionId: 'session', controllerEpoch: state.controllerEpoch, receivedAt: 1, kind: 'inventory' as const, data: { items: [{ name: 'bread', count: 8 }] } };
  state.observations.push(observation);
  const task = { id: 'preserved', goalId: 'goal', kind: 'collect' as const, params: {}, completion: { kind: 'inventory' as const, item: 'oak_log', minimum: 6 }, dependencies: [], reservationKeys: [], state: 'interrupted' as const, checkpoint: { resourceRecovery: { oak_log: { elapsedMs: 60000, destinationsUsed: 5 } } }, createdAt: 1, updatedAt: 1, generation: 1, retryCount: 0, resumeCount: 1, progress: 0 };
  state.tasks.push(task);
  state.attempts.push({ id: 'attempt', taskId: task.id, botId: state.agents[0]!.id, sessionId: 'session', controllerEpoch: state.controllerEpoch, state: 'interrupted', assignedAt: 1, finishedAt: 2, reason: 'resume', result: { outcome: 'condition-wait', checkpoint: structuredClone(task.checkpoint), observations: [structuredClone(observation)], evidence: [], reason: 'preserve spent budget' } });
  const check = () => { const expected = JSON.parse(JSON.stringify(state)); const actual = JSON.parse(writer.serialize(state)); assert.deepEqual(actual, expected); return actual; };
  check(); check();
  state.revision++; state.tasks[0]!.checkpoint.resourceRecovery = { oak_log: { elapsedMs: 60001, destinationsUsed: 5 } };
  state.attempts[0]!.state = 'uncertain'; state.agents[0]!.config.enabled = false;
  assert.equal(check().tasks[0].checkpoint.resourceRecovery.oak_log.elapsedMs, 60001);
  state.attempts[0]!.result = { ...structuredClone(state.attempts[0]!.result!), reason: 'new actual outcome' };
  state.observations.push({ ...structuredClone(observation), id: 'new-observation', data: { items: [{ name: 'bread', count: 7 }] } });
  assert.equal(check().attempts[0].result.reason, 'new actual outcome');
  assert.equal(check().observations[1].data.items[0].count, 7);
  assert.ok(Object.isFrozen(state.attempts[0]!.result!.checkpoint));
  assert.ok(Object.isFrozen(observation.data.items));
  assert.equal(Object.isFrozen(task.checkpoint), false, 'live resource budgets remain mutable');
});

test('a restored controller keeps its ordinary checkpoint schema after cached serialization and later rule changes', () => {
  const first = new FleetController({ send() {}, rules: { autonomyEnabled: false } });
  first.addAgent({ name: 'CachedRestart' });
  const checkpoint = FleetCheckpointSchema.parse(JSON.parse(first.serializeCheckpoint()));
  const second = new FleetController({ send() {}, checkpoint });
  second.updateRules({ radius: 77 }, 'queued');
  assert.equal(JSON.parse(second.serializeCheckpoint()).rules.radius, 77);
  assert.deepEqual(JSON.parse(second.serializeCheckpoint()), JSON.parse(JSON.stringify(second.checkpoint())));
});
