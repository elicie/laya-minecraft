import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/server/src/main';
import { blueprint } from '../packages/contracts/src/blueprints';
import { FleetSnapshotSchema, type CommandReceipt, type FleetSnapshot } from '../packages/contracts/src';

if ((process.env.MC_HOST ?? '127.0.0.1') !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
type Runtime = Awaited<ReturnType<typeof startRuntime>>;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
function validateServer() { assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566'); }
async function request(runtime: Runtime, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.address.port}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const result = await response.json(); assert.equal(response.status, method === 'GET' ? 200 : 202, `${method} ${path}: ${JSON.stringify(result)}`); return result;
}
async function snapshot(runtime: Runtime): Promise<FleetSnapshot> { return FleetSnapshotSchema.parse(await request(runtime, 'GET', '/snapshot')); }
async function until(runtime: Runtime, predicate: (s: FleetSnapshot) => boolean, reason: string, timeout = 20000): Promise<FleetSnapshot> {
  const end = Date.now() + timeout; let s = await snapshot(runtime);
  while (!predicate(s) && Date.now() < end) { await delay(100); s = await snapshot(runtime); }
  assert.ok(predicate(s), `${reason}: ${JSON.stringify({ agents: s.agents.map(a => ({ id: a.id, mode: a.session?.report?.mode, action: a.session?.report?.action, reason: a.session?.report?.reason, health: a.session?.report?.health, position: a.session?.report?.position, inventory: a.session?.report?.inventory, recovery: a.recovery && { phase: a.recovery.phase, safe: a.recovery.safe, reason: a.recovery.reason, attempts: a.recovery.attemptCount, progress: a.recovery.progress } })), tasks: s.tasks.map(t => ({ id: t.id, kind: t.kind, mode: t.params.mode, state: t.state, reason: t.reason, checkpointKeys: Object.keys(t.checkpoint) })), events: s.events.slice(-6).map(e => ({ type: e.type, message: e.message })) })}`);
  return s;
}
async function command(runtime: Runtime, method: string, path: string, body: unknown = {}): Promise<CommandReceipt> {
  let receipt = await request(runtime, method, path, body) as CommandReceipt;
  const end = Date.now() + 20000;
  while (receipt.state !== 'applied' && receipt.state !== 'failed' && Date.now() < end) { await delay(100); receipt = await request(runtime, 'GET', `/commands/${receipt.id}`) as CommandReceipt; }
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt)); return receipt;
}
function prepareWorld(x: number, z: number, width: number, depth: number) {
  rcon(`forceload add ${x} ${z} ${x + width} ${z + depth}`);
  for (const [low, high] of [[80, 83], [84, 87], [88, 91]]) rcon(`fill ${x} ${low} ${z} ${x + width} ${high} ${z + depth} air`);
  rcon(`fill ${x} 75 ${z} ${x + width} 78 ${z + depth} dirt`); rcon(`fill ${x} 79 ${z} ${x + width} 79 ${z + depth} grass_block`);
  rcon(`kill @e[type=!player,x=${x},y=75,z=${z},dx=${width},dy=18,dz=${depth}]`);
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('gamerule keepInventory false'); rcon('time set 6000'); rcon('weather clear');
}
async function addPaused(runtime: Runtime, id: string, name: string, actions?: string[]) {
  await command(runtime, 'POST', '/bots', { id, name, role: 'general', ...(actions ? { allowedActions: actions } : {}), connection: { host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline' } });
  await until(runtime, s => s.agents.find(a => a.id === id)?.session?.state === 'ready', `${name} ready`);
  await command(runtime, 'POST', `/bots/${id}/pause`);
}

test('actual support preempts a helpers work, kills the exact threat and preserves the previous task', { timeout: 100000 }, async () => {
  validateServer(); prepareWorld(2496, 2496, 48, 32);
  const dir = mkdtempSync(join(tmpdir(), 'laya-support-live-')), requester = randomUUID(), helper = randomUUID();
  let runtime: Runtime | undefined;
  try {
    runtime = await startRuntime({ runtimeDir: dir, host: '127.0.0.1', port: 0, tickIntervalMs: 100 });
    await command(runtime, 'PATCH', '/rules', { patch: { world: '127.0.0.1:25566', center: { x: 2520, y: 80, z: 2510 }, radius: 48, autonomyEnabled: false } });
    await addPaused(runtime, requester, 'LayaSupportA'); await addPaused(runtime, helper, 'LayaSupportB', ['fight', 'survive', 'recover']);
    for (const [name, x] of [['LayaSupportA', 2516.5], ['LayaSupportB', 2520.5]] as const) { rcon(`tp ${name} ${x} 80 2510.5`); rcon(`clear ${name}`); rcon(`effect give ${name} instant_health 1 10 true`); rcon(`effect give ${name} saturation 1 10 true`); }
    rcon('give LayaSupportB iron_sword'); rcon('give LayaSupportB bread 8');
    rcon('item replace entity LayaSupportB weapon.offhand with shield');
    for (const [slot, item] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']] as const) rcon(`item replace entity LayaSupportB armor.${slot} with iron_${item}`);
    await until(runtime, s => s.agents.every(a => a.session?.report?.health === 20 && a.session.report.food === 20) && !!s.agents.find(a => a.id === helper)?.session?.report?.inventory.some(i => i.name === 'iron_sword'), 'actual helper equipment');
    const keep = await command(runtime, 'POST', '/goals', { kind: 'survive', preferredBotId: helper, title: '지원 전 진행 보존', params: {} });
    const previousId = String((keep.result as { goalId: string }).goalId);
    await command(runtime, 'POST', `/bots/${helper}/resume`);
    await until(runtime, s => s.tasks.some(t => t.goalId === previousId && t.state === 'running'), 'original helper task running');
    await command(runtime, 'POST', `/bots/${requester}/resume`); await delay(3500);
    rcon('summon skeleton 2518.5 80 2513.5 {NoAI:1b,PersistenceRequired:1b,Tags:["laya_support_fixture"],ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}');
    await delay(500);
    const damage = rcon('damage LayaSupportA 2 minecraft:mob_attack by @e[tag=laya_support_fixture,limit=1]'); assert.doesNotMatch(damage, /invulnerable|No entity was found/, damage);
    const state = await until(runtime, s => s.goals.some(g => typeof g.input.params.supportRequestId === 'string' && g.state === 'completed'), 'actual assigned helper kills exact skeleton', 50000);
    const support = state.tasks.find(t => typeof t.params.supportRequestId === 'string'); assert.ok(support);
    assert.ok(state.attempts.some(a => a.taskId === support.id && a.botId === helper && a.state === 'completed'));
    const old = state.tasks.find(t => t.goalId === previousId); assert.ok(old); assert.ok(old.resumeCount > 0); assert.ok(state.attempts.some(a => a.taskId === old.id && ['interrupted', 'cancelled'].includes(a.state)));
    assert.ok(state.observations.some(o => o.kind === 'entity-death' && o.attemptId === support.attemptId && o.data.entityId === support.params.targetEntityId));
    console.log('Actual support verified', JSON.stringify({ helper: 'LayaSupportB', supportTask: support.id, previousTask: old.id, preservedResumeCount: old.resumeCount, targetId: support.params.targetEntityId, completion: state.goals.find(g => g.id === support.goalId)?.state }));
  } finally { await runtime?.close(); rcon('kill @e[tag=laya_support_fixture]'); rcon('forceload remove 2496 2496 2544 2528'); rmSync(dir, { recursive: true, force: true }); }
});

test('actual mob death persists through restart, recovers dropped supplies and returns through a reserved terrain repair to finish the same warehouse', { timeout: 360000 }, async () => {
  validateServer(); prepareWorld(2304, 2272, 64, 96);
  rcon('fill 2334 80 2272 2334 81 2368 dirt');
  const dir = mkdtempSync(join(tmpdir(), 'laya-survival-flow-live-')), botId = randomUUID(), name = 'LayaSurvFlow';
  const options = { runtimeDir: dir, host: '127.0.0.1', port: 0, tickIntervalMs: 100 };
  let runtime: Runtime | undefined;
  try {
    runtime = await startRuntime(options);
    await command(runtime, 'PATCH', '/rules', { patch: { world: '127.0.0.1:25566', center: { x: 2334, y: 80, z: 2317 }, radius: 64, autonomyEnabled: false } });
    await addPaused(runtime, botId, name);
    rcon(`tp ${name} 2325.5 80 2317.5`); rcon(`spawnpoint ${name} 2317 80 2317`); rcon(`clear ${name}`); rcon(`effect give ${name} instant_health 1 10 true`); rcon(`effect give ${name} saturation 1 10 true`);
    const definition = runtime.core.createBlueprint({ title: '복구 검증 창고', template: 'warehouse', width: 5, depth: 5, height: 3, wood: 'oak', materials: { floor: 'oak_planks', wall: 'oak_planks', roof: 'oak_planks', window: 'glass' }, furniture: { chest: true, craftingTable: false, furnace: false, bed: false, lighting: false } });
    const origin = { x: 2338, y: 80, z: 2318 }, expected = blueprint(definition.id, origin, definition.wood, definition);
    const materials = new Map<string, number>(); for (const b of expected) { const item = b.name === 'wall_torch' ? 'torch' : b.name; materials.set(item, (materials.get(item) ?? 0) + 1); }
    for (const [item, count] of materials) rcon(`give ${name} ${item} ${count + 4}`);
    rcon(`give ${name} wooden_pickaxe`); rcon(`give ${name} bread 8`);
    await until(runtime, s => !!s.agents.find(a => a.id === botId)?.session?.report?.inventory.some(i => i.name === 'wooden_pickaxe') && (s.agents.find(a => a.id === botId)?.session?.report?.position?.x ?? 0) > 2324, 'actual pre-death supplies');
    const registered = await command(runtime, 'POST', '/goals', { kind: 'build', title: '같은 창고 복귀', preferredBotId: botId, params: { design: definition.id, origin, siteSelection: 'fixed' } });
    const goalId = String((registered.result as { goalId: string }).goalId);
    const original = (await snapshot(runtime)).goals.find(g => g.id === goalId)!;
    await command(runtime, 'POST', `/bots/${botId}/resume`);
    const running = await until(runtime, s => s.tasks.some(t => t.goalId === goalId && t.state === 'running'), 'original build starts');
    const originalTask = running.tasks.find(t => t.goalId === goalId && t.state === 'running')!;
    await delay(3800);
    rcon(`execute at ${name} run summon husk ~2 ~ ~ {NoAI:1b,PersistenceRequired:1b,Tags:["laya_survival_flow_enemy"]}`); await delay(300);
    console.log('Actual server inventory before death', rcon(`data get entity ${name} Inventory`).trim());
    const damage = rcon(`damage ${name} 40 minecraft:mob_attack by @e[tag=laya_survival_flow_enemy,limit=1]`); assert.doesNotMatch(damage, /invulnerable|No entity was found/, damage);
    const dead = await until(runtime, s => !!s.agents.find(a => a.id === botId)?.deaths?.length && s.agents.find(a => a.id === botId)?.recovery?.phase === 'held', 'death is explicitly recorded and unsafe recovery held', 20000);
    const death = dead.agents.find(a => a.id === botId)!.deaths!.at(-1)!;
    console.log('Actual death inventory', JSON.stringify({ position: death.position, inventory: death.priorInventory }));
    assert.ok(death.priorInventory.some(i => i.name === 'wooden_pickaxe')); assert.ok(death.position);
    assert.ok(dead.events.some(e => e.type === 'bot.died')); assert.ok(dead.tasks.find(t => t.id === originalTask.id));
    await runtime.close(); runtime = undefined;
    // Clear the controlled test threat after recording genuine mob-attributed
    // death. No post-death supplies are given; recovery must pick up real drops.
    rcon('kill @e[tag=laya_survival_flow_enemy]');
    runtime = await startRuntime(options);
    const recovered = await until(runtime, s => { const r = s.agents.find(a => a.id === botId)?.recovery; return r?.phase === 'resolved' && r.safe && r.progress.remainingCount === 0; }, 'restored recovery actually picks up original supplies', 75000);
    const recovery = recovered.agents.find(a => a.id === botId)!.recovery!;
    assert.equal(recovery.deathId, death.deathId); assert.equal(recovered.agents.find(a => a.id === botId)!.deaths!.length, 1); assert.ok(recovery.progress.recoveredCount > 0); assert.equal(recovery.progress.lostCount, 0);
    const done = await until(runtime, s => s.goals.find(g => g.id === goalId)?.state === 'completed', 'same warehouse resumes through approved route repair and completes', 220000);
    const goal = done.goals.find(g => g.id === goalId)!;
    assert.deepEqual(goal.input, original.input); assert.equal(goal.generation, original.generation);
    const parent = done.tasks.find(t => t.id === originalTask.id)!; assert.equal(parent.state, 'completed');
    const child = done.tasks.find(t => t.params.mode === 'prepare-access' && t.params.parentTaskId === parent.id); assert.ok(child); assert.equal(child.state, 'completed'); assert.equal(child.generation, parent.generation); assert.ok(parent.dependencies.includes(child.id));
    assert.ok(done.events.some(e => e.type === 'build.access-planned')); assert.ok((child.checkpoint.accessPreparationProgress as { completedEdits: number }).completedEdits > 0);
    for (const b of expected) assert.match(rcon(`execute if block ${b.position.x} ${b.position.y} ${b.position.z} ${b.name} run list`), /There are .* players online/, `actual warehouse ${JSON.stringify(b)}`);
    console.log('Actual death/restart/return verified', JSON.stringify({ deathId: death.deathId, priorItems: death.priorInventory.reduce((n, i) => n + i.count, 0), recovered: recovery.progress, originalTask: parent.id, accessTask: child.id, accessProgress: child.checkpoint.accessPreparationProgress, goalId, generation: goal.generation, actualBlocks: expected.length, state: goal.state }));
  } finally { await runtime?.close(); rcon('kill @e[tag=laya_survival_flow_enemy]'); rcon('forceload remove 2304 2272 2368 2368'); rmSync(dir, { recursive: true, force: true }); }
});
