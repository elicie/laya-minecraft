import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Agent, CentralMessage, CommandReceipt, CoreEvent, FleetCheckpoint } from '../packages/contracts/src';
import { FleetController } from '../packages/core/src';
import { createControlServer } from '../apps/server/src/control-server';
import { ControlStore } from '../apps/server/src/store';

class SnapshotCountingCore extends FleetController {
  snapshotReads = 0;
  checkpointCopies = 0;
  schedulingPasses = 0;
  override tick() { this.schedulingPasses++; super.tick(); }
  override getSnapshot() { this.snapshotReads++; return super.getSnapshot(); }
  override checkpoint() { this.checkpointCopies++; return super.checkpoint(); }
}
class CountingStore extends ControlStore {
  checkpointWrites = 0;
  override saveSerializedCheckpoint(checkpoint: string, event?: Parameters<ControlStore['saveCheckpoint']>[1]) {
    this.checkpointWrites++; super.saveSerializedCheckpoint(checkpoint,event);
  }
}

test('event subscribers cannot alter controller history and do not request full snapshots', () => {
  const received: CoreEvent[] = [];
  const core = new SnapshotCountingCore({ send() {}, onEvent(event) { received.push(structuredClone(event)); event.message='external mutation'; } });
  core.addAgent({name:'EventOnly'});
  assert.equal(core.snapshotReads,0); assert.equal(received[0]!.type,'bot.registered');
  assert.equal(core.checkpoint().events[0]!.message,received[0]!.message);
  const agents=core.getAgents(); agents[0]!.config.name='external mutation';
  assert.equal(core.getAgents()[0]!.config.name,'EventOnly');
  const rules=core.getRules(); rules.radius=999;
  assert.notEqual(core.getRules().radius,999); assert.equal(core.snapshotReads,0);
});

test('recovery execution checkpoints and durable journal remain complete without duplicating them through snapshot history or restart',async()=>{
  const store=new ControlStore(':memory:');let api:ReturnType<typeof createControlServer>|undefined;
  const core=new FleetController({send(){},rules:{autonomyEnabled:false},onEvent(event){api?.observeEvent(event);}});
  api=createControlServer({core,store,port:0});await api.listen();
  try{
    const agent=core.addAgent({name:'RecoveryHistory'});core.startSession(agent.id,'recovery-history');const rules=core.getRules();
    const receive=(type:string,payload:unknown)=>core.receive({protocolVersion:1,messageId:randomUUID(),controllerEpoch:core.controllerEpoch,botId:agent.id,sessionId:'recovery-history',sentAt:Date.now(),type,payload});
    receive('bot.ready',{ready:true,world:rules.world,dimension:rules.dimension,health:20,food:20,inventory:[],action:'idle',reason:'actual body',mode:'idle',capabilities:['collect'],rulesVersion:rules.version});
    const checkpoint={protectedPositions:[{x:1,y:64,z:1}],resourceRecovery:{sand:{moves:160,elapsedMs:60000}}};
    receive('bot.recovery',{deathId:'saved-death',occurredAt:Date.now()-1000,world:rules.world,dimension:rules.dimension,priorInventory:[],phase:'held',reason:'preserved recovery',attemptCount:3,progress:{recoveredCount:0,remainingCount:0},safe:false,updatedAt:Date.now(),checkpoint});
    assert.deepEqual(core.getAgents()[0]!.recovery!.checkpoint,checkpoint);
    const saved=store.loadCheckpoint<FleetCheckpoint>()!,summary=saved.events.filter(e=>e.type==='bot.recovery').at(-1)!;
    assert.equal(summary.data!.checkpoint,undefined);assert.equal(summary.data!.deathId,'saved-death');
    const journal=store.listEvents(100).filter(e=>e.type==='bot.recovery').at(-1)!;
    assert.deepEqual((journal.data as Record<string,unknown>).checkpoint,checkpoint,'the durable operational event retains its full original evidence');
    summary.data!.checkpoint=checkpoint;const restored=new FleetController({checkpoint:saved,send(){}}).checkpoint();
    assert.equal(restored.events.filter(e=>e.type==='bot.recovery').at(-1)!.data!.checkpoint,undefined,'legacy history is compacted on restoration');
    assert.deepEqual(restored.agents[0]!.recovery!.checkpoint,checkpoint);
  }finally{await api.close();store.close();}
});

test('status and world report bursts coalesce checkpoint writes without snapshot readers, while critical events persist immediately', async () => {
  const store = new CountingStore(':memory:');
  let api: ReturnType<typeof createControlServer> | undefined;
  const core = new SnapshotCountingCore({send(){},deferReportScheduling:true,rules:{autonomyEnabled:false},onEvent(event){api?.observeEvent(event);}});
  api=createControlServer({core,store,port:0});
  const address=await api.listen();
  const agent=core.addAgent({name:'BurstReports'}); core.startSession(agent.id,'burst-session');
  assert.equal(core.checkpointCopies, 0, 'durable writes serialize directly without copying full retained history');
  const rules=core.getRules();
  const report={ready:true,world:rules.world,dimension:rules.dimension,position:{x:.5,y:64,z:.5},health:20,food:20,inventory:[],action:'idle',reason:'fresh',mode:'idle',capabilities:['build'],rulesVersion:rules.version};
  const receive=(type:string,payload:unknown)=>core.receive({protocolVersion:1,messageId:randomUUID(),controllerEpoch:core.controllerEpoch,botId:agent.id,sessionId:'burst-session',sentAt:Date.now(),type,payload});
  receive('bot.ready',report); receive('rules.applied',{version:rules.version});
  try {
    const before=store.checkpointWrites;
    const schedulingBefore=core.schedulingPasses;
    for(let i=0;i<40;i++) {
      receive('bot.status',{...report,position:{x:i+.5,y:64,z:.5}});
      receive('world.observed',{observations:[{id:randomUUID(),kind:'blocks',world:rules.world,dimension:rules.dimension,observedAt:Date.now(),data:{blocks:[{position:{x:i,y:63,z:0},name:'grass_block'}]}}]});
    }
    assert.equal(store.checkpointWrites,before,'high-frequency reports must not synchronously rewrite the entire history');
    assert.equal(core.schedulingPasses,schedulingBefore,'report bursts update state without repeatedly planning the whole fleet');
    assert.equal(core.getAgents()[0]!.session!.report!.position!.x,39.5,'latest heartbeat facts are applied before scheduling');
    core.tick();
    assert.equal(core.schedulingPasses,schedulingBefore+1,'the periodic server tick runs one scheduling pass');
    assert.equal(core.snapshotReads,0);
    assert.ok(store.listEvents(100).some(event=>event.type==='world.observed'),'individual world events remain recorded');
    const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/health`);
    assert.equal(response.status,200); await response.json(); assert.equal(core.snapshotReads,0);
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal(store.checkpointWrites,before+1); assert.equal(core.snapshotReads,0);
    assert.equal(store.loadCheckpoint<FleetCheckpoint>()!.agents[0]!.session!.report!.position!.x,39.5);
    assert.ok(store.loadCheckpoint<FleetCheckpoint>()!.observations.length>=40);
    receive('bot.status',{...report,position:{x:77.5,y:64,z:.5}});
    core.addAgent({name:'CriticalPersist',enabled:false});
    assert.equal(store.checkpointWrites,before+2);
    assert.equal(store.loadCheckpoint<FleetCheckpoint>()!.agents[0]!.session!.report!.position!.x,77.5,'critical writes include preceding transient state');
    receive('bot.status',{...report,position:{x:88.5,y:64,z:.5}});
  } finally { await api.close(); }
  assert.equal(store.loadCheckpoint<FleetCheckpoint>()!.agents[0]!.session!.report!.position!.x,88.5,'shutdown flushes the latest pending report');
  store.close();
});

test('deferred report scheduling keeps live resource spend and handles a death immediately', () => {
  let now=100000;
  const sent:CentralMessage[]=[];
  const core=new SnapshotCountingCore({now:()=>now,send:(_bot,message)=>sent.push(message),deferReportScheduling:true,rules:{autonomyEnabled:false}});
  const agent=core.addAgent({name:'ReportSpend',role:'gatherer'});core.startSession(agent.id,'spend-session');const rules=core.getRules();
  const receive=(type:string,payload:unknown,extra={})=>core.receive({protocolVersion:1,messageId:randomUUID(),controllerEpoch:core.controllerEpoch,botId:agent.id,sessionId:'spend-session',sentAt:now,type,payload,...extra});
  const report={ready:true,world:rules.world,dimension:rules.dimension,position:{x:.5,y:64,z:.5},health:20,food:20,inventory:[],action:'collect',reason:'actual search',mode:'working',capabilities:['collect','explore'],rulesVersion:rules.version};
  assert.equal(receive('bot.ready',{...report,mode:'idle'}),true);assert.equal(receive('rules.applied',{version:rules.version}),true);
  core.createGoal({kind:'collect',item:'sand',quantity:6,completionLocation:'inventory',requiredBotId:agent.id});
  const assignment=sent.find((message):message is Extract<CentralMessage,{type:'task.assign'}>=>message.type==='task.assign');assert.ok(assignment);
  const extra={taskId:assignment.taskId,attemptId:assignment.attemptId};
  receive('task.accepted',{},extra);receive('task.started',{},extra);
  const before=core.schedulingPasses;
  for(let i=0;i<40;i++){
    now++;
    assert.equal(receive('task.progress',{action:'수집',reason:'same resource search',checkpoint:{resourceRecovery:{sand:{destinationsUsed:5,approachesUsed:8,elapsedMs:59000+i}}},observations:[]},extra),true);
    assert.equal(receive('bot.status',report),true);
  }
  assert.equal(core.schedulingPasses,before);
  assert.equal(core.getAgents()[0]!.session!.lastReportAt,now);
  assert.deepEqual(core.checkpoint().tasks.find(task=>task.id===assignment.taskId)!.checkpoint.resourceRecovery,{sand:{destinationsUsed:5,approachesUsed:8,elapsedMs:59039}});
  assert.equal(receive('bot.died',{deathId:'actual-death',occurredAt:now,world:rules.world,dimension:rules.dimension,position:report.position,priorInventory:[]}),true);
  assert.equal(core.schedulingPasses,before+1,'death handling bypasses report scheduling deferral');
  assert.equal(core.getAgents()[0]!.recovery!.deathId,'actual-death');
  assert.ok(sent.some(message=>message.type==='task.cancel'&&message.attemptId===assignment.attemptId));
  assert.deepEqual(core.checkpoint().tasks.find(task=>task.id===assignment.taskId)!.checkpoint.resourceRecovery,{sand:{destinationsUsed:5,approachesUsed:8,elapsedMs:59039}});
});

function headers(key: string = randomUUID()) { return { 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': key }; }

test('real core integration starts an enabled or resumed worker once and preserves paused registrations', async () => {
  const store = new ControlStore(':memory:');
  let api: ReturnType<typeof createControlServer> | undefined;
  const started: string[] = [];
  const core = new FleetController({ send() {}, onChange(snapshot, event) { api?.observe(snapshot, event); } });
  api = createControlServer({ core, store, port: 0, startBot(agent: Agent) {
    started.push(agent.id); core.startSession(agent.id, randomUUID());
  } });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const add = await fetch(`${base}/api/v1/bots`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'PausedBot', enabled: false }) });
    assert.equal((await add.json() as CommandReceipt).state, 'applied');
    assert.deepEqual(started, []);
    const paused = core.getSnapshot().agents[0]!;
    assert.equal(paused.status, 'paused');
    const resume = await fetch(`${base}/api/v1/bots/${paused.id}/resume`, { method: 'POST', headers: headers('resume'), body: '{}' });
    assert.equal(resume.status, 202);
    assert.deepEqual(started, [paused.id]);
    assert.equal(core.getSnapshot().agents[0]!.session?.state, 'starting');
    const duplicate = await fetch(`${base}/api/v1/bots/${paused.id}/resume`, { method: 'POST', headers: headers('resume'), body: '{}' });
    assert.equal(duplicate.status, 202); assert.equal(started.length, 1);
    const another = core.addAgent({ name: 'EnabledLater', enabled: false });
    const enable = await fetch(`${base}/api/v1/bots/${another.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ patch: { enabled: true } }) });
    assert.equal(enable.status, 202);
    assert.deepEqual(started, [paused.id, another.id]);
  } finally { await api.close(); store.close(); }
});

test('real core acknowledgements fence stale rules and removal waits for actual process exit', async () => {
  const store = new ControlStore(':memory:');
  let api: ReturnType<typeof createControlServer> | undefined;
  const messages: CentralMessage[] = [];
  const core = new FleetController({ controllerEpoch: 'test-epoch', send(_id, message) { messages.push(message); }, onChange(snapshot, event) { api?.observe(snapshot, event); } });
  api = createControlServer({ core, store, port: 0 });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const agent = core.addAgent({ name: 'AckBot' });
  core.startSession(agent.id, 'session');
  const envelope = (type: string, payload: unknown) => ({ protocolVersion: 1, messageId: randomUUID(), botId: agent.id, sessionId: 'session', controllerEpoch: 'test-epoch', sentAt: Date.now(), type, payload });
  const rules = core.getSnapshot().rules;
  core.onWorkerMessage(envelope('bot.ready', { ready: true, world: rules.world, dimension: rules.dimension, health: 20, food: 20, inventory: [], action: 'idle', reason: 'test', mode: 'idle', capabilities: ['collect'], rulesVersion: 0 }));
  core.onWorkerMessage(envelope('rules.applied', { version: rules.version }));
  try {
    const update = await fetch(`${base}/api/v1/rules`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ patch: { radius: 90 } }) });
    const pending = await update.json() as CommandReceipt;
    assert.equal(pending.state, 'applying');
    assert.ok(messages.some(message => message.type === 'rules.update' && message.payload.rules.radius === 90));
    core.onWorkerMessage(envelope('rules.applied', { version: rules.version }));
    assert.equal(store.getCommand(pending.id)?.state, 'applying');
    core.onWorkerMessage(envelope('rules.applied', { version: core.getSnapshot().rules.version }));
    assert.equal(store.getCommand(pending.id)?.state, 'applied');
    const removal = await fetch(`${base}/api/v1/bots/${agent.id}/remove`, { method: 'POST', headers: headers(), body: '{}' });
    const receipt = await removal.json() as CommandReceipt;
    assert.equal(receipt.state, 'applying');
    assert.equal(core.getSnapshot().agents[0]?.status, 'removing');
    assert.ok(messages.some(message => message.type === 'bot.shutdown'));
    core.onWorkerMessage(envelope('bot.stopped', { reason: 'Minecraft connection closed' }));
    assert.equal(store.getCommand(receipt.id)?.state, 'applying');
    core.confirmWorkerStopped(agent.id, 'session');
    assert.equal(store.getCommand(receipt.id)?.state, 'applied');
    assert.equal(core.getSnapshot().agents[0]?.status, 'removed');
  } finally { await api.close(); store.close(); }
});
