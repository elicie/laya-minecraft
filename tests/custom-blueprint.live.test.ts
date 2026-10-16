import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { BlueprintInputSchema, RulesSchema, blueprint, materialRequirements, type BlueprintDefinition, type CentralMessage, type CommandReceipt } from '../packages/contracts/src';
import { FleetController } from '../packages/core/src';
import { createControlServer } from '../apps/server/src/control-server';
import { ControlStore } from '../apps/server/src/store';
import { MineflayerExecutor, createCompatibleBot, executeVillageTask } from '../packages/minecraft/src';

const host = process.env.MC_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const headers = () => ({ 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': randomUUID() });

test('registered edited blueprint is centrally pinned and its real building matches changed size, materials and omitted furniture', { timeout: 240000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  rcon('forceload add 1600 1600 1632 1632'); rcon('fill 1600 80 1600 1620 89 1620 air'); rcon('fill 1600 76 1600 1620 78 1620 dirt'); rcon('fill 1600 79 1600 1620 79 1620 grass_block');
  rcon('kill @e[type=!player,x=1600,y=76,z=1600,dx=20,dy=14,dz=20]');
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 6000'); rcon('weather clear');
  const bot = await createCompatibleBot({ host, port: 25566, version: '1.21.1', username: 'LayaCustomTest', auth: 'offline' }); bot.loadPlugin(pathfinder);
  const store = new ControlStore(':memory:'); let api: ReturnType<typeof createControlServer> | undefined, heartbeat: NodeJS.Timeout | undefined;
  try {
    await once(bot, 'spawn'); rcon('tp LayaCustomTest 1602.5 80 1604.5'); rcon('clear LayaCustomTest'); await sleep(700);
    const until = Date.now() + 10000;
    while (!bot.blockAt(new Vec3(1610, 79, 1610)) && Date.now() < until) await sleep(100);
    assert.equal(bot.blockAt(new Vec3(1610, 79, 1610))?.name, 'grass_block');
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 3; bot.pathfinder.setMovements(movements);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', center: { x: 1610, y: 80, z: 1610 }, radius: 64, autonomyEnabled: false });
    const sent: CentralMessage[] = [];
    const core = new FleetController({ rules, send(_id, message) { sent.push(message); }, onChange(snapshot, event) { api?.observe(snapshot, event); } });
    api = createControlServer({ core, store, port: 0 }); const address = await api.listen(), base = `http://127.0.0.1:${address.port}`;
    const edited = BlueprintInputSchema.parse({ title: '라이브 편집 돌집', template: 'cabin', width: 6, depth: 5, height: 3, wood: 'birch', materials: { floor: 'polished_andesite', wall: 'stone_bricks', roof: 'birch_planks', window: 'glass' }, furniture: { chest: false, craftingTable: false, furnace: false, bed: false, lighting: false } });
    const registered = await fetch(`${base}/api/v1/blueprints`, { method: 'POST', headers: headers(), body: JSON.stringify(edited) }); assert.equal(registered.status, 202); assert.equal((await registered.json() as CommandReceipt).state, 'applied');
    const catalog = await (await fetch(`${base}/api/v1/blueprints`)).json() as BlueprintDefinition[]; const definition = catalog[0]!;
    assert.equal(definition.width, 6); assert.equal(definition.version, 1);
    const origin = { x: 1605, y: 80, z: 1605 }, expected = blueprint(definition.id, origin, 'oak', definition);
    for (const [item, quantity] of Object.entries(materialRequirements(expected))) rcon(`give LayaCustomTest ${item} ${quantity}`); await sleep(300);
    const agent = core.addAgent({ name: 'LayaCustomTest', connection: { host, port: 25566, version: '1.21.1', auth: 'offline' } }); core.startSession(agent.id, 'custom-live-session');
    const envelope = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({ protocolVersion: 1, messageId: randomUUID(), botId: agent.id, sessionId: 'custom-live-session', controllerEpoch: core.controllerEpoch, sentAt: Date.now(), type, payload, ...extra });
    const report = () => ({ ready: true, world: rules.world, dimension: rules.dimension, position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }, health: bot.health, food: bot.food, inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })), action: 'build', reason: '전용 서버 실제 편집 도면 검증', mode: 'working', capabilities: ['build'], rulesVersion: core.getSnapshot().rules.version });
    core.onWorkerMessage(envelope('bot.ready', { ...report(), mode: 'idle' })); core.onWorkerMessage(envelope('rules.applied', { version: core.getSnapshot().rules.version }));
    heartbeat = setInterval(() => core.onWorkerMessage(envelope('bot.status', report())), 1000);
    const requested = await fetch(`${base}/api/v1/goals`, { method: 'POST', headers: headers(), body: JSON.stringify({ kind: 'build', source: 'user', preferredBotId: agent.id, params: { blueprint: definition.id, siteSelection: 'fixed', origin } }) }); assert.equal(requested.status, 202);
    const assignment = sent.find((message): message is Extract<CentralMessage, { type: 'task.assign' }> => message.type === 'task.assign'); assert.ok(assignment, JSON.stringify(core.getSnapshot().goals));
    assert.deepEqual(assignment.payload.task.params.blueprintDefinition, definition);
    const goalId = assignment.payload.task.goalId;
    // Editing/removing the catalog during the assignment cannot change its plan.
    const change = await fetch(`${base}/api/v1/blueprints/${definition.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ ...edited, title: '나중에 바꾼 집', width: 7, materials: { ...edited.materials, wall: 'oak_planks' } }) }); assert.equal(change.status, 202);
    const remove = await fetch(`${base}/api/v1/blueprints/${definition.id}`, { method: 'DELETE', headers: headers(), body: '{}' }); assert.equal(remove.status, 202);
    assert.deepEqual(core.getSnapshot().goals.find(g => g.id === goalId)?.input.params.blueprintDefinition, definition);
    const extra = { taskId: assignment.taskId, attemptId: assignment.attemptId };
    core.onWorkerMessage(envelope('task.accepted', {}, extra)); core.onWorkerMessage(envelope('task.started', {}, extra));
    const executor = new MineflayerExecutor(bot, { world: rules.world, dimension: () => rules.dimension, rules, config: agent.config, villageTask: executeVillageTask, onProgress(action, reason) { console.log(action, reason); } });
    const services = executor.services(AbortSignal.timeout(180000), assignment.payload.checkpoint);
    const result = await executor.execute(assignment.payload.task, services); assert.equal(result.outcome, 'completed', `${result.reason} ${JSON.stringify(result.checkpoint)}`);
    for (const block of expected) assert.equal(bot.blockAt(new Vec3(block.position.x, block.position.y, block.position.z))?.name, block.name, JSON.stringify(block));
    assert.ok(!expected.some(b => ['chest', 'crafting_table', 'furnace', 'white_bed', 'wall_torch'].includes(b.name)));
    assert.ok(Math.abs(bot.entity.position.y - origin.y) < 0.1); assert.ok(bot.entity.position.x < origin.x || bot.entity.position.x >= origin.x + 6 || bot.entity.position.z < origin.z || bot.entity.position.z >= origin.z + 5);
    core.onWorkerMessage(envelope('task.result', result, extra)); assert.equal(core.getSnapshot().goals.find(g => g.id === goalId)?.state, 'completed');
    console.log('Verified registered custom blueprint actual cells', expected.length, JSON.stringify({ id: definition.id, version: definition.version, width: definition.width, depth: definition.depth, height: definition.height, actualPosition: bot.entity.position, catalogCount: core.getSnapshot().blueprints.length }));
  } finally {
    if (heartbeat) clearInterval(heartbeat); if (api) await api.close(); store.close();
    const ended = once(bot, 'end'); bot.quit('Disposable custom blueprint validation finished'); await Promise.race([ended, sleep(1000)]); rcon('forceload remove 1600 1600 1632 1632');
  }
});
