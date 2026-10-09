import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { startRuntime } from '../apps/server/src/main';
import { ControlStore } from '../apps/server/src/store';
import { acquireInstanceLock, isAlive } from '../apps/server/src/instance-lock';
import { FleetController } from '../packages/core/src';
import { DEFAULT_RULES, type CentralMessage, type FleetCheckpoint } from '../packages/contracts/src';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'laya-runtime-test-'));
  const workerPath = join(dir, 'fake-worker.cjs');
  writeFileSync(workerPath, `
    const { randomUUID } = require('node:crypto');
    const boot = JSON.parse(process.env.LAYA_WORKER_BOOTSTRAP);
    let version = boot.rules.version, enabled = boot.config.enabled, position = { x: 0, y: 64, z: 0 };
    const send = (type, payload, extra = {}) => process.connected && process.send({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: boot.controllerEpoch, botId: boot.botId, sessionId: boot.sessionId, sentAt: Date.now(), type, payload, ...extra });
    const report = () => ({ ready: true, world: boot.rules.world, dimension: boot.rules.dimension, health: 20, food: 20, inventory: [], position, mode: enabled ? 'idle' : 'paused', action: 'idle', reason: 'fake worker ready', capabilities: ['home'], rulesVersion: version });
    process.on('message', message => {
      if (message.controllerEpoch !== boot.controllerEpoch || message.sessionId !== boot.sessionId) return;
      if (message.type === 'rules.update') { version = message.payload.rules.version; enabled = message.payload.config.enabled; send('rules.applied', { version }); }
      if (message.type === 'task.assign') {
        const refs = { taskId: message.taskId, attemptId: message.attemptId };
        send('task.accepted', {}, refs); send('task.started', {}, refs);
        position = message.payload.task.completion.position;
        setTimeout(() => send('task.result', { outcome: 'completed', observations: [{ id: randomUUID(), observedAt: Date.now(), world: boot.rules.world, dimension: boot.rules.dimension, kind: 'position', data: { position } }], evidence: [], checkpoint: {} }, refs), 20);
      }
      if (message.type === 'task.cancel') send('task.cancelled', { safeStopped: true, observations: [], evidence: [], checkpoint: {} }, { taskId: message.taskId, attemptId: message.attemptId });
      if (message.type === 'bot.shutdown') { send('bot.stopped', { reason: 'requested' }); setTimeout(() => process.exit(0), 10); }
    });
    process.on('SIGTERM', () => process.exit(0));
    process.on('disconnect', () => process.exit(0));
    send('bot.ready', report());
    setInterval(() => send('bot.status', report()), 100);
  `);
  return { dir, workerPath, options: { runtimeDir: dir, host: '127.0.0.1', port: 0, workerPath, workerExecArgv: [] as string[], reconnectDelayMs: 30, tickIntervalMs: 20 }, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
async function until(predicate: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), message);
}
function saveCheckpoint(dir: string, checkpoint: FleetCheckpoint | unknown): void {
  const store = new ControlStore(join(dir, 'control.sqlite')); store.saveCheckpoint(checkpoint); store.close();
}
async function post(runtime: Awaited<ReturnType<typeof startRuntime>>, path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${runtime.address.port}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-laya-control': '1' }, body: JSON.stringify(body) });
  assert.equal(response.status, 202); return response.json() as Promise<{ id: string; state: string; result?: { botId?: string } }>;
}

test('runtime validation errors and HTTP listen failures release the instance lock', async () => {
  const f = setup();
  try {
    saveCheckpoint(f.dir, { schemaVersion: 999 });
    await assert.rejects(startRuntime(f.options));
    const unlock = acquireInstanceLock(join(f.dir, 'controller.lock.sqlite')); unlock();
    const seed = new FleetController({ send: () => {}, rules: { autonomyEnabled: false } }); saveCheckpoint(f.dir, seed.checkpoint());
    await assert.rejects(startRuntime({ ...f.options, port: -1 }));
    const runtime = await startRuntime(f.options); await runtime.close();
    const unlockAgain = acquireInstanceLock(join(f.dir, 'controller.lock.sqlite')); unlockAgain();
  } finally { f.remove(); }
});

test('runtime owns one controller, launches fake workers, reconnects after real exit and closes idempotently', async () => {
  const f = setup(); let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime(f.options);
    await assert.rejects(startRuntime(f.options), /이미 실행 중/);
    const receipt = await post(runtime, '/bots', { id: 'runtime-worker', name: 'Runtime01' }); assert.equal(receipt.state, 'applied');
    await until(() => runtime!.core.getSnapshot().agents[0].session?.state === 'ready', 'fake worker must actually report ready');
    assert.equal(runtime.supervisor.records().length, 1);
    const first = runtime.supervisor.records()[0]; process.kill(first.pid, 'SIGKILL');
    await until(() => runtime!.supervisor.records().some(worker => worker.sessionId !== first.sessionId), 'new session must be spawned only after actual process exit');
    assert.equal(runtime.supervisor.records().length, 1); assert.equal(isAlive(first.pid), false);
    const second = runtime.supervisor.records()[0]; const a = runtime.close(), b = runtime.close(); assert.equal(a, b); await a;
    assert.equal(isAlive(second.pid), false); assert.deepEqual(runtime.supervisor.records(), []);
    const stored = new ControlStore(join(f.dir, 'control.sqlite')); assert.deepEqual(stored.workers(), []); stored.close();
    const unlock = acquireInstanceLock(join(f.dir, 'controller.lock.sqlite')); unlock();
  } finally { await runtime?.close(); f.remove(); }
});

test('restoration preserves paused bots and resumes confirmed remaining work through fresh IPC observations', async () => {
  const f = setup(); let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    const sent: CentralMessage[] = []; const seed = new FleetController({ controllerEpoch: 'old-runtime', send: (_id, message) => sent.push(message), rules: { autonomyEnabled: false } });
    seed.addAgent({ id: 'active-bot', name: 'Runtime01' }); seed.startSession('active-bot', 'already-dead-session');
    const emit = (type: string, payload: unknown) => seed.onWorkerMessage({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: 'old-runtime', botId: 'active-bot', sessionId: 'already-dead-session', sentAt: Date.now(), type, payload });
    emit('bot.ready', { ready: true, world: DEFAULT_RULES.world, dimension: DEFAULT_RULES.dimension, health: 20, food: 20, inventory: [], mode: 'idle', action: 'idle', reason: 'seed', capabilities: ['home'], rulesVersion: 1 }); emit('rules.applied', { version: 1 });
    const goal = seed.createGoal({ kind: 'home', params: { position: { x: 11, y: 64, z: 0 } } }); assert.ok(sent.some(m => m.type === 'task.assign'));
    seed.addAgent({ id: 'paused-bot', name: 'Paused01', enabled: false }); saveCheckpoint(f.dir, seed.checkpoint());
    runtime = await startRuntime(f.options);
    await until(() => runtime!.core.getSnapshot().goals.find(g => g.id === goal.id)?.state === 'completed', 'fresh fake worker observations must verify resumed goal');
    assert.notEqual(runtime.core.controllerEpoch, 'old-runtime'); assert.equal(runtime.supervisor.records().length, 1);
    assert.equal(runtime.core.getSnapshot().agents.find(a => a.id === 'paused-bot')?.status, 'paused');
    assert.equal(runtime.core.getSnapshot().agents.find(a => a.id === 'paused-bot')?.session, undefined);
    const attempts = runtime.core.getSnapshot().attempts.filter(a => a.taskId !== undefined); assert.ok(attempts.some(a => a.controllerEpoch === runtime!.core.controllerEpoch));
  } finally { await runtime?.close(); f.remove(); }
});

test('missing worker registry records are recovered by exact session identity before replacement', async () => {
  const f = setup(); let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined; let orphan: ChildProcess | undefined;
  try {
    const seed = new FleetController({ controllerEpoch: 'orphan-epoch', send: () => {}, rules: { autonomyEnabled: false } }); const agent = seed.addAgent({ id: 'orphan-bot', name: 'Orphan01' });
    const sessionId = randomUUID(); seed.startSession(agent.id, sessionId); saveCheckpoint(f.dir, seed.checkpoint());
    orphan = fork(f.workerPath, [], { execArgv: [], env: { ...process.env, LAYA_WORKER_SESSION: sessionId, LAYA_WORKER_BOOTSTRAP: JSON.stringify({ botId: agent.id, sessionId, controllerEpoch: seed.controllerEpoch, config: agent.config, rules: seed.getSnapshot().rules }) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(orphan, 'exit'); await once(orphan, 'message'); const oldPid = orphan.pid!;
    runtime = await startRuntime(f.options); await exited;
    assert.equal(isAlive(oldPid), false);
    await until(() => runtime!.supervisor.records().length === 1 && runtime!.core.getSnapshot().agents[0].session?.state === 'ready', 'replacement may connect after owned orphan exit');
    assert.notEqual(runtime.supervisor.records()[0].sessionId, sessionId); assert.notEqual(runtime.supervisor.records()[0].pid, oldPid);
  } finally { if (orphan?.pid && isAlive(orphan.pid)) orphan.kill('SIGKILL'); await runtime?.close(); f.remove(); }
});

test('a reused worker PID never signals an unrelated process', async () => {
  const f = setup(); let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    const seed = new FleetController({ controllerEpoch: 'old-runtime', send: () => {}, rules: { autonomyEnabled: false } }); seed.addAgent({ id: 'paused-bot', name: 'Paused01', enabled: false }); seed.startSession('paused-bot', 'not-this-process');
    const store = new ControlStore(join(f.dir, 'control.sqlite')); store.saveCheckpoint(seed.checkpoint()); store.saveWorker({ botId: 'paused-bot', sessionId: 'not-this-process', controllerEpoch: 'old-runtime', pid: process.pid, startedAt: Date.now() }); store.close();
    runtime = await startRuntime(f.options);
    assert.equal(isAlive(process.pid), true); assert.deepEqual(runtime.store.workers(), []); assert.deepEqual(runtime.supervisor.records(), []);
  } finally { await runtime?.close(); f.remove(); }
});
