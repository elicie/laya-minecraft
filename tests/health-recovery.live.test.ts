import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/server/src/main';
import { CommandReceiptSchema, FleetSnapshotSchema, type CommandReceipt, type FleetSnapshot } from '../packages/contracts/src';

if ((process.env.MC_HOST ?? '127.0.0.1') !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation on 127.0.0.1:25566 only.');
type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const name = 'LayaHealth', origin = { x: 3496, y: 80, z: 3496 };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8', timeout: 10000 });

async function request(runtime: Runtime, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.address.port}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  const result: unknown = await response.json();
  assert.equal(response.status, method === 'GET' ? 200 : 202, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function command(runtime: Runtime, method: string, path: string, body: unknown = {}): Promise<CommandReceipt> {
  let receipt = CommandReceiptSchema.parse(await request(runtime, method, path, body));
  const deadline = Date.now() + 20000;
  while (!['applied', 'failed'].includes(receipt.state) && Date.now() < deadline) {
    await delay(100); receipt = CommandReceiptSchema.parse(await request(runtime, 'GET', `/commands/${receipt.id}`));
  }
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt)); return receipt;
}
function brief(s: FleetSnapshot) {
  return {
    bots: s.agents.map(a => ({ name: a.config.name, status: a.status, mode: a.session?.report?.mode, action: a.session?.report?.action, reason: a.session?.report?.reason, health: a.session?.report?.health, food: a.session?.report?.food, position: a.session?.report?.position, inventory: a.session?.report?.inventory, recovery: a.survivalRecovery && { startedAt: a.survivalRecovery.startedAt, target: a.survivalRecovery.targetHealth, waiting: !!a.survivalRecovery.wait } })),
    goals: s.goals.map(g => ({ id: g.id, state: g.state, reason: g.reason })),
    tasks: s.tasks.map(t => ({ id: t.id, state: t.state, retryCount: t.retryCount, reason: t.reason })),
  };
}
async function until(runtime: Runtime, predicate: (s: FleetSnapshot) => boolean, reason: string, timeout = 20000): Promise<FleetSnapshot> {
  const deadline = Date.now() + timeout; let logAt = Date.now() + 10000;
  let s = FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot'));
  while (!predicate(s) && Date.now() < deadline) {
    if (Date.now() >= logAt) { console.log('Actual health recovery', reason, JSON.stringify(brief(s))); logAt = Date.now() + 10000; }
    await delay(100); s = FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot'));
  }
  assert.ok(predicate(s), `${reason}: ${JSON.stringify(brief(s))}`); return s;
}

test('actual fractional low health retains food recovery through restart, harvests and eats, heals to full health and only then resumes the same goal', { timeout: 360000 }, async () => {
  // Every administrative command belongs to this disposable server. No health,
  // hunger, inventory or terrain fixture is sent to the survival world.
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  assert.equal(rcon('list').includes(name), false);
  const oldRegeneration = rcon('gamerule naturalRegeneration').match(/\b(true|false)\b/)?.[1];
  assert.ok(oldRegeneration);
  const dir = mkdtempSync(join(tmpdir(), 'laya-health-recovery-live-')), botId = randomUUID();
  const options = { runtimeDir: dir, host: '127.0.0.1', port: 0, workerExecArgv: ['--import', 'tsx'], tickIntervalMs: 100 };
  let runtime: Runtime | undefined;
  try {
    rcon('forceload add 3448 3448 3544 3544');
    for (const [low, high] of [[80, 82], [83, 85], [86, 88]]) rcon(`fill 3448 ${low} 3448 3544 ${high} 3544 air`);
    rcon('fill 3448 76 3448 3544 78 3544 dirt'); rcon('fill 3448 79 3448 3544 79 3544 grass_block');
    // This fixture exercises a genuinely blocked food wait and restart, while
    // the separate journey fixture exercises open-ended surface exploration.
    rcon('fill 3486 80 3486 3506 82 3486 stone'); rcon('fill 3486 80 3506 3506 82 3506 stone');
    rcon('fill 3486 80 3486 3486 82 3506 stone'); rcon('fill 3506 80 3486 3506 82 3506 stone');
    rcon('kill @e[type=!player,x=3448,y=75,z=3448,dx=96,dy=18,dz=96]');
    rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 6000'); rcon('weather clear');
    rcon('gamerule naturalRegeneration false');
    runtime = await startRuntime(options); assert.notEqual(runtime.address.port, 3001);
    await command(runtime, 'PATCH', '/rules', { patch: { world: '127.0.0.1:25566', warehouse: null, center: null, autonomyEnabled: false } });
    await command(runtime, 'POST', '/bots', { id: botId, name, role: 'general', connection: { host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline' } });
    await until(runtime, s => !!s.agents.find(a => a.id === botId)?.session?.report?.ready, 'actual worker ready');
    await command(runtime, 'POST', `/bots/${botId}/pause`);
    rcon(`tp ${name} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`); rcon(`clear ${name}`);
    rcon(`effect give ${name} instant_health 1 10 true`); rcon(`effect give ${name} saturation 1 10 true`);
    await until(runtime, s => { const r = s.agents.find(a => a.id === botId)?.session?.report; return r?.health === 20 && r.food === 20 && r.inventory.length === 0 && r.position?.x === origin.x + 0.5; }, 'actual initial healthy empty player');
    await delay(1100);
    // Read the real player foodLevel while applying a bounded hunger effect;
    // clear it at 17, then deliver the same fractional damage as production.
    rcon(`effect give ${name} hunger 30 63 true`);
    const hungerDeadline = Date.now() + 25000;
    let foodLevel = 20;
    while (foodLevel > 17 && Date.now() < hungerDeadline) {
      foodLevel = Number(rcon(`data get entity ${name} foodLevel`).match(/:\s*(\d+)/)?.[1]);
      assert.ok(Number.isFinite(foodLevel)); if (foodLevel > 17) await delay(100);
    }
    rcon(`effect clear ${name} hunger`); assert.equal(foodLevel, 17);
    const goalReceipt = await command(runtime, 'POST', '/goals', { kind: 'home', title: '회복 후 같은 귀환 목표', params: { position: { x: origin.x + 6, y: 80, z: origin.z }, radius: 1 }, preferredBotId: botId });
    const goalId = String((goalReceipt.result as { goalId: string }).goalId);
    const initial = FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot')).goals.find(g => g.id === goalId)!;
    assert.doesNotMatch(rcon(`damage ${name} 13.666667 minecraft:generic`), /invulnerable|No entity was found/);
    await command(runtime, 'POST', `/bots/${botId}/resume`);
    const waiting = await until(runtime, s => { const a = s.agents.find(a => a.id === botId); return a?.session?.report?.mode === 'survival' && a.session.report.action === '식량 대기' && !!a.survivalRecovery?.wait; }, 'low health food wait remains survival and blocks the queued goal', 220000);
    const agent = waiting.agents.find(a => a.id === botId)!, startedAt = agent.survivalRecovery!.startedAt;
    assert.ok(agent.session!.report!.health > 6 && agent.session!.report!.health < 7);
    assert.equal(waiting.attempts.length, 0); assert.ok(waiting.tasks.every(t => t.retryCount === 0));
    const savedSearch = structuredClone(agent.survivalRecovery!.checkpoint.resourceRecovery);
    assert.ok(savedSearch);
    await runtime.close(); runtime = undefined;
    runtime = await startRuntime(options);
    const restored = await until(runtime, s => { const a = s.agents.find(a => a.id === botId); return !!a?.session?.report?.ready && a.session.report.mode === 'survival' && a.survivalRecovery?.startedAt === startedAt; }, 'actual restart retains recovery episode and spent search');
    assert.deepEqual(restored.agents.find(a => a.id === botId)!.survivalRecovery!.checkpoint.resourceRecovery, savedSearch);
    assert.equal(restored.attempts.length, 0);
    // Only actual source blocks appear. No edible item is given. The changed
    // melon observation may reopen the saved search budget; a restart cannot.
    for (const dx of [3, 4, 5, 6]) for (const dz of [2, 3]) {
      rcon(`setblock ${origin.x + dx} 80 ${origin.z + dz} melon`);
    }
    const fed = await until(runtime, s => { const a = s.agents.find(a => a.id === botId), r = a?.session?.report; return r?.food !== undefined && r.food >= 18 && r.inventory.some(i => i.name === 'melon_slice' && i.count > 0) && r.mode === 'survival'; }, 'actual melon drops and consumption raise food while recovery keeps work blocked', 80000);
    assert.ok(fed.agents.find(a => a.id === botId)!.session!.report!.health < 7);
    assert.equal(fed.attempts.length, 0); assert.ok(fed.tasks.every(t => t.retryCount === 0));
    assert.ok([3, 4, 5, 6].some(dx => [2, 3].some(dz => /Test passed/.test(rcon(`execute if block ${origin.x + dx} 80 ${origin.z + dz} air`)))), 'actual melon was harvested');
    rcon('gamerule naturalRegeneration true');
    const partial = await until(runtime, s => { const r = s.agents.find(a => a.id === botId)?.session?.report; return !!r && r.health > 10 && r.health < 20; }, 'actual natural healing passes the old ordinary health threshold', 80000);
    rcon('gamerule naturalRegeneration false');
    assert.equal(partial.agents.find(a => a.id === botId)!.session!.report!.mode, 'survival');
    assert.equal(partial.attempts.length, 0);
    await runtime.close(); runtime = undefined;
    runtime = await startRuntime(options);
    const resumed = await until(runtime, s => { const a = s.agents.find(a => a.id === botId), r = a?.session?.report; return !!r?.ready && r.health > 10 && r.health < 20 && r.mode === 'survival' && a?.survivalRecovery?.startedAt === startedAt; }, 'restart above ten health still retains the full recovery target');
    assert.equal(resumed.attempts.length, 0);
    rcon('gamerule naturalRegeneration true');
    const completed = await until(runtime, s => s.goals.some(g => g.id === goalId && g.state === 'completed'), 'actual full health recovery allows the original queued goal to complete', 100000);
    const recovered = completed.agents.find(a => a.id === botId)!, goal = completed.goals.find(g => g.id === goalId)!;
    assert.equal(recovered.session!.report!.health, 20); assert.ok(recovered.session!.report!.food >= 18);
    assert.equal(recovered.survivalRecovery, undefined); assert.deepEqual(goal.input, initial.input); assert.equal(goal.generation, initial.generation);
    assert.ok(completed.tasks.filter(t => t.goalId === goalId).every(t => t.state === 'completed' && t.retryCount === 0));
    assert.ok(completed.attempts.every(a => a.state === 'completed'));
    console.log('Verified actual low-health recovery', JSON.stringify({ goalId, startingHealth: agent.session!.report!.health, startingFood: agent.session!.report!.food, finalHealth: recovered.session!.report!.health, finalFood: recovered.session!.report!.food, preservedRecoveryStartedAt: startedAt, actualRestarts: 2, grantedEdibleItems: 0, goalState: goal.state }));
  } finally {
    await runtime?.close(); rmSync(dir, { recursive: true, force: true });
    rcon(`effect clear ${name} hunger`); rcon(`gamerule naturalRegeneration ${oldRegeneration}`); rcon('forceload remove 3448 3448 3544 3544');
  }
});
