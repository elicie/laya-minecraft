import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { FleetController } from '../packages/core/src';
import { FleetCheckpointSchema, accessPreparationProofPositions, blueprint, type BuildAccessPreparation, type CentralMessage, type ExpectedBlock, type Position } from '../packages/contracts/src';

const world = '127.0.0.1:25566', dimension = 'overworld';
function fixture(design: 'cabin'|'warehouse' = 'cabin') {
  let now = 100000;
  const sent: CentralMessage[] = [];
  const core = new FleetController({ now: () => now, controllerEpoch: 'access-epoch', send: (_id, message) => sent.push(message), rules: { world, dimension, autonomyEnabled: false } });
  const receive = (type: string, payload: unknown, assignment?: Extract<CentralMessage, { type: 'task.assign' }>) => core.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: core.controllerEpoch, botId: 'builder', sessionId: 'build-session', sentAt: now, type, payload, ...(assignment ? { taskId: assignment.taskId, attemptId: assignment.attemptId } : {}) });
  const report = (position: Position) => ({ ready: true, world, dimension, position, health: 20, food: 20, inventory: [], action: 'build', reason: 'ready', mode: 'idle', capabilities: ['build', 'collect'], rulesVersion: 1 });
  core.addAgent({ id: 'builder', name: 'AccessBuilder', allowedActions: ['build', 'collect'] }); core.startSession('builder', 'build-session'); receive('bot.ready', report({ x: 0.5, y: 64, z: 0.5 })); receive('rules.applied', { version: 1 });
  const origin = { x: 3, y: 64, z: 2 }, target = { x: design==='warehouse'?6:5, y: 64, z: 1 };
  const goal = core.createGoal({ kind: 'build', params: { design, origin } });
  const assignments = () => sent.filter((m): m is Extract<CentralMessage, { type: 'task.assign' }> => m.type === 'task.assign');
  const parent = assignments()[0]!;
  const plan: BuildAccessPreparation = { start: { x: 0, y: 64, z: 0 }, target, observedAt: now, path: [...Array.from({length:target.x+1},(_,x)=>({x,y:64,z:0})), target], edits: [{ position: { x: 1, y: 64, z: 0 }, before: 'dirt', after: 'air' }] };
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
  const protectedPositions=child.payload.task.params.protectedPositions as Position[];
  assert.ok(protectedPositions.some(p=>p.x===f.origin.x&&p.y===f.origin.y&&p.z===f.origin.z),'the original building footprint remains protected');
  assert.ok(f.plan.edits.every(e=>!protectedPositions.some(p=>p.x===e.position.x&&p.y===e.position.y&&p.z===e.position.z)),'the pending parent does not prevent its approved natural approach edits');
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

test('an approved completion delayed beyond the evidence window requests fresh proof without accepting stale observations or spending execution retries', () => {
  const f = fixture(); f.propose(); const child = f.assignments()[1]!, observedAt = f.now();
  const checkpoint = { accessPreparationComplete: { target: f.target, observedAt }, accessPreparationProgress: { completedEdits: 1, totalEdits: 1, pathIndex: f.plan.path.length, pathLength: f.plan.path.length }, savedResourceBudget: { moves: 95, elapsedMs: 60000 } };
  const observations = [f.observation(f.before.map(b => ({ ...b, name: b.position.x === 1 && b.position.y === 64 && b.position.z === 0 ? 'air' : b.name }))), { id: randomUUID(), kind: 'exploration', world, dimension, observedAt, data: { position: { ...f.target, x: f.target.x + .5, z: f.target.z + .5 }, resources: [] } }];
  f.advance(41607); f.complete(child, { checkpoint, observations });
  const waiting = f.core.getSnapshot().tasks.find(t => t.id === child.taskId)!;
  assert.equal(waiting.state, 'interrupted'); assert.equal(waiting.retryCount, 0); assert.equal(waiting.accessProofRechecks, 1);
  assert.equal(waiting.assignmentWait?.botId, child.botId); assert.equal(waiting.checkpoint.accessPreparationComplete, undefined);
  assert.deepEqual(waiting.checkpoint.savedResourceBudget, checkpoint.savedResourceBudget); assert.deepEqual(waiting.checkpoint.accessPreparationProgress, checkpoint.accessPreparationProgress);
  assert.equal(f.assignments().length, 2); for (let i = 0; i < 4; i++) f.core.tick(); assert.equal(f.assignments().length, 2, 'old scheduling report cannot authorize a new attempt');
  f.receive('bot.status', f.report({ ...f.target, x: f.target.x + .5, z: f.target.z + .5 }));
  const recheck = f.assignments()[2]!; assert.equal(recheck.taskId, child.taskId);
  assert.notEqual(recheck.attemptId, child.attemptId); assert.deepEqual(recheck.payload.checkpoint.accessPreparationProgress, checkpoint.accessPreparationProgress);
  f.complete(recheck, { checkpoint: { ...recheck.payload.checkpoint, accessPreparationComplete: { target: f.target, observedAt: f.now() } } });
  assert.equal(f.core.getSnapshot().tasks.find(t => t.id === child.taskId)!.state, 'completed');
  assert.equal(f.assignments().at(-1)!.taskId, f.parent.taskId); assert.equal(f.assignments().at(-1)!.payload.checkpoint.placed, 17);
  const old = f.core.getSnapshot().attempts.find(a => a.id === child.attemptId)!; assert.equal(old.state, 'uncertain'); assert.equal(old.result!.observations[0]!.observedAt, observedAt);
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('repeated delayed completion refreshes are bounded even if worker checkpoints omit the central refresh counter', () => {
  const f = fixture(); f.propose(); let child = f.assignments()[1]!;
  for (let i = 0; i < 3; i++) {
    const observedAt = f.now(); f.advance(40000);
    f.complete(child, { checkpoint: { accessPreparationComplete: { target: f.target, observedAt } } });
    const task = f.core.getSnapshot().tasks.find(t => t.id === child.taskId)!;
    assert.equal(task.retryCount, 0); assert.equal(task.accessProofRechecks, Math.min(i + 1, 2));
    if (i < 2) { assert.equal(task.state, 'interrupted'); f.receive('bot.status', f.report({ ...f.target, x: f.target.x + .5, z: f.target.z + .5 })); child = f.assignments().at(-1)!; }
    else { assert.equal(task.state, 'held'); assert.match(task.reason!, /재확인 2회/); }
  }
});

test('a legacy held access completion is re-observed after restart while preserving its uncertain history and original building dependency', () => {
  const f = fixture(); f.propose(); const child = f.assignments()[1]!, observedAt = f.now(); f.advance(41607);
  const saved = f.core.checkpoint(), task = saved.tasks.find(t => t.id === child.taskId)!, attempt = saved.attempts.find(a => a.id === child.attemptId)!;
  task.state = 'held'; task.retryCount = 1; task.checkpoint = { accessPreparationComplete: { target: f.target, observedAt }, accessPreparationProgress: { completedEdits: 1, totalEdits: 1, pathIndex: f.plan.path.length, pathLength: f.plan.path.length } };
  task.reason = '예약한 접근로의 실제 변경과 기존 건축 입구 도착을 확인했습니다.';
  attempt.state = 'uncertain'; attempt.finishedAt = f.now(); attempt.result = { outcome: 'completed', observations: [], evidence: [], checkpoint: structuredClone(task.checkpoint), reason: task.reason };
  saved.goals.find(g => g.id === f.goal.id)!.state = 'held'; saved.agents[0]!.session!.activeAttemptId = undefined;
  const sent: CentralMessage[] = [], restored = new FleetController({ checkpoint: saved, now: f.now, controllerEpoch: 'access-proof-restored', send: (_id,m) => sent.push(m) });
  assert.equal(restored.getSnapshot().tasks.find(t => t.id === task.id)!.state, 'interrupted');
  restored.confirmWorkerStopped('builder','build-session'); restored.startSession('builder','fresh-access-session');
  const receive = (type: string,payload:unknown) => restored.receive({ protocolVersion:1,messageId:randomUUID(),controllerEpoch:restored.controllerEpoch,botId:'builder',sessionId:'fresh-access-session',sentAt:f.now(),type,payload });
  const report = f.report({ ...f.target,x:f.target.x+.5,z:f.target.z+.5 });
  receive('bot.ready',report); receive('rules.applied',{version:1}); receive('bot.status',report);
  assert.equal(sent.some(m=>m.type==='task.assign'),false,'a restarted worker must first supply current world observations');
  receive('world.observed',{observations:[f.observation(f.before.map(b=>({...b,name:b.position.x===1&&b.position.y===64&&b.position.z===0?'air':b.name})))]});
  receive('bot.status',report);
  const next = sent.find(m=>m.type==='task.assign')!; assert.equal(next.taskId,task.id);
  assert.deepEqual(next.payload.checkpoint.accessPreparationProgress,task.checkpoint.accessPreparationProgress);
  assert.equal(restored.getSnapshot().tasks.find(t=>t.id===task.id)!.retryCount,1);
  assert.equal(restored.getSnapshot().attempts.find(a=>a.id===attempt.id)!.state,'uncertain');
  assert.ok(restored.getSnapshot().tasks.find(t=>t.id===f.parent.taskId)!.dependencies.includes(task.id));
  FleetCheckpointSchema.parse(restored.checkpoint());
});

test('an old completed-corridor departure wait receives one state-gated recheck without resetting resource or retry budgets',()=>{
  const f=fixture();f.propose();const child=f.assignments()[1]!;
  const waitingFor={kind:'blocks',causeCode:'BUILD_ACCESS',positions:[f.plan.start],watchPosition:true};
  f.receive('task.result',{outcome:'condition-wait',reason:'20초 동안 옛 출발점에 접근하지 못했습니다.',checkpoint:{accessPreparationProgress:{completedEdits:1,totalEdits:1,pathIndex:f.plan.path.length,pathLength:f.plan.path.length},waitingFor,savedResourceBudget:{moves:160,elapsedMs:700000}},observations:[],evidence:[]},child);
  const saved=f.core.checkpoint(),before=saved.tasks.find(t=>t.id===child.taskId)!;
  const restored=new FleetController({checkpoint:saved,now:f.now,send(){}}),task=restored.checkpoint().tasks.find(t=>t.id===child.taskId)!;
  assert.equal(task.state,'interrupted');assert.equal(task.checkpoint.accessReturnRouteVersion,3);assert.equal(task.assignmentWait?.botId,'builder');
  assert.equal(task.retryCount,before.retryCount);assert.deepEqual(task.checkpoint.savedResourceBudget,before.checkpoint.savedResourceBudget);assert.equal(task.waitState,undefined);
  const repeated=restored.checkpoint(),again=repeated.tasks.find(t=>t.id===task.id)!;again.state='condition-wait';again.waitState=before.waitState;again.checkpoint.waitingFor=waitingFor;
  const next=new FleetController({checkpoint:repeated,now:f.now,send(){}}).checkpoint().tasks.find(t=>t.id===task.id)!;
  assert.equal(next.state,'condition-wait');assert.equal(next.resumeCount,task.resumeCount,'the code migration cannot restart an unchanged failure on every reboot');
  FleetCheckpointSchema.parse(restored.checkpoint());
});

function returnFixture(design:'cabin'|'warehouse'='cabin') {
  const f=fixture(design);f.propose();const child=f.assignments()[1]!;
  const start={x:0,y:64,z:-3},plan:BuildAccessPreparation={start,target:f.target,observedAt:f.now(),path:[...Array.from({length:f.target.x+1},(_,x)=>({x,y:64,z:-3})),...[-2,-1,0,1].map(z=>({x:f.target.x,y:64,z}))],edits:[{position:{x:1,y:64,z:-3},before:'dirt',after:'air'}]};
  const oldAfter=f.before.map(b=>({...b,name:b.position.x===1&&b.position.y===64&&b.position.z===0?'air':b.name}));
  const before=accessPreparationProofPositions(plan).map(position=>({position,name:position.x===1&&position.y===64&&position.z===-3?'dirt':position.y<64?'grass_block':'air'}));
  const propose=(blocks:ExpectedBlock[]=[...oldAfter,...before],override:unknown=plan)=>{
    f.receive('bot.status',f.report({...start,x:start.x+.5,z:start.z+.5}));
    return f.receive('task.result',{outcome:'condition-wait',reason:'current body needs a new reserved approach',checkpoint:{buildAccessPreparation:override,accessPreparationProgress:{completedEdits:1,totalEdits:1,pathIndex:f.plan.path.length,pathLength:f.plan.path.length},waitingFor:{kind:'blocks',causeCode:'BUILD_ACCESS',positions:[f.target],watchPosition:true},savedResourceBudget:{moves:160}},observations:[f.observation(blocks)],evidence:[]},child);
  };
  return {f,child,plan,oldAfter,before,propose};
}

for(const design of ['cabin','warehouse'] as const)test(`a completed ${design} corridor can request one centrally verified return subtask using its pinned entrance and resume both checkpoints`,()=>{
  const {f,child,plan,oldAfter,before,propose}=returnFixture(design);propose();const nested=f.assignments()[2]!;
  assert.ok(nested);assert.equal(nested.payload.task.params.parentTaskId,child.taskId);assert.equal(nested.payload.task.params.accessReturnDepth,1);
  assert.ok(f.core.checkpoint().tasks.find(t=>t.id===child.taskId)!.dependencies.includes(nested.taskId));
  assert.ok((nested.payload.task.params.protectedPositions as Position[]).some(p=>p.x===f.origin.x&&p.z===f.origin.z));
  assert.ok((nested.payload.task.params.protectedPositions as Position[]).some(p=>p.x===f.plan.start.x&&p.z===f.plan.start.z));
  const after=before.map(b=>({...b,name:b.position.x===1&&b.position.y===64&&b.position.z===-3?'air':b.name}));
  f.complete(nested,{observations:[f.observation([...oldAfter,...after]),{id:randomUUID(),kind:'exploration',world,dimension,observedAt:f.now(),data:{position:{...plan.target,x:plan.target.x+.5,z:plan.target.z+.5},resources:[]}}]});
  const resumed=f.assignments()[3]!;assert.equal(resumed.taskId,child.taskId);assert.equal((resumed.payload.checkpoint.savedResourceBudget as {moves:number}).moves,160);
  f.complete(resumed);assert.equal(f.assignments().at(-1)!.taskId,f.parent.taskId);assert.equal(f.assignments().at(-1)!.payload.checkpoint.placed,17);
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

for(const defect of ['missing-original-proof','unfinished-original-edit','building-cell'])test(`a return subtask refuses ${defect} without issuing new reservations`,()=>{
  const {f,child,plan,oldAfter,before,propose}=returnFixture();
  if(defect==='missing-original-proof')propose(before);
  else if(defect==='unfinished-original-edit')propose([...f.before,...before]);
  else propose([...oldAfter,...before],{...plan,edits:[...plan.edits,{position:f.origin,before:'dirt',after:'air'}]});
  assert.equal(f.assignments().length,2);assert.equal(f.core.checkpoint().tasks.some(t=>t.params.parentTaskId===child.taskId),false);
});

test('central verification refuses recursive return subtasks even with fresh complete route evidence',()=>{
  const {f,child,oldAfter,before,propose}=returnFixture();propose();const nested=f.assignments()[2]!;
  const start={x:0,y:64,z:-5},plan:BuildAccessPreparation={start,target:f.target,observedAt:f.now(),path:[...[0,1,2,3,4,5].map(x=>({x,y:64,z:-5})),...[-4,-3,-2,-1,0,1].map(z=>({x:5,y:64,z}))],edits:[]};
  const originalAfter=before.map(b=>({...b,name:b.position.x===1&&b.position.y===64&&b.position.z===-3?'air':b.name}));
  const blocks=accessPreparationProofPositions(plan).map(position=>({position,name:position.y<64?'grass_block':'air'}));
  f.receive('bot.status',f.report({...start,x:start.x+.5,z:start.z+.5}));
  f.receive('task.result',{outcome:'condition-wait',reason:'another displacement',checkpoint:{buildAccessPreparation:plan,waitingFor:{kind:'blocks',causeCode:'BUILD_ACCESS',positions:[f.target],watchPosition:true}},observations:[f.observation([...oldAfter,...originalAfter,...blocks])],evidence:[]},nested);
  assert.equal(f.assignments().length,3);assert.equal(f.core.checkpoint().tasks.some(t=>t.params.parentTaskId===nested.taskId),false);
  assert.ok(f.core.checkpoint().tasks.find(t=>t.id===child.taskId)!.dependencies.includes(nested.taskId));
  assert.equal(f.core.checkpoint().tasks.find(t=>t.id===f.parent.taskId)!.checkpoint.placed,17);
});

test('legacy timer-held material returns receive one observation-gated recovery without erasing the trip or resource budget',()=>{
  const f=fixture(),checkpoint={resourceTrip:{item:'glass_pane',minimum:3,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0}],phase:'returning',returns:7},resourceRecovery:{sand:{destinationsUsed:5,elapsedMs:60000}}};
  f.receive('task.result',{outcome:'condition-wait',reason:'기록한 복귀 구간의 실제 지면·경로와 위협을 다시 확인해야 합니다.',checkpoint,observations:[],evidence:[]},f.parent);
  const saved=f.core.checkpoint(),task=saved.tasks.find(t=>t.id===f.parent.taskId)!;task.params.materialExpedition=true;task.state='held';task.reason+=' 동일한 조건으로 5회 재확인했으나 진행이 없어 보류했습니다.';saved.goals[0]!.state='held';
  const next=new FleetController({checkpoint:saved,now:f.now,send(){}}).checkpoint(),restored=next.tasks.find(t=>t.id===task.id)!;
  assert.equal(restored.state,'interrupted');assert.equal(restored.checkpoint.resourceReturnVersion,1);assert.ok(restored.assignmentWait);
  assert.deepEqual(restored.checkpoint.resourceTrip,checkpoint.resourceTrip);assert.deepEqual(restored.checkpoint.resourceRecovery,checkpoint.resourceRecovery);assert.equal(restored.retryCount,task.retryCount);
  restored.state='held';restored.reason=task.reason;next.goals[0]!.state='held';
  assert.equal(new FleetController({checkpoint:next,now:f.now,send(){}}).checkpoint().tasks.find(t=>t.id===task.id)!.state,'held');
});

test('legacy held departures receive one passive footing and safety observation without resetting their expedition',()=>{
  const f=fixture(),checkpoint={resourceTrip:{item:'oak_door',minimum:1,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0}],phase:'outbound',returns:9},resourceRecovery:{oak_log:{destinationsUsed:5,elapsedMs:60000}}};
  f.receive('task.result',{outcome:'condition-wait',reason:'원정의 실제 지지 발판·착지와 주변 위협을 확인해야 합니다.',checkpoint,observations:[],evidence:[]},f.parent);
  const saved=f.core.checkpoint(),task=saved.tasks.find(t=>t.id===f.parent.taskId)!;task.params.materialExpedition=true;task.state='held';saved.goals[0]!.state='held';
  const next=new FleetController({checkpoint:saved,now:f.now,send(){}}).checkpoint(),restored=next.tasks.find(t=>t.id===task.id)!;
  assert.equal(restored.state,'interrupted');assert.equal(restored.checkpoint.resourceFootingWaitVersion,1);assert.deepEqual(restored.checkpoint.resourceTrip,checkpoint.resourceTrip);assert.deepEqual(restored.checkpoint.resourceRecovery,checkpoint.resourceRecovery);
  restored.state='held';restored.reason=task.reason;next.goals[0]!.state='held';assert.equal(new FleetController({checkpoint:next,now:f.now,send(){}}).checkpoint().tasks.find(t=>t.id===task.id)!.state,'held');
});

test('a night material wait preserves its budgets until actual daylight changes, without restarting on status timestamps',()=>{
  const f=fixture(),p={x:.5,y:64,z:.5};f.receive('bot.status',{...f.report(p),isDay:false});
  const checkpoint={waitingFor:{kind:'inventory',causeCode:'BUILD_MATERIAL',item:'cobblestone',minimum:8,watchPosition:false,watchDaylight:true},resourceRecovery:{cobblestone:{destinationsUsed:5,elapsedMs:60000}}};
  f.receive('task.result',{outcome:'condition-wait',reason:'night material expedition waiting for actual daylight',checkpoint,observations:[],evidence:[]},f.parent);
  for(let i=0;i<6;i++){f.advance(6000);f.receive('bot.status',{...f.report(p),isDay:false});f.core.tick();}
  assert.equal(f.assignments().length,1);f.receive('bot.status',{...f.report(p),isDay:true});f.core.tick();assert.equal(f.assignments().length,2);assert.deepEqual(f.assignments()[1]!.payload.checkpoint.resourceRecovery,checkpoint.resourceRecovery);
});

test('a stable departure wait resumes on actual nearby threat clearance, while identical reports and clocks do not retry it',()=>{
  const f=fixture(),p={x:.5,y:64,z:.5};f.receive('bot.status',{...f.report(p),nearbyThreatsClear:false});
  const checkpoint={waitingFor:{kind:'blocks',causeCode:'BUILD_ACCESS',positions:[{x:0,y:63,z:0}],watchPosition:true,watchSafety:true},resourceRecovery:{oak_log:{destinationsUsed:5,elapsedMs:60000}}};
  f.receive('task.result',{outcome:'condition-wait',reason:'actual threat prevents departure',checkpoint,observations:[f.observation([{position:{x:0,y:63,z:0},name:'dirt'}])],evidence:[]},f.parent);
  for(let i=0;i<6;i++){f.advance(6000);f.receive('bot.status',{...f.report(p),nearbyThreatsClear:false});f.core.tick();}
  assert.equal(f.assignments().length,1);assert.equal(f.core.checkpoint().tasks.find(t=>t.id===f.parent.taskId)!.state,'condition-wait');
  f.receive('bot.status',{...f.report(p),nearbyThreatsClear:true});f.core.tick();assert.equal(f.assignments().length,2);
  assert.deepEqual(f.assignments()[1]!.payload.checkpoint.resourceRecovery,checkpoint.resourceRecovery);
});

test('a legacy held new-life connection receives one actual return check with its previous life trail and spent budgets intact',()=>{
  const f=fixture(),checkpoint={confirmedRecoveryDeathId:'new-life',resourceTrip:{item:'oak_door',minimum:1,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0},{x:24,y:64,z:0}],phase:'outbound',deathId:'old-life',returns:10},resourceRecovery:{oak_log:{destinationsUsed:5,elapsedMs:60000}}};
  f.receive('task.result',{outcome:'condition-wait',reason:'새 생존 위치와 기존 작업 지점의 지형 연결을 먼저 확인해야 합니다.',checkpoint,observations:[],evidence:[]},f.parent);
  const saved=f.core.checkpoint(),task=saved.tasks.find(t=>t.id===f.parent.taskId)!;task.params.materialExpedition=true;task.state='held';saved.goals[0]!.state='held';
  const next=new FleetController({checkpoint:saved,now:f.now,send(){}}).checkpoint(),restored=next.tasks.find(t=>t.id===task.id)!;
  assert.equal(restored.state,'interrupted');assert.equal(restored.checkpoint.resourceTripReconcileVersion,1);assert.deepEqual(restored.checkpoint.resourceTrip,checkpoint.resourceTrip);assert.deepEqual(restored.checkpoint.resourceRecovery,checkpoint.resourceRecovery);
  restored.state='held';restored.reason=task.reason;next.goals[0]!.state='held';assert.equal(new FleetController({checkpoint:next,now:f.now,send(){}}).checkpoint().tasks.find(t=>t.id===task.id)!.state,'held');
});
