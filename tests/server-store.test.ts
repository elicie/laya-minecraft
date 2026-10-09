import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore, IdempotencyConflict } from '../apps/server/src/store';
import { acquireInstanceLock } from '../apps/server/src/instance-lock';
import { WorkerSupervisor } from '../apps/server/src/supervisor';

test('idempotent commands preserve final application and reject changed input', () => {
  let time = 100;
  const store = new ControlStore(':memory:', () => time);
  try {
    assert.equal(store.acceptCommand('key', 'id', 'goal.create', { item: 'oak_log', quantity: 32 }).duplicate, false);
    time += 1;
    store.updateCommand('id', 'applied', { goalId: 'goal' });
    const repeated = store.acceptCommand('key', 'another-id', 'goal.create', { quantity: 32, item: 'oak_log' });
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.receipt.id, 'id');
    assert.equal(repeated.receipt.state, 'applied');
    assert.equal(store.updateCommand('id', 'applying')?.state, 'applied');
    assert.throws(() => store.acceptCommand('key', 'other', 'goal.create', { quantity: 33 }), IdempotencyConflict);
  } finally { store.close(); }
});

test('restart retains configuration and outstanding command while operational events expire after 30 days', () => {
  const directory = mkdtempSync(join(tmpdir(), 'laya-store-'));
  const path = join(directory, 'state.sqlite');
  const now = 40 * 86_400_000;
  const first = new ControlStore(path, () => now);
  first.saveCheckpoint({ goals: [{ id: 'goal', mode: 'maintain' }], agents: [] }, { id: 'old', time: 1, type: 'goal.created' });
  first.appendEvent({ id: 'fresh', time: now, type: 'task.complete' });
  first.acceptCommand('pending-key', 'pending', 'rules.update', { radius: 50 });
  first.close();
  const second = new ControlStore(path, () => now);
  try {
    assert.deepEqual(second.loadCheckpoint(), { goals: [{ id: 'goal', mode: 'maintain' }], agents: [] });
    assert.equal(second.prune(), 1);
    assert.deepEqual(second.listEvents().map(event => event.id), ['fresh']);
    assert.equal(second.pendingCommands()[0]?.id, 'pending');
  } finally { second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('exclusive instance lock prevents competing controllers and can be reacquired', () => {
  const directory = mkdtempSync(join(tmpdir(), 'laya-lock-'));
  const path = join(directory, 'controller.lock');
  const release = acquireInstanceLock(path);
  try { assert.throws(() => acquireInstanceLock(path), /이미 실행/); }
  finally { release(); }
  const releaseAgain = acquireInstanceLock(path);
  releaseAgain();
  releaseAgain();
  rmSync(directory, { recursive: true, force: true });
});

test('orphan reconciliation never signals a reused PID with a different worker session', async () => {
  const store = new ControlStore(':memory:');
  store.saveWorker({ botId: 'bot', sessionId: 'not-this-process', controllerEpoch: 'old', pid: process.pid, startedAt: 0 });
  const supervisor = new WorkerSupervisor({ workerPath: 'unused', store, onMessage() {}, onExit() {} });
  try {
    const stopped = await supervisor.reconcileOrphans();
    assert.equal(stopped.length, 1);
    assert.deepEqual(store.workers(), []);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { store.close(); }
});

test('supervisor fences duplicate processes and confirms shutdown from actual child exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'laya-worker-'));
  const workerPath = join(directory, 'probe.cjs');
  writeFileSync(workerPath, `
    process.send({type:'probe.ready',launch:JSON.parse(process.env.LAYA_WORKER_BOOTSTRAP)});
    process.on('message',message=>{if(message.type==='bot.shutdown')process.exit(0);});
  `);
  const store = new ControlStore(':memory:');
  let readyResolve!: (value: unknown) => void;
  let exitResolve!: () => void;
  const ready = new Promise<unknown>(resolve => { readyResolve = resolve; });
  const exited = new Promise<void>(resolve => { exitResolve = resolve; });
  const supervisor = new WorkerSupervisor({ workerPath, store, execArgv: [],
    onMessage(_botId, message) { readyResolve(message); },
    onExit() { exitResolve(); },
  });
  try {
    supervisor.spawn('bot', 'session', 'epoch', { config: { name: 'Probe' }, rules: { version: 1 } });
    const message = await ready as { launch: { botId: string; sessionId: string; config: { name: string } } };
    assert.equal(message.launch.sessionId, 'session');
    assert.equal(message.launch.config.name, 'Probe');
    assert.throws(() => supervisor.spawn('bot', 'other-session', 'epoch', { config: {}, rules: {} }), /이전 프로세스/);
    supervisor.send('bot', { type: 'bot.shutdown' });
    await exited;
    assert.equal(supervisor.has('bot'), false);
    assert.deepEqual(store.workers(), []);
  } finally { await supervisor.shutdownAll(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
