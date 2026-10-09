import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/server/src/main';
import { isAlive } from '../apps/server/src/instance-lock';
import { ControlStore } from '../apps/server/src/store';
import {
  CommandReceiptSchema, FleetCheckpointSchema, FleetSnapshotSchema, type CommandReceipt, type FleetSnapshot,
} from '../packages/contracts/src';

const host = process.env.MC_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' || process.env.MC_PORT !== '25566') {
  throw new Error('Actual runtime integration requires disposable minecraft-laya-validation:25566 only.');
}
type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function request(runtime: Runtime, method: string, path: string, value?: unknown, idempotencyKey?: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.address.port}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json', 'x-laya-control': '1',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    signal: AbortSignal.timeout(5000),
  });
  const result: unknown = await response.json();
  assert.equal(response.status, method === 'GET' ? 200 : 202, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function snapshot(runtime: Runtime): Promise<FleetSnapshot> {
  return FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot'));
}
async function waitForSnapshot(runtime: Runtime, predicate: (state: FleetSnapshot) => boolean, message: string, timeout = 15000): Promise<FleetSnapshot> {
  const deadline = Date.now() + timeout;
  let state = await snapshot(runtime);
  while (!predicate(state) && Date.now() < deadline) { await delay(100); state = await snapshot(runtime); }
  assert.ok(predicate(state), `${message}: ${JSON.stringify({ agents: state.agents.map(a => ({ id: a.id, status: a.status, session: a.session })), goals: state.goals, tasks: state.tasks })}`);
  return state;
}
async function applied(runtime: Runtime, receipt: CommandReceipt): Promise<CommandReceipt> {
  const deadline = Date.now() + 15000;
  let current = receipt;
  while (current.state !== 'applied' && current.state !== 'failed' && Date.now() < deadline) {
    await delay(100);
    current = CommandReceiptSchema.parse(await request(runtime, 'GET', `/commands/${receipt.id}`));
  }
  assert.equal(current.state, 'applied', JSON.stringify(current));
  return current;
}

test('isolated real runtime verifies HTTP goals through forked Minecraft IPC and actual lifecycle acknowledgements', { timeout: 60000 }, async () => {
  // Verify the container's published port before any Minecraft connection.
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const dir = mkdtempSync(join(tmpdir(), 'laya-runtime-live-'));
  let runtime: Runtime | undefined;
  const botId = `runtime-live-${randomUUID()}`;
  try {
    runtime = await startRuntime({
      runtimeDir: dir, host: '127.0.0.1', port: 0,
      workerExecArgv: ['--import', 'tsx'], tickIntervalMs: 100,
    });
    assert.notEqual(runtime.address.port, 3001);
    const rulesReceipt = CommandReceiptSchema.parse(await request(runtime, 'PATCH', '/rules', {
      patch: { autonomyEnabled: false, world: '127.0.0.1:25566', warehouse: null, center: null }, mode: 'immediate',
    }));
    await applied(runtime, rulesReceipt);
    const registered = CommandReceiptSchema.parse(await request(runtime, 'POST', '/bots', {
      id: botId, name: 'LayaApiCheck', allowedActions: ['home', 'survive', 'recover'],
      connection: { host, port: 25566, version: '1.21.1', auth: 'offline' },
    }));
    await applied(runtime, registered);
    const ready = await waitForSnapshot(runtime, state => {
      const bot = state.agents.find(a => a.id === botId);
      return bot?.status === 'ready' && bot.session?.state === 'ready' && !!bot.session.report?.position && bot.session.report.ready;
    }, 'actual forked worker must report Minecraft readiness');
    const agent = ready.agents.find(a => a.id === botId)!;
    const sessionId = agent.session!.id;
    const worker = runtime.supervisor.records().find(record => record.botId === botId)!;
    assert.ok(worker);
    assert.notEqual(worker.pid, process.pid);
    assert.ok(isAlive(worker.pid));
    assert.equal(worker.sessionId, sessionId);
    assert.equal(worker.controllerEpoch, ready.controllerEpoch);
    assert.equal(agent.session!.report!.world, '127.0.0.1:25566');
    assert.equal(agent.session!.rulesVersion, ready.rules.version);

    // Use an actually observed position. This verifies the entire real pipeline
    // without setting blocks, teleporting, giving items, or editing server rules.
    const position = agent.session!.report!.position!;
    const key = randomUUID();
    const goalInput = { kind: 'home', title: '실제 IPC 위치 확인', preferredBotId: botId, params: { position, radius: 2 } };
    const goalReceipt = CommandReceiptSchema.parse(await request(runtime, 'POST', '/goals', goalInput, key));
    await applied(runtime, goalReceipt);
    const duplicate = CommandReceiptSchema.parse(await request(runtime, 'POST', '/goals', goalInput, key));
    assert.equal(duplicate.id, goalReceipt.id);
    assert.ok(goalReceipt.result && typeof goalReceipt.result === 'object' && !Array.isArray(goalReceipt.result));
    const goalId = goalReceipt.result.goalId;
    assert.equal(typeof goalId, 'string');
    const finished = await waitForSnapshot(runtime, state => state.goals.find(g => g.id === goalId)?.state === 'completed', 'actual worker position observation must verify the goal');
    assert.equal(finished.goals.length, 1);
    const task = finished.tasks.find(t => t.goalId === goalId)!;
    assert.equal(task.state, 'completed');
    assert.equal(task.kind, 'home');
    const attempt = finished.attempts.find(a => a.id === task.attemptId)!;
    assert.equal(attempt.state, 'completed');
    assert.equal(attempt.botId, botId);
    assert.equal(attempt.sessionId, sessionId);
    assert.equal(attempt.controllerEpoch, finished.controllerEpoch);
    assert.ok(attempt.startedAt);
    assert.equal(attempt.result?.outcome, 'completed');
    const observation = finished.observations.find(o => o.kind === 'position' && o.attemptId === attempt.id);
    assert.ok(observation && observation.kind === 'position');
    assert.equal(observation.botId, botId);
    assert.equal(observation.sessionId, sessionId);
    assert.equal(observation.world, '127.0.0.1:25566');
    assert.ok(Math.hypot(observation.data.position.x - position.x, observation.data.position.y - position.y, observation.data.position.z - position.z) <= 2);
    const events = runtime.store.listEvents(1000);
    for (const type of ['bot.ready', 'world.observed', 'task.assigned', 'task.accepted', 'task.started', 'task.completed', 'goal.completed']) {
      assert.ok(events.some(event => event.type === type), type);
    }

    const pauseReceipt = CommandReceiptSchema.parse(await request(runtime, 'POST', `/bots/${botId}/pause`, {}));
    await applied(runtime, pauseReceipt);
    const paused = await waitForSnapshot(runtime, state => {
      const bot = state.agents.find(a => a.id === botId);
      return bot?.status === 'paused' && !bot.config.enabled && bot.session?.report?.mode === 'paused';
    }, 'pause must be applied by the actual worker');
    assert.equal(paused.agents.find(a => a.id === botId)!.session!.id, sessionId);
    assert.ok(isAlive(worker.pid));
    const resumeReceipt = CommandReceiptSchema.parse(await request(runtime, 'POST', `/bots/${botId}/resume`, {}));
    await applied(runtime, resumeReceipt);
    const resumed = await waitForSnapshot(runtime, state => {
      const bot = state.agents.find(a => a.id === botId);
      return bot?.status === 'ready' && bot.config.enabled && bot.session?.report?.mode === 'idle';
    }, 'resume must be applied by the actual worker');
    assert.equal(resumed.agents.find(a => a.id === botId)!.session!.id, sessionId);
    assert.equal(runtime.supervisor.records().length, 1);

    const removed = CommandReceiptSchema.parse(await request(runtime, 'POST', `/bots/${botId}/remove`, {}));
    await applied(runtime, removed);
    const stopped = await waitForSnapshot(runtime, state => state.agents.find(a => a.id === botId)?.status === 'removed', 'remove must wait for actual child process exit');
    assert.equal(stopped.agents.find(a => a.id === botId)!.session!.state, 'stopped');
    assert.equal(isAlive(worker.pid), false);
    assert.deepEqual(runtime.supervisor.records(), []);
    assert.deepEqual(runtime.store.workers(), []);
    assert.ok(runtime.store.listEvents(1000).some(event => event.type === 'bot.process-stopped' && event.botId === botId));
    await runtime.close();
    const stored = new ControlStore(join(dir, 'control.sqlite'));
    try {
      const restored = FleetCheckpointSchema.parse(stored.loadCheckpoint());
      assert.equal(restored.goals.find(g => g.id === goalId)?.state, 'completed');
    } finally { stored.close(); }
  } finally { await runtime?.close(); rmSync(dir, { recursive: true, force: true }); }
});
