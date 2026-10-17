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

test('a changed fixed foundation schedules one read-only survey at the same coordinates before any terrain preparation', () => {
  const f = fixture(), { goal, assignment } = f.build({ siteSelection: 'fixed' });
  f.result(assignment, { outcome: 'condition-wait', reason: 'foundation hole', checkpoint: { waitingFor: { kind: 'blocks', causeCode: 'BUILD_SITE', positions: [{ x: 4, y: 63, z: 4 }] } } });
  const survey = f.latest(); assert.equal(survey.payload.task.kind, 'explore');
  assert.deepEqual(survey.payload.task.params.fixedOrigin, origin);
  assert.equal(survey.payload.task.params.parentTaskId, assignment.taskId);
  assert.deepEqual(survey.payload.task.params.protectedPositions, [], 'its own deferred warehouse registration is not an unrelated facility');
  const parent = f.core.getSnapshot().tasks.find(t => t.id === assignment.taskId)!;
  assert.ok(parent.dependencies.includes(survey.taskId)); assert.equal(parent.retryCount, 0);
  for (let i = 0; i < 5; i++) { f.advance(6000); f.core.tick(); }
  assert.equal(f.core.getSnapshot().tasks.filter(t => t.params.fixedOrigin).length, 1);
  assert.deepEqual(f.core.getSnapshot().goals.find(g => g.id === goal.id)!.input.params.origin, origin);
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('fixed-site revalidation preserves partial construction and explicitly disabled terrain preparation', () => {
  for (const params of [{ allowPreparation: false }, {}]) {
    const f = fixture(), { assignment } = f.build({ siteSelection: 'fixed', ...params });
    f.result(assignment, { outcome: 'condition-wait', checkpoint: { ...('allowPreparation' in params ? {} : { build: { placed: 7 } }), waitingFor: { kind: 'blocks', causeCode: 'BUILD_SITE', positions: [{ x: 4, y: 63, z: 4 }] } } });
    assert.equal(f.assignments().length, 1); assert.equal(f.core.getSnapshot().tasks.some(t => t.params.fixedOrigin), false);
  }
});

test('a named building expands spent material search once without resetting its checkpoint or construction progress',()=>{
  const f=fixture(), {assignment}=f.build();
  const checkpoint={build:{placed:7},resourceRecovery:{sand:{origin:{x:0,y:64,z:0},visited:[],destinationsUsed:5,elapsedMs:60000,status:'exhausted'}},waitingFor:{kind:'inventory',causeCode:'BUILD_MATERIAL',item:'glass_pane',minimum:3,resourceNames:['sand'],watchPosition:false}};
  f.result(assignment,{outcome:'condition-wait',checkpoint,reason:'spent actual local sand search'});
  const resumed=f.latest();assert.equal(f.assignments().length,2);assert.equal(resumed.taskId,assignment.taskId);
  assert.equal(resumed.payload.task.params.materialExpedition,true);assert.deepEqual(resumed.payload.checkpoint.resourceRecovery,checkpoint.resourceRecovery);
  assert.deepEqual(resumed.payload.checkpoint.build,{placed:7});
  f.result(resumed,{outcome:'condition-wait',checkpoint:{...resumed.payload.checkpoint,waitingFor:checkpoint.waitingFor},reason:'genuinely blocked route'});
  for(let i=0;i<5;i++){f.advance(6000);f.ready();f.core.tick();}
  assert.equal(f.assignments().length,2,'the same wait is not expanded again on a clock');
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('a blocked read-only fixed survey does not pin its idle bot away from an independent collection goal', () => {
  const f = fixture(), { assignment } = f.build({ siteSelection: 'fixed' });
  f.result(assignment, { outcome: 'condition-wait', checkpoint: { waitingFor: { kind: 'blocks', causeCode: 'BUILD_SITE', positions: [{ x: 4, y: 63, z: 4 }] } } });
  const survey = f.latest(); f.result(survey, { outcome: 'condition-wait', reason: 'deep fixed foundation', checkpoint: { waitingFor: { kind: 'blocks', causeCode: 'BUILD_SITE', positions: [{ x: 5, y: 63, z: 5 }] } } });
  const collect = f.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 32, preferredBotId: 'bot-0' });
  assert.equal(f.latest().payload.task.kind, 'collect'); assert.equal(f.latest().payload.task.goalId, collect.id);
  assert.ok(f.core.getSnapshot().tasks.some(t => t.id === survey.taskId && t.state === 'condition-wait'));
});

test('a restored builder waiting for material releases its idle bot for independent wood collection', () => {
  const f = fixture(), { assignment } = f.build();
  f.result(assignment, { outcome: 'condition-wait', reason: 'observed sand path blocked', checkpoint: { build: { placed: 7 }, waitingFor: { kind: 'inventory', causeCode: 'BUILD_MATERIAL', item: 'glass_pane', minimum: 3, resourceNames: ['sand'], watchPosition: false } } });
  const saved = f.core.checkpoint(), parent = saved.tasks.find(t => t.id === assignment.taskId)!;
  parent.affinityBotId = 'bot-0';
  const restored = fixture(0,null,saved); restored.core.confirmWorkerStopped('bot-0','session-0'); restored.core.startSession('bot-0','restored-session'); restored.ready();
  restored.result(restored.latest(), { outcome: 'condition-wait', reason: 'material path still actually blocked in the new session', checkpoint: parent.checkpoint });
  const collect = restored.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 32, preferredBotId: 'bot-0' });
  assert.equal(restored.latest().payload.task.kind,'collect'); assert.equal(restored.latest().payload.task.goalId,collect.id);
  const waiting = restored.core.getSnapshot().tasks.find(t => t.id === assignment.taskId)!;
  assert.equal(waiting.state,'condition-wait'); assert.deepEqual(waiting.checkpoint.build,{placed:7}); assert.equal(waiting.affinityBotId,'bot-0');
  FleetCheckpointSchema.parse(restored.core.checkpoint());
});

test('an immediate collection suspends pending building affinity and resumes preserved construction afterwards', () => {
  const f = fixture(), { assignment } = f.build();
  f.result(assignment,{outcome:'condition-wait',checkpoint:{build:{placed:7},waitingFor:{kind:'inventory',causeCode:'BUILD_MATERIAL',item:'glass_pane',minimum:3,watchPosition:false}}});
  const saved = f.core.checkpoint(); for (const task of saved.tasks) task.affinityBotId='bot-0';
  const restored=fixture(0,null,saved);restored.core.confirmWorkerStopped('bot-0','session-0');restored.core.startSession('bot-0','immediate-session');restored.ready();
  const active=restored.latest(), urgent=restored.core.createGoal({kind:'collect',item:'oak_log',quantity:2,preferredBotId:'bot-0',executionMode:'immediate'});
  restored.receive('bot-0','task.cancelled',{safeStopped:true,checkpoint:{...active.payload.checkpoint,build:{placed:7}},observations:[]},active);
  const collecting=restored.latest();assert.equal(collecting.payload.task.goalId,urgent.id);assert.equal(collecting.payload.task.kind,'collect');
  restored.receive('bot-0','bot.status',{ready:true,world,dimension,position:{x:0.5,y:64,z:0.5},health:20,food:20,inventory:[{name:'oak_log',count:2}],action:'실제 원목 확보',reason:'관측',mode:'working',capabilities:['build','collect','explore','craft','store'],rulesVersion:restored.core.getSnapshot().rules.version});
  restored.result(collecting,{outcome:'completed',observations:[restored.obs('inventory',{items:[{name:'oak_log',count:2}]})]});
  assert.equal(restored.core.getSnapshot().goals.find(g=>g.id===urgent.id)!.state,'completed');
  const resumed=restored.latest();assert.equal(resumed.taskId,assignment.taskId);assert.deepEqual(resumed.payload.checkpoint.build,{placed:7});
});


test('nested immediate tool preparation resumes material collection before its preserved building parent',()=>{
  const f=fixture(),{assignment:building}=f.build();
  f.result(building,{outcome:'condition-wait',checkpoint:{build:{placed:36},waitingFor:{kind:'inventory',causeCode:'BUILD_MATERIAL',item:'oak_planks',minimum:8}}});
  const saved=f.core.checkpoint();for(const t of saved.tasks)t.affinityBotId='bot-0';
  const r=fixture(0,null,saved);r.core.confirmWorkerStopped('bot-0','session-0');r.core.startSession('bot-0','nested-session');r.ready();
  const active=r.latest(),wood=r.core.createGoal({kind:'collect',item:'oak_log',quantity:40,priority:95,preferredBotId:'bot-0',executionMode:'immediate'});
  r.receive('bot-0','task.cancelled',{safeStopped:true,checkpoint:{build:{placed:36}},observations:[]},active);
  const collecting=r.latest();assert.equal(collecting.payload.task.goalId,wood.id);
  const tool=r.core.createGoal({kind:'craft',item:'wooden_axe',quantity:1,priority:96,preferredBotId:'bot-0',executionMode:'immediate'});
  assert.equal(r.core.getSnapshot().tasks.find(t=>t.id===building.taskId)!.blockedByGoalId,wood.id);
  r.receive('bot-0','task.cancelled',{safeStopped:true,checkpoint:{woodProgress:8},observations:[]},collecting);
  const crafting=r.latest();assert.equal(crafting.payload.task.goalId,tool.id);
  r.result(crafting,{outcome:'completed',observations:[r.obs('inventory',{items:[{name:'wooden_axe',count:1}]})]});
  const resumed=r.latest();assert.equal(resumed.taskId,collecting.taskId);assert.equal(resumed.payload.checkpoint.woodProgress,8);
  r.result(resumed,{outcome:'completed',observations:[r.obs('inventory',{items:[{name:'oak_log',count:40},{name:'wooden_axe',count:1}]})]});
  assert.equal(r.latest().taskId,building.taskId);assert.deepEqual(r.latest().payload.checkpoint.build,{placed:36});
});

test('an unstarted automatically selected warehouse relocates only after the same fixed plot is actually rejected', () => {
  const f = fixture(), goal = f.core.createGoal({ kind: 'build', params: { design: 'warehouse' }, preferredBotId: 'bot-0' });
  const firstSurvey = f.latest(), entrance = { x: 8, y: 64, z: 4 };
  f.result(firstSurvey, { outcome: 'completed', checkpoint: { buildSite: { design: 'warehouse', origin, entrance, observedAt: f.now() } }, observations: [f.obs('blocks', { blocks: buildSiteCells(origin,7,5,4).map(cell => ({ position:cell.position,name:cell.requirement==='air'?'air':'grass_block' })) }), f.obs('exploration', { position:{ ...entrance,x:8.5,z:4.5 }, resources:[] })] });
  const build = f.latest(); assert.equal(build.payload.task.kind,'build');
  f.result(build, { outcome:'condition-wait',checkpoint:{waitingFor:{kind:'blocks',causeCode:'BUILD_SITE',positions:[{x:5,y:63,z:5}]}} });
  const recheck = f.latest(); assert.deepEqual(recheck.payload.task.params.fixedOrigin,origin);
  f.result(recheck, { outcome:'condition-wait',reason:'observed deep gap',checkpoint:{waitingFor:{kind:'blocks',causeCode:'BUILD_SITE',positions:[{x:5,y:63,z:5}]}} });
  const nearby = f.latest(), current = f.core.getSnapshot().goals.find(g=>g.id===goal.id)!;
  assert.equal(nearby.payload.task.kind,'explore'); assert.equal(nearby.payload.task.params.fixedOrigin,undefined);
  assert.equal(nearby.payload.task.goalId,goal.id); assert.equal(current.input.params.design,'warehouse');
  assert.equal(current.input.params.siteSelection,'nearby'); assert.equal(current.input.params.origin,undefined);
  assert.deepEqual((current.input.params.siteRelocations as {origin:Position}[])[0]!.origin,origin);
  FleetCheckpointSchema.parse(f.core.checkpoint());
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

test('completed registered buildings without a warehouse keep their floor protected after log retention expires',()=>{
 const f=fixture(),preset=blueprintPreset('warehouse'),definition=f.core.createBlueprint({...preset,title:'보존할 작업실',furniture:{...preset.furniture,chest:false}});
 const goal=f.core.createGoal({kind:'build',params:{blueprint:definition.id,origin}}),build=f.latest();
 f.result(build,{outcome:'completed',observations:[f.obs('blocks',{blocks:blueprint(definition.id,origin,definition.wood,definition)})]});
 assert.equal(f.core.getSnapshot().goals.find(g=>g.id===goal.id)?.state,'completed');assert.equal(f.core.getSnapshot().rules.warehouse,null);
 f.advance(31*86400000);f.ready();f.core.tick();assert.equal(f.core.getSnapshot().goals.find(g=>g.id===goal.id)?.state,'completed');
 f.core.createGoal({kind:'collect',item:'cobblestone',quantity:1,completionLocation:'inventory'});const collect=f.latest();assert.equal(collect.payload.task.kind,'collect');
 assert.ok((collect.payload.task.params.protectedPositions as Position[]).some(p=>p.x===origin.x&&p.y===origin.y&&p.z===origin.z));FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('explicit exterior soil support can repair a completed site buffer while excavation and foundation columns stay protected',()=>{
 const f=fixture();f.core.createGoal({kind:'build',params:{design:'warehouse'}});const survey=f.latest(),cells=buildSiteCells(origin,7,5,4),entrance={x:8,y:64,z:4};
 f.result(survey,{outcome:'completed',checkpoint:{buildSite:{design:'warehouse',origin,entrance,observedAt:f.now()}},observations:[f.obs('blocks',{blocks:cells.map(cell=>({position:cell.position,name:cell.requirement==='air'?'air':'grass_block'}))}),f.obs('exploration',{position:{x:8.5,y:64,z:4.5},resources:[]})]});
 const registration=f.built(f.latest());f.result(registration,f.registration(registration));f.ready();
 const exterior={x:8,y:63,z:4},interior={x:8,y:63,z:5},excavation={x:7,y:63,z:4};
 f.core.createGoal({kind:'build',params:{mode:'material-access',access:{edits:[{stand:entrance,position:exterior,before:'air',after:'dirt'},{stand:entrance,position:interior,before:'air',after:'dirt'},{stand:entrance,position:excavation,before:'dirt',after:'air'}],exit:entrance}}});
 const task=f.latest().payload.task;assert.equal(task.params.mode,'material-access');const protectedCells=task.params.protectedPositions as Position[],has=(p:Position)=>protectedCells.some(q=>q.x===p.x&&q.y===p.y&&q.z===p.z);
 assert.equal(has(exterior),false);assert.equal(has(interior),true);assert.equal(has(excavation),true);assert.ok(protectedCells.some(p=>p.x===origin.x&&p.y===origin.y&&p.z===origin.z));
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

test('cancelling a completed one-shot warehouse is an applied no-op that preserves evidence and later collection protection', () => {
  const f = fixture(), { goal, assignment: build } = f.build(), check = f.built(build); f.result(check, f.registration(check)); f.ready();
  const before = f.core.getSnapshot(), completed = before.goals.find(value => value.id === goal.id)!;
  const response = f.core.cancelGoal(goal.id, 'cancel-completed');
  const after = f.core.getSnapshot();
  assert.deepEqual(response, completed); assert.deepEqual(after.goals.find(value => value.id === goal.id), completed);
  assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.attempts, before.attempts); assert.deepEqual(after.rules, before.rules);
  assert.ok(after.events.some(event => event.type === 'command.applied' && event.commandId === 'cancel-completed'));
  f.receive('bot-0', 'world.observed', { observations: [f.obs('container', { container: after.rules.warehouse!, items: [] })] });
  f.core.createGoal({ kind: 'collect', item: 'cobblestone', quantity: 1 });
  const collect = f.latest(); assert.equal(collect.payload.task.kind, 'collect');
  assert.ok((collect.payload.task.params.protectedPositions as Position[]).some(position => position.x === origin.x && position.y === origin.y && position.z === origin.z));
  FleetCheckpointSchema.parse(f.core.checkpoint());
});

test('cancelling an executing maintain goal still waits for safe cancellation and then becomes cancelled', () => {
  const f = fixture(), goal = f.core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 32, mode: 'maintain' }), assignment = f.latest();
  f.core.cancelGoal(goal.id, 'cancel-maintain');
  assert.equal(f.core.getSnapshot().goals.find(value => value.id === goal.id)!.state, 'cancelling');
  assert.ok(f.sent.some(message => message.type === 'task.cancel' && message.attemptId === assignment.attemptId));
  assert.equal(f.core.getSnapshot().events.some(event => event.type === 'command.applied' && event.commandId === 'cancel-maintain'), false);
  f.receive(assignment.botId, 'task.cancelled', { safeStopped: true, checkpoint: {}, observations: [], evidence: [] }, assignment);
  const after = f.core.getSnapshot(); assert.equal(after.goals.find(value => value.id === goal.id)!.state, 'cancelled');
  assert.ok(after.events.some(event => event.type === 'command.applied' && event.commandId === 'cancel-maintain'));
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
