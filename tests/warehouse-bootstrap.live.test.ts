import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/server/src/main';
import { ControlStore } from '../apps/server/src/store';
import { CommandReceiptSchema, FleetCheckpointSchema, FleetSnapshotSchema, blueprint, itemCount, sameContainer, type CommandReceipt, type FleetSnapshot } from '../packages/contracts/src';

const host = process.env.MC_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Only disposable minecraft-laya-validation on 127.0.0.1:25566 is allowed.');
type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const name = 'LayaWarehouse';
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8', timeout: 10000 });

async function request(runtime: Runtime, method: string, path: string, input?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.address.port}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': randomUUID() },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000),
  });
  const value: unknown = await response.json();
  assert.equal(response.status, method === 'GET' || path === '/goals/interpret' ? 200 : 202, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
async function applied(runtime: Runtime, method: string, path: string, input: unknown): Promise<CommandReceipt> {
  let receipt = CommandReceiptSchema.parse(await request(runtime, method, path, input));
  const deadline = Date.now() + 20000;
  while (!['applied', 'failed'].includes(receipt.state) && Date.now() < deadline) { await delay(100); receipt = CommandReceiptSchema.parse(await request(runtime, 'GET', `/commands/${receipt.id}`)); }
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt)); return receipt;
}
function brief(state: FleetSnapshot) {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const resources = (value: unknown) => Object.fromEntries(Object.entries(object(value)).map(([item, data]) => {
    const resource = object(data);
    return [item, Object.fromEntries(['origin', 'status', 'destinationsUsed', 'approachesUsed', 'elapsedMs', 'reason'].map(field => [field, resource[field]]))];
  }));
  return { bots: state.agents.map(a => ({ name: a.config.name, mode: a.session?.report?.mode, action: a.session?.report?.action, reason: a.session?.report?.reason, health: a.session?.report?.health, food: a.session?.report?.food, position: a.session?.report?.position, inventory: a.session?.report?.inventory })), goals: state.goals.map(g => ({ id: g.id, state: g.state, reason: g.reason, generation: g.generation })), tasks: state.tasks.map(t => ({ id: t.id, kind: t.kind, mode: t.params.mode, state: t.state, reason: t.reason, retryCount: t.retryCount, checkpointKeys: Object.keys(t.checkpoint), build: t.checkpoint.build, buildMaterial: t.checkpoint.buildMaterial, buildPreflight: t.checkpoint.buildPreflight, resourceRecovery: resources(t.checkpoint.resourceRecovery), waitingFor: t.checkpoint.waitingFor, missingResource: t.checkpoint.missingResource, remainingCount: object(t.checkpoint.buildRemaining).count })) };
}
async function until(runtime: Runtime, predicate: (state: FleetSnapshot) => boolean, reason: string, timeout = 20000): Promise<FleetSnapshot> {
  const deadline = Date.now() + timeout; let nextLog = Date.now() + 10000;
  let state = FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot'));
  while (!predicate(state) && Date.now() < deadline) {
    if (Date.now() >= nextLog) { console.log('Actual warehouse progress', JSON.stringify(brief(state))); nextLog = Date.now() + 10000; }
    const stopped = state.goals.find(g => ['held', 'condition-wait'].includes(g.state));
    if (timeout > 30000 && stopped && !state.agents.some(a => ['working', 'survival', 'recovering', 'emergency'].includes(a.session?.report?.mode ?? ''))) assert.fail(`${reason}: stopped ${JSON.stringify(brief(state))}`);
    await delay(250); state = FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot'));
  }
  assert.ok(predicate(state), `${reason}: ${JSON.stringify(brief(state))}`); return state;
}

test('natural-language warehouse goal starts empty, clears vegetation, gathers and crafts, builds, opens its chest and connects the warehouse', { timeout: 900000 }, async () => {
  // Never dispatch administrative fixtures until the disposable port is proven.
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  assert.equal(rcon('list').includes(name), false);
  rcon('forceload add 3072 3072 3136 3136');
  for (const [low, high] of [[80, 84], [85, 90]]) rcon(`fill 3072 ${low} 3072 3136 ${high} 3136 air`);
  rcon('fill 3072 76 3072 3136 78 3136 dirt'); rcon('fill 3072 79 3072 3136 79 3136 grass_block');
  rcon('fill 3072 80 3072 3136 80 3136 short_grass');
  rcon('setblock 3090 80 3090 air');
  rcon('kill @e[type=!player,x=3072,y=75,z=3072,dx=64,dy=18,dz=64]');
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('gamerule keepInventory false'); rcon('time set 6000'); rcon('weather clear');
  // Sources remain actual mineable blocks. No tool, construction material,
  // completed block, fake inventory or successful result is granted to the bot.
  for (const x of [3076, 3080, 3084]) for (const z of [3100, 3104, 3108, 3112]) {
    rcon(`fill ${x} 80 ${z} ${x} 83 ${z} oak_log`); rcon(`setblock ${x} 85 ${z} oak_leaves[persistent=true]`);
  }
  rcon('fill 3076 80 3080 3082 80 3086 stone');
  rcon('fill 3076 80 3096 3078 80 3098 sand');
  rcon('fill 3082 80 3096 3083 80 3097 coal_ore');
  const dir = mkdtempSync(join(tmpdir(), 'laya-warehouse-bootstrap-live-')), botId = randomUUID();
  let runtime: Runtime | undefined;
  try {
    runtime = await startRuntime({ runtimeDir: dir, host: '127.0.0.1', port: 0, workerExecArgv: ['--import', 'tsx'], tickIntervalMs: 100 });
    assert.notEqual(runtime.address.port, 3001);
    await applied(runtime, 'PATCH', '/rules', { patch: { world: '127.0.0.1:25566', warehouse: null, center: null, autonomyEnabled: false }, mode: 'immediate' });
    await applied(runtime, 'POST', '/bots', { id: botId, name, role: 'general', connection: { host, port: 25566, version: '1.21.1', auth: 'offline' } });
    await until(runtime, s => !!s.agents.find(a => a.id === botId)?.session?.report?.ready, 'Actual worker ready');
    await applied(runtime, 'POST', `/bots/${botId}/pause`, {});
    rcon(`tp ${name} 3090.5 80 3090.5`); rcon(`clear ${name}`);
    rcon(`effect give ${name} minecraft:instant_health 1 10 true`); rcon(`effect give ${name} minecraft:saturation 1 10 true`);
    await until(runtime, s => {
      const a = s.agents.find(a => a.id === botId), r = a?.session?.report;
      return a?.status === 'paused' && r?.health === 20 && r.food === 20 && r.inventory.length === 0 && r.position?.x === 3090.5 && r.position.z === 3090.5;
    }, 'Actually empty inventory and known ground before goal');
    // Exercise the same interpretation endpoint used by the React goal form,
    // with no client-origin/site-selection repair hiding a planner omission.
    const interpretation = await request(runtime, 'POST', '/goals/interpret', { text: '창고를 만들어 줘' }) as { goal: Record<string, unknown> };
    assert.equal(interpretation.goal.kind, 'build');
    const receipt = await applied(runtime, 'POST', '/goals', { ...interpretation.goal, preferredBotId: botId, executionMode: 'immediate' });
    const goalId = String((receipt.result as { goalId: string }).goalId);
    await applied(runtime, 'POST', `/bots/${botId}/resume`, {});
    const finished = await until(runtime, s => s.goals.some(g => g.id === goalId && g.state === 'completed') && !!s.rules.warehouse, 'Full actual bootstrap to connected warehouse', 720000);
    const goal = finished.goals.find(g => g.id === goalId)!, warehouse = finished.rules.warehouse!;
    const origin = goal.input.params.origin as { x: number; y: number; z: number };
    const expected = blueprint('warehouse', origin);
    assert.equal(expected.length, 136);
    assert.ok(finished.tasks.some(t => t.goalId === goalId && t.params.mode === 'build-site' && t.state === 'completed'));
    assert.ok(finished.tasks.some(t => t.goalId === goalId && t.params.mode === 'prepare-site' && t.state === 'completed'), 'The vegetation-covered site must actually be prepared');
    const registration = finished.tasks.find(t => t.goalId === goalId && t.params.mode === 'register-warehouse')!;
    assert.ok(registration); assert.equal(registration.state, 'completed'); assert.equal(registration.completion.kind, 'warehouse');
    const attempt = finished.attempts.find(a => a.id === registration.attemptId)!;
    assert.equal(attempt.state, 'completed'); assert.equal(attempt.botId, botId);
    assert.ok(attempt.result?.observations.some(o => o.kind === 'container' && sameContainer(o.data.container, warehouse)), 'The chest contents must come from the actual open-container result');
    const matching = finished.observations.filter(o => o.kind === 'blocks' && o.attemptId === attempt.id).flatMap(o => o.kind === 'blocks' ? o.data.blocks : []);
    assert.ok(expected.every(e => matching.some(b => b.position.x === e.position.x && b.position.y === e.position.y && b.position.z === e.position.z && b.name === e.name)));
    console.log('Actual warehouse construction and registration completed', JSON.stringify({ goalId, origin, cells: expected.length, warehouse }));
    // Keep server-side command parsing bounded and require terminal condition
    // feedback. A long execute chain plus chat broadcast is not read evidence.
    for (const b of expected) {
      assert.match(rcon(`execute if block ${b.position.x} ${b.position.y} ${b.position.z} ${b.name}`), /Test passed/, `Actual server block ${JSON.stringify(b)}`);
    }
    console.log('Actual server independently verified all warehouse blocks', expected.length);
    assert.ok(finished.observations.some(o => o.kind === 'inventory' && o.botId === botId && itemCount(o.data.items, 'wooden_pickaxe') >= 1), 'Actual stone tool bootstrap was observed');
    assert.ok(finished.observations.some(o => o.kind === 'inventory' && o.botId === botId && itemCount(o.data.items, 'glass') >= 1), 'Sand was actually smelted before window crafting');
    const report = finished.agents.find(a => a.id === botId)!.session!.report!;
    assert.equal(report.health > 0, true);
    await until(runtime, s => {
      const a = s.agents.find(a => a.id === botId);
      return a?.session?.rulesVersion === s.rules.version && !a.session.activeAttemptId;
    }, 'The new warehouse rules must actually be applied after the safe stop');
    const delivery = await applied(runtime, 'POST', '/goals', { kind: 'collect', item: 'oak_log', quantity: 4, title: '완성한 창고에 원목 4개', preferredBotId: botId });
    const deliveryId = String((delivery.result as { goalId: string }).goalId);
    const delivered = await until(runtime, s => s.goals.some(g => g.id === deliveryId && g.state === 'completed'), 'Subsequent gathering must use and actually deposit into the built warehouse', 70000);
    assert.equal(delivered.goals.find(g => g.id === deliveryId)!.completionLocation, 'warehouse');
    assert.ok(delivered.observations.some(o => o.kind === 'container' && sameContainer(o.data.container, warehouse) && itemCount(o.data.items, 'oak_log') >= 4));
    assert.ok(delivered.tasks.some(t => t.goalId === deliveryId && t.kind === 'store' && t.state === 'completed'));
    console.log('Verified actual empty-inventory warehouse', JSON.stringify({ goalId, origin, cells: expected.length, warehouse, stages: finished.tasks.filter(t => t.goalId === goalId).map(t => ({ kind: t.kind, mode: t.params.mode, state: t.state })), inventory: report.inventory, suppliedConstructionItems: 0 }));
    await runtime.close();
    const stored = new ControlStore(join(dir, 'control.sqlite'));
    try { const saved = FleetCheckpointSchema.parse(stored.loadCheckpoint()); assert.equal(saved.goals.find(g => g.id === goalId)!.state, 'completed'); assert.deepEqual(saved.rules.warehouse, warehouse); }
    finally { stored.close(); }
  } finally { await runtime?.close(); rmSync(dir, { recursive: true, force: true }); rcon('forceload remove 3072 3072 3136 3136'); }
});
