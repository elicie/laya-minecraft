import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/server/src/main';
import { ControlStore } from '../apps/server/src/store';
import { isAlive } from '../apps/server/src/instance-lock';
import { CommandReceiptSchema, FleetCheckpointSchema, FleetSnapshotSchema, itemCount, type CommandReceipt, type FleetSnapshot } from '../packages/contracts/src';

const host = process.env.MC_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Only disposable minecraft-laya-validation on 127.0.0.1:25566 is allowed.');
type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const botName = 'LayaInvCollect';
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });

async function request(runtime: Runtime, method: string, path: string, input?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.address.port}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-laya-control': '1' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000),
  });
  const result: unknown = await response.json();
  assert.equal(response.status, method === 'GET' ? 200 : 202, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function applied(runtime: Runtime, method: string, path: string, input: unknown): Promise<CommandReceipt> {
  let receipt = CommandReceiptSchema.parse(await request(runtime, method, path, input));
  const deadline = Date.now() + 15000;
  while (!['applied', 'failed'].includes(receipt.state) && Date.now() < deadline) { await delay(100); receipt = CommandReceiptSchema.parse(await request(runtime, 'GET', `/commands/${receipt.id}`)); }
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt)); return receipt;
}
async function waitSnapshot(runtime: Runtime, predicate: (state: FleetSnapshot) => boolean, message: string, timeout = 15000): Promise<FleetSnapshot> {
  const deadline = Date.now() + timeout;
  let state = FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot'));
  while (!predicate(state) && Date.now() < deadline) { await delay(100); state = FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot')); }
  assert.ok(predicate(state), `${message}: ${JSON.stringify({ agents: state.agents.map(agent => ({ id: agent.id, status: agent.status, session: agent.session })), goals: state.goals, tasks: state.tasks, attempts: state.attempts })}`);
  return state;
}

test('actual HTTP and forked worker collect only the missing 22 logs into inventory when no warehouse is configured', { timeout: 150000 }, async () => {
  // The port is checked before every fixture can touch the Minecraft server.
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  assert.equal(rcon('list').includes(botName), false, 'The dedicated validation bot must not already be connected.');
  rcon('forceload add 2112 2112 2160 2160');
  rcon('fill 2112 80 2112 2160 90 2160 air'); rcon('fill 2112 77 2112 2160 79 2160 grass_block');
  rcon('kill @e[type=!player,x=2112,y=77,z=2112,dx=48,dy=16,dz=48]');
  // These are actual exposed logs with actual leaf observations, not crafted
  // planks or a synthetic inventory/result supplied to the controller.
  for (let index = 0; index < 22; index++) {
    const x = 2116 + index % 11, z = 2130 + Math.floor(index / 11) * 2;
    rcon(`setblock ${x} 80 ${z} oak_log`); rcon(`setblock ${x} 83 ${z} oak_leaves[persistent=true]`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'laya-collect-inventory-live-')), botId = randomUUID();
  let runtime: Runtime | undefined;
  try {
    runtime = await startRuntime({ runtimeDir: dir, host: '127.0.0.1', port: 0, workerExecArgv: ['--import', 'tsx'], tickIntervalMs: 100 });
    assert.notEqual(runtime.address.port, 3001, 'Use an isolated API instance, never the user preview instance.');
    await applied(runtime, 'PATCH', '/rules', { patch: { world: '127.0.0.1:25566', warehouse: null, center: null, autonomyEnabled: false }, mode: 'immediate' });
    await applied(runtime, 'POST', '/bots', { id: botId, name: botName, role: 'gatherer', allowedActions: ['collect', 'survive', 'recover'], connection: { host, port: 25566, version: '1.21.1', auth: 'offline' } });
    const ready = await waitSnapshot(runtime, state => state.agents.some(agent => agent.id === botId && agent.session?.state === 'ready' && agent.session.report?.ready), 'Actual forked worker must connect.');
    const sessionId = ready.agents.find(agent => agent.id === botId)!.session!.id, record = runtime.supervisor.records().find(worker => worker.botId === botId)!;
    assert.ok(record && record.pid !== process.pid && isAlive(record.pid)); assert.equal(record.sessionId, sessionId);

    await applied(runtime, 'POST', `/bots/${botId}/pause`, {});
    await waitSnapshot(runtime, state => state.agents.some(agent => agent.id === botId && agent.status === 'paused' && agent.session?.report?.mode === 'paused'), 'Fixture setup waits for actual pause.');
    rcon(`tp ${botName} 2132.5 80 2136.5`); rcon(`clear ${botName}`);
    rcon(`give ${botName} oak_log 10`); rcon(`give ${botName} iron_axe`); rcon(`give ${botName} bread 16`);
    rcon(`effect give ${botName} minecraft:instant_health 1 10 true`); rcon(`effect give ${botName} minecraft:saturation 1 10 true`);
    await waitSnapshot(runtime, state => {
      const report = state.agents.find(agent => agent.id === botId)?.session?.report;
      return report?.mode === 'paused' && report.health === 20 && report.food === 20 && itemCount(report.inventory, 'oak_log') === 10 && itemCount(report.inventory, 'iron_axe') === 1 && report.position?.x === 2132.5 && report.position.z === 2136.5;
    }, 'Readiness, initial 10 logs, equipment and fixture position must be actual worker reports.');
    await applied(runtime, 'POST', `/bots/${botId}/resume`, {});
    const before = await waitSnapshot(runtime, state => {
      const agent = state.agents.find(value => value.id === botId);
      return !!agent?.config.enabled && agent.status === 'ready' && agent.session?.report?.mode === 'idle' && itemCount(agent.session.report.inventory, 'oak_log') === 10 && state.observations.some(observation => observation.kind === 'inventory' && observation.botId === botId && observation.sessionId === sessionId && observation.controllerEpoch === state.controllerEpoch && itemCount(observation.data.items, 'oak_log') === 10);
    }, 'Enabled collector needs actual inventory baseline before the goal is registered.');
    assert.equal(before.rules.warehouse, null);
    const receipt = await applied(runtime, 'POST', '/goals', { kind: 'collect', item: 'oak_log', quantity: 32, quantityMode: 'total', mode: 'once', title: '창고 없이 원목 총 32개', preferredBotId: botId });
    assert.ok(receipt.result && typeof receipt.result === 'object' && !Array.isArray(receipt.result));
    const goalId = receipt.result.goalId; assert.equal(typeof goalId, 'string');
    const assigned = await waitSnapshot(runtime, state => state.tasks.some(task => task.goalId === goalId && task.kind === 'collect' && !!task.attemptId), 'Actual IPC assignment must use only the missing quota.');
    const collect = assigned.tasks.find(task => task.goalId === goalId && task.kind === 'collect')!;
    assert.equal(collect.params.quantity, 22); assert.equal(collect.params.inventoryBaseline, 10);
    assert.deepEqual(collect.completion, { kind: 'inventory', item: 'oak_log', minimum: 32 });
    assert.equal(assigned.tasks.some(task => task.goalId === goalId && task.kind === 'store'), false);
    assert.equal(assigned.goals.find(goal => goal.id === goalId)!.completionLocation, 'inventory');
    assert.equal(assigned.goals.find(goal => goal.id === goalId)!.input.destination, undefined);

    const finished = await waitSnapshot(runtime, state => state.goals.some(goal => goal.id === goalId && goal.state === 'completed') && itemCount(state.agents.find(agent => agent.id === botId)!.session!.report!.inventory, 'oak_log') === 32, 'Actual collection plus inventory observations must finish at 32.', 90000);
    const goal = finished.goals.find(value => value.id === goalId)!, proof = structuredClone(goal.completionSnapshot);
    assert.equal(goal.completionLocation, 'inventory'); assert.equal(goal.progress.current, 32); assert.equal(goal.targetQuantity, 32);
    assert.equal(proof?.location, 'inventory'); assert.equal(proof.quantity, 32);
    assert.deepEqual(proof.inventories.map(row => [row.botId, row.sessionId, row.count]), [[botId, sessionId, 32]]);
    assert.equal(finished.rules.warehouse, null); assert.equal(goal.input.destination, undefined);
    assert.equal(finished.tasks.filter(task => task.goalId === goalId).length, 1); assert.equal(finished.tasks.some(task => task.goalId === goalId && task.kind === 'store'), false);
    assert.ok(finished.observations.some(observation => observation.kind === 'inventory' && observation.botId === botId && observation.sessionId === sessionId && observation.controllerEpoch === finished.controllerEpoch && observation.observedAt >= goal.createdAt && itemCount(observation.data.items, 'oak_log') === 32));
    assert.ok(runtime.store.listEvents(1000).some(event => event.type === 'task.assigned' && event.taskId === collect.id));
    // Completion may cancel the final collector after its heartbeat proves the
    // total. Require actual idle before altering inventory, not a fabricated
    // completed result from the test.
    await waitSnapshot(runtime, state => state.agents.find(agent => agent.id === botId)?.session?.report?.mode === 'idle' && !state.agents.find(agent => agent.id === botId)?.session?.activeAttemptId, 'Final collection must actually stop.');
    rcon(`clear ${botName} oak_log 1`);
    const reduced = await waitSnapshot(runtime, state => itemCount(state.agents.find(agent => agent.id === botId)!.session!.report!.inventory, 'oak_log') === 31, 'Actual inventory loss must be observed after one-time completion.');
    assert.equal(reduced.goals.find(value => value.id === goalId)!.state, 'completed'); assert.deepEqual(reduced.goals.find(value => value.id === goalId)!.completionSnapshot, proof);
    await delay(1200);
    const stable = FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot'));
    assert.equal(stable.goals.find(value => value.id === goalId)!.state, 'completed'); assert.equal(stable.tasks.filter(task => task.goalId === goalId).length, 1);
    assert.equal(itemCount(stable.agents.find(agent => agent.id === botId)!.session!.report!.inventory, 'oak_log'), 31);
    console.log('Verified actual inventory collection without warehouse', JSON.stringify({ goalId, baseline: 10, assignedQuantity: collect.params.quantity, completionMinimum: 32, verifiedQuantity: proof.quantity, currentAfterLoss: 31, completionLocation: goal.completionLocation, workerPid: record.pid }));
    await runtime.close();
    assert.equal(isAlive(record.pid), false);
    const stored = new ControlStore(join(dir, 'control.sqlite'));
    try { const saved = FleetCheckpointSchema.parse(stored.loadCheckpoint()); assert.equal(saved.goals.find(value => value.id === goalId)!.state, 'completed'); assert.deepEqual(saved.goals.find(value => value.id === goalId)!.completionSnapshot, proof); }
    finally { stored.close(); }
  } finally { await runtime?.close(); rmSync(dir, { recursive: true, force: true }); rcon('kill @e[type=!player,x=2112,y=77,z=2112,dx=48,dy=16,dz=48]'); rcon('forceload remove 2112 2112 2160 2160'); }
});
