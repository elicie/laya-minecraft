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
  const inventory = (botId: string) => botId.startsWith('helper-') ? [{ name: 'stone_sword', count: 1 }] : [];
  const status = (botId = 'bot', extra = {}) => receive(botId, 'bot.status', report({ inventory: inventory(botId), ...extra }));
  const ready = (botId = 'bot', extra = {}) => { receive(botId, 'bot.ready', report({ inventory: inventory(botId), ...extra })); receive(botId, 'rules.applied', { version: core.getSnapshot().rules.version }); };
  core.addAgent({ id: 'bot', name: 'DeathWorker', allowedActions: helpers ? ['build'] : ['craft', 'fight', 'build', 'collect'] }); core.startSession('bot', 'bot-session'); ready();
  for (let i = 0; i < helpers; i++) { const id = `helper-${i}`; core.addAgent({ id, name: `Helper${i}`, role: i ? 'hunter' : 'guard', allowedActions: ['fight', 'craft'] }); core.startSession(id, `${id}-session`); ready(id, { inventory: [{ name: 'stone_sword', count: 1 }] }); }
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

test('an unarmed guard keeps preparing equipment instead of being interrupted for support', () => {
  const f = fixture(1); f.status('helper-0', { inventory: [] });
  f.core.createGoal({ kind: 'craft', item: 'stone_sword', preferredBotId: 'helper-0' });
  const original = f.assignments()[0]!;
  f.alert();
  assert.equal(f.core.getSnapshot().goals.some(g => typeof g.input.params.supportRequestId === 'string'), false);
  assert.equal(f.sent.some(m => m.type === 'task.cancel' && m.attemptId === original.attemptId), false);
  f.status('helper-0', { inventory: [{ name: 'stone_sword', count: 1 }] }); f.advance(16000);
  f.status('helper-0', { inventory: [{ name: 'stone_sword', count: 1 }] }); f.status('bot'); f.alert();
  assert.equal(f.core.getSnapshot().goals.some(g => typeof g.input.params.supportRequestId === 'string'), true);
});

test('personal guard equipment cannot be crafted by a different idle bot while its owner is unavailable', () => {
  const f = fixture(2); f.status('helper-1', { mode: 'emergency' });
  const goal = f.core.createGoal({ kind: 'craft', item: 'stone_sword', requiredBotId: 'helper-1', preferredBotId: 'helper-0' });
  assert.equal(f.assignments().length, 0);
  f.status('helper-1');
  assert.equal(f.assignments().length, 1); assert.equal(f.assignments()[0]!.botId, 'helper-1');
  assert.equal(f.assignments()[0]!.payload.task.goalId, goal.id);
  assert.throws(() => f.core.createGoal({ kind: 'craft', item: 'stone_sword', requiredBotId: 'missing-bot' }));
});

test('binding an existing equipment job safely transfers the same checkpoint without replanning or refreshing resource budgets',()=>{
 const f=fixture(2),g=f.core.createGoal({kind:'craft',item:'stone_sword',preferredBotId:'helper-0'}),first=f.assignments()[0]!;
 f.receive('helper-0','task.started',{},first);
 const bound=f.core.updateGoal(g.id,{requiredBotId:'helper-1'});assert.equal(bound.generation,0);assert.equal(f.assignments().length,1);
 assert.ok(f.sent.some(m=>m.type==='task.cancel'&&m.attemptId===first.attemptId&&m.payload.preserveProgress));
 const checkpoint={resourceRecovery:{cobblestone:{destinationsUsed:5,elapsedMs:60000}},workStep:3};
 f.receive('helper-0','task.cancelled',{safeStopped:true,checkpoint,observations:[],evidence:[]},first);
 const second=f.assignments().at(-1)!;assert.equal(second.botId,'helper-1');assert.equal(second.taskId,first.taskId);assert.deepEqual(second.payload.checkpoint,checkpoint);
 assert.equal(f.core.getSnapshot().goals.find(x=>x.id===g.id)!.generation,0);
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

test('moderate low health and an in-progress survival episode prevent ordinary assignments without consuming retries', () => {
  const f = fixture(); f.status('bot', { health: 6.333, food: 17 });
  const goal = f.core.createGoal({ kind: 'build', params: { requiredBlocks: [{ position: { x: 8, y: 64, z: 8 }, name: 'cobblestone' }] } });
  const task = f.core.getSnapshot().tasks.find(task => task.goalId === goal.id)!;
  for (let i = 0; i < 8; i++) { f.advance(6000); f.status('bot', { health: i < 4 ? 6.333 : 14, food: 17, mode: 'idle' }); }
  assert.equal(f.assignments().length, 0); assert.equal(f.core.getSnapshot().tasks.find(value => value.id === task.id)!.retryCount, 0);
  f.status('bot', { health: 20, food: 17 }); assert.equal(f.assignments().length, 0);
  f.status('bot', { health: 20, food: 18 }); assert.equal(f.assignments().length, 1); assert.equal(f.assignments()[0]!.taskId, task.id);
  assert.equal(f.core.getSnapshot().agents[0]!.survivalRecovery, undefined);
});

test('a survival rejection before actual execution preserves the task instead of spending its retry budget', () => {
  const f = fixture(), goal = f.core.createGoal({ kind: 'craft', item: 'oak_planks' }), assigned = f.assignments()[0]!;
  f.status('bot', { health: 6.333, food: 17, mode: 'survival' });
  f.receive('bot', 'task.rejected', { reason: '회복 진행을 먼저 확인해야 합니다.', retryable: true }, assigned);
  const snapshot = f.core.getSnapshot(), task = snapshot.tasks.find(task => task.id === assigned.taskId)!;
  assert.equal(task.state, 'interrupted'); assert.equal(task.retryCount, 0); assert.equal(snapshot.attempts.find(attempt => attempt.id === assigned.attemptId)!.state, 'interrupted');
  assert.equal(snapshot.reservations.some(reservation => reservation.attemptId === assigned.attemptId), false);
  assert.equal(snapshot.agents[0]!.session!.activeAttemptId, undefined);
  for (let i = 0; i < 7; i++) { f.advance(6000); f.status('bot', { health: 14, food: 20, mode: 'idle' }); }
  assert.equal(f.assignments().length, 1);
  f.status('bot', { health: 20, food: 20 }); const resumed = f.assignments()[1]!;
  assert.equal(resumed.taskId, task.id); assert.equal(resumed.payload.task.goalId, goal.id); assert.notEqual(resumed.attemptId, assigned.attemptId);
  assert.equal(f.core.getSnapshot().tasks.find(value => value.id === task.id)!.retryCount, 0);
  assert.equal(f.receive('bot', 'task.rejected', { reason: 'stale duplicate', retryable: true }, assigned), false);
});

test('ordinary execution failures and nonretryable capability rejection retain their existing failure policy', () => {
  for (const retryable of [true, false]) {
    const f = fixture(); f.core.createGoal({ kind: 'craft', item: 'oak_planks' }); const assigned = f.assignments()[0]!;
    if (!retryable) f.status('bot', { health: 6.333, food: 17 });
    f.receive('bot', 'task.rejected', { reason: '실행 능력 확인 실패', retryable }, assigned);
    const task = f.core.getSnapshot().tasks[0]!;
    assert.equal(task.state, retryable ? 'retry-wait' : 'held'); assert.equal(task.retryCount, retryable ? 1 : 0);
  }
});

test('survival wait evidence and exhausted search remain persisted across central restart until a fresh body confirms full recovery', () => {
  const f = fixture(), episode = { startedAt: f.now(), targetHealth: 20 as const, checkpoint: { resourceRecovery: { $food: { origin: { x: 0, y: 64, z: 0 }, destinationsUsed: 5, elapsedMs: 60000, status: 'exhausted' } } }, wait: { fingerprint: 'actual unchanged food inputs', reason: '식량 탐색 예산 소진' }, knowledge: { origin: { x: 0, y: 64, z: 0 }, blocks: [{ position: { x: 1, y: 64, z: 1 }, name: 'wheat', state: 'age:0' }] } };
  f.status('bot', { health: 6.333, food: 17, mode: 'survival', survivalRecovery: episode });
  const goal = f.core.createGoal({ kind: 'craft', item: 'oak_planks' });
  f.status('bot', { health: 14, food: 20, mode: 'survival', survivalRecovery: episode });
  const saved = f.core.checkpoint(), sent: CentralMessage[] = [], restored = new FleetController({ checkpoint: saved, controllerEpoch: 'new-epoch', now: f.now, send: (_id, message) => sent.push(message) });
  assert.deepEqual(restored.getSnapshot().agents[0]!.survivalRecovery, episode);
  restored.confirmWorkerStopped('bot', 'bot-session'); restored.startSession('bot', 'new-session');
  const receive = (type: string, payload: unknown, overrides = {}) => restored.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: 'new-epoch', botId: 'bot', sessionId: 'new-session', sentAt: f.now(), type, payload, ...overrides });
  const report = (health: number) => ({ ...f.report(), health, food: 20, mode: 'idle' });
  receive('bot.ready', report(14)); receive('rules.applied', { version: restored.getSnapshot().rules.version });
  assert.equal(sent.filter(message => message.type === 'task.assign').length, 0);
  assert.equal(receive('bot.status', report(20), { sessionId: 'bot-session' }), false);
  assert.deepEqual(restored.getSnapshot().agents[0]!.survivalRecovery, episode);
  receive('bot.status', report(20)); assert.equal(restored.getSnapshot().agents[0]!.survivalRecovery, undefined);
  const assigned = sent.find(message => message.type === 'task.assign'); assert.ok(assigned?.type === 'task.assign'); assert.equal(assigned.payload.task.goalId, goal.id); FleetCheckpointSchema.parse(restored.checkpoint());
});

test('a healing support helper is not sent into another fight while its recovery episode is pending', () => {
  const f = fixture(1); f.status('helper-0', { health: 6.333, food: 17 }); f.status('helper-0', { health: 14, food: 20, mode: 'idle' });
  f.alert(); assert.equal(f.assignments().length, 0); assert.equal(f.core.getSnapshot().goals.length, 0);
  f.status('helper-0', { health: 20, food: 20 }); f.alert(); assert.equal(f.assignments().length, 1);
});

for (const blockedBy of ['emergency', 'recovery', 'paused', 'not-ready', 'busy', 'rules'] as const) test(`a ${blockedBy} admission race waits for a new eligible report without spending retries or losing progress`, () => {
  const f = fixture(), goal = f.core.createGoal({ kind: 'craft', item: 'oak_planks' }), assigned = f.assignments()[0]!;
  const checkpoint = { placed: 7, resourceRecovery: { sand: { destinationsUsed: 5, elapsedMs: 60000, resourceJourney: { moves: 95, visited: [{ x: 8, y: 64, z: 8 }] } } } };
  f.receive('bot', 'task.progress', { action: '수집', reason: 'saved work', progress: 0.4, checkpoint }, assigned);
  // The last scheduling report is still healthy: the rejection itself must
  // prevent reassignment until another report, even when IPC/status race.
  assert.equal(f.receive('bot', 'task.rejected', { reason: `waiting for ${blockedBy}`, retryable: true, blockedBy }, assigned), true);
  for (let i = 0; i < 4; i++) { f.advance(10); f.core.tick(); }
  assert.equal(f.assignments().length, 1);
  const blockedReport = blockedBy === 'not-ready' ? { ready: false }
    : blockedBy === 'busy' ? { mode: 'working', currentAttemptId: 'other-actual-work' }
    : blockedBy === 'rules' ? { rulesVersion: 0 }
    : { mode: blockedBy === 'recovery' ? 'recovering' : blockedBy };
  for (let i = 0; i < 3; i++) { f.advance(10); f.status('bot', blockedReport); }
  assert.equal(f.assignments().length, 1);
  const waiting = f.core.getSnapshot().tasks.find(t => t.id === assigned.taskId)!;
  assert.equal(waiting.retryCount, 0); assert.equal(waiting.assignmentWait?.blockedBy, blockedBy); assert.deepEqual(waiting.checkpoint, checkpoint);
  assert.equal(f.core.getSnapshot().reservations.some(r => r.attemptId === assigned.attemptId), false);
  f.advance(10); f.status();
  const resumed = f.assignments()[1]!;
  assert.equal(resumed.taskId, assigned.taskId); assert.equal(resumed.payload.task.goalId, goal.id); assert.deepEqual(resumed.payload.checkpoint, checkpoint);
  assert.equal(f.core.getSnapshot().tasks.find(t => t.id === assigned.taskId)!.retryCount, 0);
  assert.equal(f.core.getSnapshot().tasks.find(t => t.id === assigned.taskId)!.assignmentWait, undefined);
  assert.equal(f.receive('bot', 'task.rejected', { reason: 'old rejection replay', retryable: true, blockedBy }, assigned), false);
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

function legacyHeldAssignment(extra: { started?: boolean; code?: string; retryable?: boolean; effectsKnown?: boolean; reason?: string; cancelled?: boolean } = {}) {
  const f = fixture(); f.core.createGoal({ kind: 'craft', item: 'oak_planks' });
  const saved = f.core.checkpoint(), task = saved.tasks[0]!, attempt = saved.attempts[0]!, goal = saved.goals[0]!;
  const reason = extra.reason ?? '현재 상태에서는 일반 작업을 시작할 수 없습니다.';
  task.state = 'held'; task.reason = reason; task.retryCount = 5; task.resumeCount = 44; task.progress = 0.4;
  task.checkpoint = { placed: 7, resourceRecovery: { sand: { destinationsUsed: 5, elapsedMs: 60000, resourceJourney: { moves: 95 } } } };
  attempt.state = 'failed'; attempt.finishedAt = f.now(); if (extra.started) attempt.startedAt = f.now();
  attempt.result = { outcome: 'failed', observations: [], evidence: [], checkpoint: structuredClone(task.checkpoint), error: { code: extra.code ?? 'TASK_REJECTED', message: reason, retryable: extra.retryable ?? true, effectsKnown: extra.effectsKnown ?? true } };
  goal.state = extra.cancelled ? 'cancelled' : 'held'; goal.reason = reason; saved.reservations = []; saved.agents[0]!.session!.activeAttemptId = undefined;
  const sent: CentralMessage[] = [], restored = new FleetController({ checkpoint: saved, controllerEpoch: 'assignment-restored', now: f.now, send: (_id, message) => sent.push(message) });
  restored.confirmWorkerStopped('bot', 'bot-session'); restored.startSession('bot', 'replacement');
  const receive = (type: string, payload: unknown) => restored.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: restored.controllerEpoch, sessionId: 'replacement', botId: 'bot', sentAt: f.now(), type, payload });
  const ready = () => { receive('bot.ready', f.report()); receive('rules.applied', { version: restored.getSnapshot().rules.version }); receive('bot.status', f.report()); };
  return { restored, sent, saved, task, goal, ready, receive, report: f.report };
}

test('legacy pre-execution state rejection at the retry limit resumes the same work only after fresh ready evidence, keeping all budgets and failure history', () => {
  const f = legacyHeldAssignment();
  assert.equal(f.restored.getSnapshot().tasks[0]!.state, 'interrupted'); assert.equal(f.restored.getSnapshot().tasks[0]!.assignmentWait?.blockedBy, 'state');
  f.restored.tick(); assert.equal(f.sent.some(m => m.type === 'task.assign'), false);
  f.receive('bot.ready', f.report({ mode: 'emergency' })); f.receive('rules.applied', { version: f.restored.getSnapshot().rules.version });
  f.receive('bot.status', f.report({ mode: 'recovering' })); assert.equal(f.sent.some(m => m.type === 'task.assign'), false);
  f.receive('bot.status', f.report());
  const assigned = f.sent.find(m => m.type === 'task.assign')!;
  assert.equal(assigned.taskId, f.task.id); assert.deepEqual(assigned.payload.checkpoint, f.task.checkpoint);
  const actual = f.restored.getSnapshot().tasks[0]!;
  assert.equal(actual.retryCount, 5); assert.equal(actual.resumeCount, 44); assert.equal(actual.progress, 0.4);
  assert.deepEqual(f.restored.getSnapshot().attempts[0]!.result, f.saved.attempts[0]!.result);
  assert.ok(f.restored.getSnapshot().events.some(e => e.type === 'task.assignment-resumed'));
  FleetCheckpointSchema.parse(f.restored.checkpoint());
});

for (const extra of [{ started: true }, { code: 'ACTION_FAILED' }, { retryable: false }, { effectsKnown: false }, { reason: '실행 능력 확인 실패' }, { cancelled: true }]) test(`legacy repair preserves genuine failures, uncertain effects and cancelled goals: ${JSON.stringify(extra)}`, () => {
  const f = legacyHeldAssignment(extra); f.ready();
  assert.equal(f.restored.getSnapshot().tasks[0]!.state, 'held'); assert.equal(f.sent.some(m => m.type === 'task.assign'), false);
  assert.equal(f.restored.getSnapshot().tasks[0]!.retryCount, 5);
});
