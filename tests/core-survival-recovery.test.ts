import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { FleetController } from '../packages/core/src';
import { DeathRecordSchema, FleetCheckpointSchema, RecoveryStateSchema, WorkerLaunchSchema, type CentralMessage, type DeathRecord, type RecoveryState } from '../packages/contracts/src';

const world = '127.0.0.1:25566', dimension = 'overworld';
function fixture(helpers = 0) {
  let clock = 100000;
  const sent: CentralMessage[] = [];
  const core = new FleetController({ controllerEpoch: 'death-epoch', now: () => clock, send: (_id, message) => sent.push(message), rules: { world, dimension, autonomyEnabled: false } });
  const receive = (botId: string, type: string, payload: unknown, task?: Extract<CentralMessage, { type: 'task.assign' }>, overrides = {}) => core.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: core.controllerEpoch, sessionId: core.getSnapshot().agents.find(a => a.id === botId)?.session?.id, botId, sentAt: clock, type, payload, ...(task ? { taskId: task.taskId, attemptId: task.attemptId } : {}), ...overrides });
  const report = (extra = {}) => ({ ready: true, world, dimension, position: { x: 0.5, y: 64, z: 0.5 }, health: 20, food: 20, inventory: [], action: '대기', reason: 'ready', mode: 'idle', capabilities: ['craft', 'fight', 'build', 'collect'], rulesVersion: core.getSnapshot().rules.version, ...extra });
  const status = (botId = 'bot', extra = {}) => receive(botId, 'bot.status', report(extra));
  const ready = (botId = 'bot', extra = {}) => { receive(botId, 'bot.ready', report(extra)); receive(botId, 'rules.applied', { version: core.getSnapshot().rules.version }); };
  core.addAgent({ id: 'bot', name: 'DeathWorker', allowedActions: helpers ? ['build'] : ['craft', 'fight', 'build', 'collect'] }); core.startSession('bot', 'bot-session'); ready();
  for (let i = 0; i < helpers; i++) { const id = `helper-${i}`; core.addAgent({ id, name: `Helper${i}`, role: i ? 'hunter' : 'guard', allowedActions: ['fight', 'craft'] }); core.startSession(id, `${id}-session`); ready(id); }
  const assignments = () => sent.filter((m): m is Extract<CentralMessage, { type: 'task.assign' }> => m.type === 'task.assign');
  const death = (id = 'death-1'): DeathRecord => ({ deathId: id, occurredAt: clock, world, dimension, position: { x: 2.5, y: 64, z: 1.5 }, priorInventory: [{ name: 'dirt', count: 10 }, { name: 'wooden_pickaxe', count: 1 }] });
  const recovery = (record = death(), extra: Partial<RecoveryState> = {}): RecoveryState => RecoveryStateSchema.parse({ ...record, phase: 'recovering', reason: '시체 주변 실제 경로를 확인합니다.', attemptCount: 1, progress: { recoveredCount: 0, remainingCount: 11 }, updatedAt: clock, checkpoint: { anchor: record.position, attemptsUsed: 1 }, ...extra });
  const alert = (botId = 'bot', entityId = 'enemy-uuid') => receive(botId, 'safety.alert', { response: 'retreat', reason: '좀비가 공격해 지원을 요청합니다.', supportRequired: true, threats: [{ entityId, name: 'zombie', x: 3, y: 64, z: 0 }] });
  return { core, sent, receive, report, status, ready, assignments, death, recovery, alert, now: () => clock, advance: (ms: number) => clock += ms };
}

test('death is recorded once while idle, blocks respawn assignments and preserves an honest partial recovery', () => {
  const f = fixture(), death = f.death();
  assert.equal(f.receive('bot', 'bot.died', death), true); f.receive('bot', 'bot.died', death);
  assert.equal(f.core.getSnapshot().events.filter(e => e.type === 'bot.died').length, 1);
  assert.deepEqual(f.core.getSnapshot().agents[0]!.deaths, [death]);
  f.core.createGoal({ kind: 'craft', item: 'oak_planks' }); f.ready();
  assert.equal(f.assignments().length, 0, 'same-session ready is not a recovery completion');
  f.receive('bot', 'bot.recovery', f.recovery(death, { phase: 'held', reason: '접근 가능한 안전 경로가 없습니다.' })); f.status();
  assert.equal(f.assignments().length, 0);
  const resolved = f.recovery(death, { phase: 'resolved', safe: true, reason: '안전 상태를 확인했습니다. 접근 불가능한 나머지 7개는 회수하지 못했습니다.', progress: { recoveredCount: 4, remainingCount: 0, lostCount: 7 } });
  f.receive('bot', 'bot.recovery', resolved);
  assert.equal(f.assignments().length, 1);
  assert.equal(f.core.getSnapshot().agents[0]!.recovery!.progress.lostCount, 7);
  assert.ok(f.core.getSnapshot().events.some(e => e.type === 'bot.recovery' && e.message.includes('회수하지 못')));
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('recovery facts and budget survive restart, and a new ready session must confirm safety again', () => {
  const f = fixture(), death = f.death(); f.receive('bot', 'bot.died', death); f.ready();
  const saved = f.recovery(death, { phase: 'resolved', safe: true, attemptCount: 3, progress: { recoveredCount: 5, remainingCount: 0, lostCount: 6 }, checkpoint: { anchor: death.position!, elapsedMs: 45000, attemptsUsed: 3 } });
  f.receive('bot', 'bot.recovery', saved);
  const sent: CentralMessage[] = [], restored = new FleetController({ checkpoint: f.core.checkpoint(), controllerEpoch: 'restored', now: f.now, send: (_id, message) => sent.push(message) });
  assert.equal(restored.getSnapshot().agents[0]!.recovery!.safe, false);
  assert.deepEqual(restored.getSnapshot().agents[0]!.recovery!.checkpoint, saved.checkpoint);
  const launch = WorkerLaunchSchema.parse({ botId: 'bot', sessionId: 'replacement', controllerEpoch: restored.controllerEpoch, config: restored.getSnapshot().agents[0]!.config, rules: restored.getSnapshot().rules, restoreRecovery: restored.getSnapshot().agents[0]!.recovery });
  assert.deepEqual(launch.restoreRecovery!.priorInventory, death.priorInventory);
  restored.confirmWorkerStopped('bot', 'bot-session'); restored.startSession('bot', 'replacement'); restored.createGoal({ kind: 'craft', item: 'oak_planks' });
  const receive = (type: string, payload: unknown) => restored.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: 'restored', botId: 'bot', sessionId: 'replacement', sentAt: f.now(), type, payload });
  receive('bot.ready', f.report()); receive('rules.applied', { version: restored.getSnapshot().rules.version });
  assert.equal(sent.some(m => m.type === 'task.assign'), false);
  receive('bot.recovery', saved); assert.equal(sent.filter(m => m.type === 'task.assign').length, 1);
  assert.equal(restored.getSnapshot().events.filter(e => e.type === 'bot.died').length, 1);
  FleetCheckpointSchema.parse(restored.checkpoint());
});

test('death during actual work preserves ownership until actual safe cancellation, then resumes after recovery', () => {
  const f = fixture(); f.core.createGoal({ kind: 'craft', item: 'oak_planks' }); const original = f.assignments()[0]!;
  f.receive('bot', 'task.started', {}, original); const death = f.death(); f.receive('bot', 'bot.died', death);
  assert.ok(f.sent.some(m => m.type === 'task.cancel' && m.attemptId === original.attemptId && m.payload.preserveProgress));
  f.ready(); f.receive('bot', 'bot.recovery', f.recovery(death, { phase: 'resolved', safe: true, progress: { recoveredCount: 0, remainingCount: 0, lostCount: 11 } }));
  assert.equal(f.assignments().length, 1, 'ready+recovered cannot clear active execution ownership');
  f.receive('bot', 'task.cancelled', { safeStopped: true, observations: [], evidence: [], checkpoint: { originalStep: 4 } }, original);
  assert.equal(f.assignments().length, 2); assert.deepEqual(f.assignments()[1]!.payload.checkpoint, { originalStep: 4 });
});

test('stale sessions and inconsistent death facts cannot release the recovery gate', () => {
  const f = fixture(), death = f.death(); f.receive('bot', 'bot.died', death); f.ready(); f.core.createGoal({ kind: 'craft', item: 'oak_planks' });
  assert.equal(f.receive('bot', 'bot.recovery', f.recovery(death, { phase: 'resolved', safe: true }), undefined, { sessionId: 'old-session' }), false);
  f.receive('bot', 'bot.recovery', f.recovery({ ...death, priorInventory: [] }, { phase: 'resolved', safe: true }));
  assert.equal(f.assignments().length, 0);
  f.receive('bot', 'bot.recovery', f.recovery(death, { phase: 'resolved', safe: true })); assert.equal(f.assignments().length, 1);
  assert.equal(DeathRecordSchema.safeParse({ ...death, priorInventory: Array.from({ length: 129 }, () => ({ name: 'dirt', count: 1 })) }).success, false);
  assert.equal(RecoveryStateSchema.safeParse({ ...f.recovery(death), attemptCount: 6 }).success, false);
});

test('support without an available helper records the actual constraint once instead of fabricating work', () => {
  const f = fixture(); f.alert(); f.alert();
  assert.equal(f.assignments().length, 0);
  assert.equal(f.core.getSnapshot().goals.length, 0);
  const events = f.core.getSnapshot().events.filter(e => e.type === 'support.unavailable');
  assert.equal(events.length, 1); assert.match(events[0]!.message, /지원 가능한 봇이 없습니다/);
});

test('a helper safely preserves its work, attacks the exact requested hostile and resumes its checkpoint', () => {
  const f = fixture(1); const goal = f.core.createGoal({ kind: 'craft', item: 'oak_planks', preferredBotId: 'helper-0' });
  const original = f.assignments()[0]!; assert.equal(original.botId, 'helper-0'); f.receive('helper-0', 'task.started', {}, original);
  f.alert(); f.alert();
  assert.equal(f.core.getSnapshot().goals.filter(g => typeof g.input.params.supportRequestId === 'string').length, 1);
  assert.equal(f.assignments().length, 1, 'support waits for actual cancellation');
  f.receive('helper-0', 'task.cancelled', { safeStopped: true, checkpoint: { workStep: 7 }, observations: [], evidence: [] }, original);
  const support = f.assignments()[1]!; assert.equal(support.payload.task.kind, 'fight'); assert.equal(support.botId, 'helper-0'); assert.equal(support.payload.task.params.targetEntityId, 'enemy-uuid');
  assert.deepEqual(support.payload.task.completion, { kind: 'entity-death', minimum: 1, targetName: 'zombie', targetId: 'enemy-uuid' });
  assert.ok(f.core.getSnapshot().reservations.some(r => r.taskId === support.taskId && r.key.includes('enemy-uuid')));
  f.receive('helper-0', 'task.result', { outcome: 'completed', checkpoint: {}, evidence: [], observations: [{ id: randomUUID(), kind: 'entity-death', world, dimension, observedAt: f.now(), data: { entityId: 'enemy-uuid', entityName: 'zombie' } }] }, support);
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === support.payload.task.goalId)!.state, 'completed');
  const resumed = f.assignments()[2]!; assert.equal(resumed.payload.task.goalId, goal.id); assert.deepEqual(resumed.payload.checkpoint, { workStep: 7 });
});

test('busy helpers with queued rules can stop for support, but assignment waits for current rules acknowledgement', () => {
  const f = fixture(1); f.core.createGoal({ kind: 'craft', item: 'oak_planks', preferredBotId: 'helper-0' });
  const original = f.assignments()[0]!; f.receive('helper-0', 'task.started', {}, original);
  f.core.updateRules({ radius: 33 }, 'queued'); f.ready('bot');
  f.alert();
  assert.ok(f.sent.some(m => m.type === 'task.cancel' && m.attemptId === original.attemptId));
  f.receive('helper-0', 'task.cancelled', { safeStopped: true, checkpoint: { workStep: 8 }, observations: [], evidence: [] }, original);
  assert.equal(f.assignments().length, 1, 'pending rules cannot authorize a support assignment');
  assert.ok(f.sent.some(m => m.botId === 'helper-0' && m.type === 'rules.update' && m.payload.rules.version === f.core.getSnapshot().rules.version));
  f.receive('helper-0', 'rules.applied', { version: f.core.getSnapshot().rules.version });
  const support = f.assignments()[1]!; assert.equal(support.payload.task.kind, 'fight');
  assert.equal(support.payload.task.params.targetEntityId, 'enemy-uuid');
  assert.deepEqual(f.core.getSnapshot().tasks.find(t => t.id === original.taskId)!.checkpoint, { workStep: 8 });
});

test('support rejects a same-name different enemy and does not recurse from helpers', () => {
  const f = fixture(2); f.alert(); const support = f.assignments()[0]!;
  f.alert(support.botId, 'other-enemy');
  assert.equal(f.core.getSnapshot().goals.filter(g => typeof g.input.params.supportRequestId === 'string').length, 1);
  f.receive(support.botId, 'task.result', { outcome: 'completed', checkpoint: {}, evidence: [], observations: [{ id: randomUUID(), kind: 'entity-death', world, dimension, observedAt: f.now(), data: { entityId: 'different-zombie', entityName: 'zombie' } }] }, support);
  assert.equal(f.core.getSnapshot().tasks.find(t => t.id === support.taskId)!.state, 'held');
});

test('expired hostile requests cannot resume helper work until the real support execution stops', () => {
  const f = fixture(1); const originalGoal = f.core.createGoal({ kind: 'craft', item: 'oak_planks', preferredBotId: 'helper-0' }); const original = f.assignments()[0]!;
  f.alert(); f.receive('helper-0', 'task.cancelled', { safeStopped: true, checkpoint: { kept: true }, observations: [], evidence: [] }, original); const support = f.assignments()[1]!;
  f.advance(16000); f.status('helper-0'); f.status('bot');
  assert.equal(f.assignments().length, 2); assert.ok(f.sent.some(m => m.type === 'task.cancel' && m.taskId === support.taskId));
  f.receive('helper-0', 'task.cancelled', { safeStopped: true, checkpoint: {}, observations: [], evidence: [] }, support);
  assert.equal(f.assignments().at(-1)!.payload.task.goalId, originalGoal.id);
  assert.deepEqual(f.assignments().at(-1)!.payload.checkpoint, { kept: true });
  assert.ok(f.core.getSnapshot().events.some(e => e.type === 'support.expired'));
});

test('support retries are bounded and a stale replay cannot create a new request', () => {
  const f = fixture(1); f.core.updateRules({ maxRetries: 1 }); f.ready('bot'); f.ready('helper-0');
  f.alert(); const first = f.assignments()[0]!;
  f.receive('helper-0', 'task.result', { outcome: 'condition-wait', checkpoint: {}, observations: [], evidence: [], reason: '지정한 적의 안전한 접근을 확인해야 합니다.' }, first);
  f.advance(6000); f.status('helper-0'); f.status('bot');
  const second = f.assignments()[1]!; assert.equal(second.taskId, first.taskId);
  f.receive('helper-0', 'task.result', { outcome: 'condition-wait', checkpoint: {}, observations: [], evidence: [], reason: '동일한 접근 불가 조건입니다.' }, second);
  assert.equal(f.core.getSnapshot().tasks.find(t => t.id === first.taskId)!.state, 'held');
  f.alert(); assert.equal(f.core.getSnapshot().goals.filter(g => typeof g.input.params.supportRequestId === 'string').length, 1);
  f.advance(61000); f.status('bot'); f.status('helper-0');
  f.receive('bot', 'safety.alert', { response: 'support', reason: '지연된 위협', supportRequired: true, threats: [{ entityId: 'new-enemy', name: 'zombie', x: 2, y: 64, z: 0 }] }, undefined, { sentAt: f.now() - 10001 });
  assert.equal(f.core.getSnapshot().goals.filter(g => typeof g.input.params.supportRequestId === 'string').length, 1);
});

test('the requester can confirm the exact hostile death, but helper ownership still needs a safe stop', () => {
  const f = fixture(1); const originalGoal = f.core.createGoal({ kind: 'craft', item: 'oak_planks', preferredBotId: 'helper-0' }), original = f.assignments()[0]!;
  f.alert(); f.receive('helper-0', 'task.cancelled', { safeStopped: true, checkpoint: { priorWork: 9 }, observations: [], evidence: [] }, original); const support = f.assignments()[1]!;
  f.receive('bot', 'world.observed', { observations: [{ id: randomUUID(), kind: 'entity-death', world, dimension, observedAt: f.now(), data: { entityId: 'enemy-uuid', entityName: 'zombie' } }] });
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === support.payload.task.goalId)!.state, 'completed');
  assert.equal(f.assignments().length, 2);
  f.receive('helper-0', 'task.cancelled', { safeStopped: true, checkpoint: {}, observations: [], evidence: [] }, support);
  assert.equal(f.assignments().at(-1)!.payload.task.goalId, originalGoal.id);
  assert.deepEqual(f.assignments().at(-1)!.payload.checkpoint, { priorWork: 9 });
});

test('agent death history stays bounded while retaining the newest recovery record', () => {
  const f = fixture();
  for (let i = 0; i < 25; i++) { f.advance(1); f.receive('bot', 'bot.died', f.death(`death-${i}`)); }
  const agent = f.core.getSnapshot().agents[0]!;
  assert.equal(agent.deaths!.length, 20); assert.equal(agent.deaths![0]!.deathId, 'death-5'); assert.equal(agent.recovery!.deathId, 'death-24');
  assert.equal(f.core.getSnapshot().events.filter(e => e.type === 'bot.died').length, 25);
  FleetCheckpointSchema.parse(f.core.checkpoint());
});
