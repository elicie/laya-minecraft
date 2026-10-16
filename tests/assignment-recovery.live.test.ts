import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/server/src/main';
import { ControlStore } from '../apps/server/src/store';
import { FleetController } from '../packages/core/src';
import { CommandReceiptSchema, FleetCheckpointSchema, FleetSnapshotSchema, type FleetSnapshot } from '../packages/contracts/src';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8', timeout: 10000 });

test('a legacy held assignment at five retries survives a paused restart and actually collects and returns without resetting its saved budgets', { timeout: 120000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const name = 'LayaAdmission', botId = randomUUID(), home = { x: 7904.5, y: 80, z: 7904.5 }, world = '127.0.0.1:25566';
  assert.equal(rcon('list').includes(name), false);
  const dir = mkdtempSync(join(tmpdir(), 'laya-assignment-recovery-'));
  const options = { runtimeDir: dir, host: '127.0.0.1', port: 0, workerExecArgv: ['--import', 'tsx'], tickIntervalMs: 100 };
  let runtime: Runtime | undefined;
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${runtime!.address.port}/api/v1${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    const value: unknown = await response.json(); assert.equal(response.status, method === 'GET' ? 200 : 202, JSON.stringify(value)); return value;
  };
  const snapshot = async () => FleetSnapshotSchema.parse(await request('GET', '/snapshot'));
  const connectPausedWorker = () => {
    // Disabled bots are intentionally not auto-connected at startup. Connect
    // this paused validation player explicitly through our supervisor API.
    const s = runtime!.core.getSnapshot(), sessionId = randomUUID(), agent = s.agents[0]!;
    assert.equal(agent.config.enabled, false);
    runtime!.supervisor.spawn(botId, sessionId, s.controllerEpoch, { config: agent.config, rules: s.rules });
    runtime!.core.startSession(botId, sessionId);
  };
  const until = async (predicate: (s: FleetSnapshot) => boolean, reason: string, timeout = 20000) => {
    const end = Date.now() + timeout; let s = await snapshot();
    while (!predicate(s) && Date.now() < end) { await delay(100); s = await snapshot(); }
    assert.ok(predicate(s), `${reason}: ${JSON.stringify({ bots: s.agents.map(a => ({ state: a.status, report: { action: a.session?.report?.action, reason: a.session?.report?.reason, position: a.session?.report?.position } })), tasks: s.tasks.map(t => ({ state: t.state, reason: t.reason })) })}`);
    return s;
  };
  try {
    rcon('forceload add 7900 7900 7940 7912');
    rcon('fill 7900 80 7900 7940 86 7912 air'); rcon('fill 7900 76 7900 7940 78 7912 dirt'); rcon('fill 7900 79 7900 7940 79 7912 grass_block');
    rcon('fill 7924 80 7904 7924 81 7904 oak_log'); rcon('fill 7923 82 7903 7925 82 7905 oak_leaves[persistent=true]');
    rcon('kill @e[type=!player,x=7900,y=-64,z=7900,dx=40,dy=152,dz=12]');
    // Persist the exact old pre-execution failure format in this disposable
    // runtime. No controller state or fixture touches the survival world.
    const core = new FleetController({ send() {}, rules: { world, autonomyEnabled: false } });
    core.addAgent({ id: botId, name, connection: { host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline' } });
    core.startSession(botId, 'legacy-worker');
    const ready = { ready: true, world, dimension: 'overworld', position: home, health: 20, food: 20, inventory: [], action: '대기', reason: 'legacy fixture', mode: 'idle', capabilities: ['collect'], rulesVersion: core.getSnapshot().rules.version };
    for (const [type, payload] of [['bot.ready', ready], ['rules.applied', { version: ready.rulesVersion }]] as const) core.receive({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: core.controllerEpoch, botId, sessionId: 'legacy-worker', sentAt: Date.now(), type, payload });
    const goal = core.createGoal({ kind: 'collect', item: 'oak_log', quantity: 2, preferredBotId: botId, params: { returnTo: home } });
    const saved = core.checkpoint(), task = saved.tasks.find(t => t.goalId === goal.id)!, attempt = saved.attempts.find(a => a.taskId === task.id)!;
    assert.ok(attempt); const reason = '현재 상태에서는 일반 작업을 시작할 수 없습니다.';
    const foodBudget = { origin: { x: 7904, y: 80, z: 7904 }, destinationsUsed: 5, elapsedMs: 60000, status: 'exhausted' };
    task.state = 'held'; task.reason = reason; task.retryCount = 5; task.resumeCount = 44;
    task.checkpoint = { resourceRecovery: { $food: foodBudget }, resourceExpedition: true, resourceTrip: { item: 'oak_log', minimum: 2, home: { x: 7904, y: 80, z: 7904 }, trail: [{ x: 7904, y: 80, z: 7904 }], phase: 'outbound', returns: 4 } };
    attempt.state = 'failed'; attempt.finishedAt = Date.now(); attempt.result = { outcome: 'failed', observations: [], evidence: [], checkpoint: structuredClone(task.checkpoint), error: { code: 'TASK_REJECTED', message: reason, retryable: true, effectsKnown: true } };
    saved.goals.find(g => g.id === goal.id)!.state = 'held'; saved.goals.find(g => g.id === goal.id)!.reason = reason;
    saved.agents[0]!.config.enabled = false; saved.agents[0]!.session!.activeAttemptId = undefined; saved.reservations = [];
    const store = new ControlStore(join(dir, 'control.sqlite')); store.saveCheckpoint(FleetCheckpointSchema.parse(saved)); store.close();
    runtime = await startRuntime(options); assert.notEqual(runtime.address.port, 3001);
    connectPausedWorker();
    await until(s => !!s.agents[0]?.session?.report?.ready, 'actual paused worker ready');
    rcon(`tp ${name} ${home.x} ${home.y} ${home.z}`); rcon(`clear ${name}`);
    rcon(`effect give ${name} instant_health 1 10 true`); rcon(`effect give ${name} saturation 1 10 true`);
    const paused = await until(s => s.agents[0]?.session?.report?.position?.x === home.x, 'actual fixture position observed');
    assert.equal(paused.tasks[0]!.state, 'interrupted'); assert.equal(paused.tasks[0]!.retryCount, 5); assert.deepEqual(paused.tasks[0]!.checkpoint, task.checkpoint);
    assert.equal(paused.attempts.length, 1, 'pause must not create a new attempt');
    await runtime.close(); runtime = undefined;
    runtime = await startRuntime(options);
    connectPausedWorker();
    const restarted = await until(s => !!s.agents[0]?.session?.report?.ready, 'second actual paused worker ready');
    assert.equal(restarted.tasks[0]!.assignmentWait?.blockedBy, 'state'); assert.equal(restarted.attempts.length, 1); assert.deepEqual(restarted.tasks[0]!.checkpoint, task.checkpoint);
    let receipt = CommandReceiptSchema.parse(await request('POST', `/bots/${botId}/resume`, {}));
    const receiptDeadline = Date.now() + 20000;
    while (!['applied', 'failed'].includes(receipt.state) && Date.now() < receiptDeadline) { await delay(100); receipt = CommandReceiptSchema.parse(await request('GET', `/commands/${receipt.id}`)); }
    assert.equal(receipt.state, 'applied');
    const done = await until(s => s.goals.find(g => g.id === goal.id)?.state === 'completed', 'same goal actually harvests and returns', 70000);
    const actual = done.agents[0]!.session!.report!, finished = done.tasks.find(t => t.id === task.id)!;
    assert.equal(finished.state, 'completed'); assert.equal(finished.retryCount, 5); assert.equal(done.goals.find(g => g.id === goal.id)!.generation, goal.generation);
    assert.deepEqual((finished.checkpoint.resourceRecovery as { $food: unknown }).$food, foodBudget);
    assert.ok(actual.inventory.some(i => i.name === 'oak_log' && i.count >= 2));
    assert.ok(actual.position && Math.hypot(actual.position.x - home.x, actual.position.y - home.y, actual.position.z - home.z) < 1.5);
    assert.match(rcon('execute if block 7924 80 7904 air'), /Test passed/);
    assert.ok(done.events.some(e => e.type === 'task.assignment-resumed' && e.taskId === task.id));
    assert.equal(done.attempts[0]!.state, 'failed', 'historical failure evidence remains unchanged');
    console.log('Verified actual legacy assignment recovery', JSON.stringify({ goalId: goal.id, taskId: task.id, retryCount: finished.retryCount, foodBudgetPreserved: true, actualWorkerStarts: 2, inventory: actual.inventory, position: actual.position, goalState: 'completed' }));
  } finally {
    await runtime?.close(); rmSync(dir, { recursive: true, force: true }); rcon('forceload remove 7900 7900 7940 7912');
  }
});
