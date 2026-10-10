import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { FleetController } from '../packages/core/src';
import { FleetCheckpointSchema, accessPreparationProofPositions, blueprint, type BuildAccessPreparation, type CentralMessage, type ExpectedBlock, type Position } from '../packages/contracts/src';

const world = '127.0.0.1:25566', dimension = 'overworld';
function fixture() {
  let now = 100000;
  const sent: CentralMessage[] = [];
  const core = new FleetController({ now: () => now, controllerEpoch: 'access-epoch', send: (_id, message) => sent.push(message), rules: { world, dimension, autonomyEnabled: false } });
  const receive = (type: string, payload: unknown, assignment?: Extract<CentralMessage, { type: 'task.assign' }>) => core.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: core.controllerEpoch, botId: 'builder', sessionId: 'build-session', sentAt: now, type, payload, ...(assignment ? { taskId: assignment.taskId, attemptId: assignment.attemptId } : {}) });
  const report = (position: Position) => ({ ready: true, world, dimension, position, health: 20, food: 20, inventory: [], action: 'build', reason: 'ready', mode: 'idle', capabilities: ['build', 'collect'], rulesVersion: 1 });
  core.addAgent({ id: 'builder', name: 'AccessBuilder', allowedActions: ['build', 'collect'] }); core.startSession('builder', 'build-session'); receive('bot.ready', report({ x: 0.5, y: 64, z: 0.5 })); receive('rules.applied', { version: 1 });
  const origin = { x: 3, y: 64, z: 2 }, target = { x: 5, y: 64, z: 1 };
  const goal = core.createGoal({ kind: 'build', params: { design: 'cabin', origin } });
  const assignments = () => sent.filter((m): m is Extract<CentralMessage, { type: 'task.assign' }> => m.type === 'task.assign');
  const parent = assignments()[0]!;
  const plan: BuildAccessPreparation = { start: { x: 0, y: 64, z: 0 }, target, observedAt: now, path: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }, target], edits: [{ position: { x: 1, y: 64, z: 0 }, before: 'dirt', after: 'air' }] };
  const before: ExpectedBlock[] = accessPreparationProofPositions(plan).map(position => ({ position, name: position.x === 1 && position.y === 64 && position.z === 0 ? 'dirt' : position.y < 64 ? 'grass_block' : 'air' }));
  const observation = (blocks: ExpectedBlock[]) => ({ id: randomUUID(), kind: 'blocks', world, dimension, observedAt: now, data: { blocks } });
  const propose = (p: unknown = plan, blocks = before) => receive('task.result', { outcome: 'condition-wait', reason: '건축 입구까지 확인한 천연 접근로를 먼저 준비해야 합니다.', checkpoint: { placed: 17, ownInventory: { dirt: 0 }, buildAccessPreparation: p, waitingFor: { kind: 'blocks', causeCode: 'BUILD_ACCESS', positions: [target], watchPosition: true } }, observations: [observation(blocks)], evidence: [] }, parent);
  const complete = (child: Extract<CentralMessage, { type: 'task.assign' }>, extra = {}) => receive('task.result', { outcome: 'completed', checkpoint: { accessPreparationComplete: { target, observedAt: now } }, observations: [observation(before.map(b => ({ ...b, name: b.position.x === 1 && b.position.y === 64 && b.position.z === 0 ? 'air' : b.name }))), { id: randomUUID(), kind: 'exploration', world, dimension, observedAt: now, data: { position: { ...target, x: target.x + 0.5, z: target.z + 0.5 }, resources: [] } }], evidence: [], ...extra }, child);
  return { core, receive, assignments, parent, goal, plan, before, origin, target, report, propose, complete, observation, now: () => now, advance: (ms: number) => now += ms };
}

test('approved access preparation reserves actual route, preserves the original build and resumes after actual arrival', () => {
  const f = fixture(); assert.equal(f.propose(), true);
  const child = f.assignments()[1]!; assert.equal(child.payload.task.kind, 'build'); assert.equal(child.payload.task.params.mode, 'prepare-access'); assert.equal(child.payload.task.params.parentTaskId, f.parent.taskId);
  assert.equal(child.payload.task.goalId, f.goal.id); assert.equal(child.botId, f.parent.botId);
  assert.ok(f.core.getSnapshot().reservations.some(r => r.taskId === child.taskId && r.key.endsWith('1,64,0')));
  assert.equal((child.payload.task.params.protectedPositions as unknown[]).length, 0, 'the pending parent does not prevent its approved natural approach edits');
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === f.goal.id)!.generation, 0);
  f.complete(child);
  assert.equal(f.core.getSnapshot().tasks.find(t => t.id === child.taskId)!.state, 'completed');
  const resumed = f.assignments()[2]!; assert.equal(resumed.taskId, f.parent.taskId); assert.equal(resumed.payload.checkpoint.placed, 17);
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === f.goal.id)!.state, 'active', 'a usable approach is not a completed cabin');
  assert.deepEqual(resumed.payload.task.completion, { kind: 'blocks', blocks: blueprint('cabin', f.origin) });
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

for (const defect of ['missing-proof', 'wrong-target', 'changed-world', 'existing-structure', 'planned-building-cell']) test(`central access approval refuses ${defect}`, () => {
  const f = fixture();
  if (defect === 'missing-proof') f.propose(f.plan, f.before.slice(1));
  else if (defect === 'wrong-target') f.propose({ ...f.plan, target: { x: 4, y: 64, z: 1 } });
  else if (defect === 'changed-world') f.propose(f.plan, f.before.map(b => b.position.x === 1 && b.position.y === 64 && b.position.z === 0 ? { ...b, name: 'stone' } : b));
  else if (defect === 'existing-structure') f.propose(f.plan, f.before.map(b => b.position.x === 1 && b.position.y === 65 && b.position.z === 0 ? { ...b, name: 'chest' } : b));
  else {
    const target = { x: 5, y: 64, z: 1 }, start = { x: 3, y: 64, z: 1 }, edit = { position: { x: 3, y: 64, z: 2 }, before: 'dirt', after: 'air' as const };
    const p = { ...f.plan, start, target, path: [start, edit.position, { x: 4, y: 64, z: 2 }, { x: 5, y: 64, z: 2 }, target], edits: [edit] };
    f.receive('bot.status', f.report({ ...start, x: start.x + 0.5, z: start.z + 0.5 }));
    f.propose(p, accessPreparationProofPositions(p).map(position => ({ position, name: position.x === edit.position.x && position.y === edit.position.y && position.z === edit.position.z ? 'dirt' : position.y < 64 ? 'grass_block' : 'air' })));
  }
  assert.equal(f.assignments().length, 1);
  assert.equal(f.core.getSnapshot().tasks.some(t => t.params.mode === 'prepare-access'), false);
});

for (const defect of ['unvisited-target', 'missing-proof', 'unfinished-edit', 'wrong-marker', 'stale-marker']) test(`access completion cannot resume building with ${defect}`, () => {
  const f = fixture(); f.propose(); const child = f.assignments()[1]!;
  if (defect === 'unvisited-target') f.complete(child, { observations: [f.observation(f.before.map(b => ({ ...b, name: b.position.x === 1 && b.position.y === 64 && b.position.z === 0 ? 'air' : b.name })))] });
  else if (defect === 'missing-proof') f.complete(child, { observations: [] });
  else if (defect === 'unfinished-edit') f.complete(child, { observations: [f.observation(f.before)] });
  else if (defect === 'wrong-marker') f.complete(child, { checkpoint: { accessPreparationComplete: { target: { ...f.target, x: 99 }, observedAt: f.now() } } });
  else f.complete(child, { checkpoint: { accessPreparationComplete: { target: f.target, observedAt: f.now() - 1 } } });
  assert.equal(f.assignments().length, 2); assert.equal(f.core.getSnapshot().tasks.find(t => t.id === child.taskId)!.state, 'held');
  assert.equal(f.core.getSnapshot().goals.find(g => g.id === f.goal.id)!.state, 'held');
});

test('controller restart preserves the access dependency and original build checkpoint after actual stopped and block evidence', () => {
  const f = fixture(); f.propose(); const child = f.assignments()[1]!;
  f.receive('task.progress', { action: '접근로 정리', reason: '한 칸 정리', checkpoint: { accessPreparationProgress: { completedEdits: 1, totalEdits: 1 } }, observations: [] }, child);
  const sent: CentralMessage[] = [], restored = new FleetController({ checkpoint: f.core.checkpoint(), controllerEpoch: 'restored-access', now: f.now, send: (_id, message) => sent.push(message) });
  restored.startSession('builder', 'next-build-session');
  const receive = (type: string, payload: unknown) => restored.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: restored.controllerEpoch, botId: 'builder', sessionId: 'next-build-session', sentAt: f.now(), type, payload });
  receive('bot.ready', f.report({ x: 0.5, y: 64, z: 0.5 })); receive('rules.applied', { version: 1 });
  restored.confirmWorkerStopped('builder', 'build-session');
  assert.equal(sent.some(m => m.type === 'task.assign'), false, 'inventory and ready alone do not prove the approach world');
  receive('world.observed', { observations: [f.observation(f.before.map(b => ({ ...b, name: b.position.x === 1 && b.position.y === 64 && b.position.z === 0 ? 'air' : b.name })))] });
  const resumed = sent.find((m): m is Extract<CentralMessage, { type: 'task.assign' }> => m.type === 'task.assign'); assert.ok(resumed);
  assert.equal(resumed.taskId, child.taskId); assert.equal(resumed.payload.task.goalId, f.goal.id);
  assert.equal(restored.getSnapshot().goals.find(g => g.id === f.goal.id)!.generation, 0);
  const parent = restored.getSnapshot().tasks.find(t => t.id === f.parent.taskId)!; assert.equal(parent.checkpoint.placed, 17); assert.ok(parent.dependencies.includes(child.taskId));
  assert.equal(resumed.payload.checkpoint.accessPreparationProgress && (resumed.payload.checkpoint.accessPreparationProgress as { completedEdits: number }).completedEdits, 1);
  FleetCheckpointSchema.parse(restored.checkpoint());
});
