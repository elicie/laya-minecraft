import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import { pathfinder } from 'mineflayer-pathfinder';
import { WorkerLaunchSchema, type WorkerMessage } from '../packages/contracts/src';
import { blueprint } from '../packages/contracts/src/blueprints';
import { warehouseShelter } from '../packages/core/src/warehouse-shelter';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MinecraftWorker } from '../packages/minecraft/src/worker';
if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, seconds = 15) { const until = Date.now() + seconds * 1000; while (!check() && Date.now() < until) await sleep(50); assert.ok(check(), 'Actual validation observation timed out.'); }

test('a restored healthy reserve episode walks to its actual registered warehouse, then takes and eats one real bread', { timeout: 70000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const cycle = /true/.test(rcon('gamerule doDaylightCycle')), spawning = /true/.test(rcon('gamerule doMobSpawning'));
  const name = 'LayaReserveLive', origin = { x: 30205, y: 80, z: 30205 }, blocks = blueprint('warehouse', origin);
  const container = { id: 'reserve-warehouse', world: '127.0.0.1:25566', dimension: 'overworld', position: { x: 30206, y: 81, z: 30206 } }, base = warehouseShelter(container, blocks)!;
  const connection = { host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline' as const, username: name };
  rcon('forceload add 30192 30192 30240 30240'); rcon('fill 30192 77 30192 30240 79 30240 stone'); rcon('fill 30192 80 30192 30240 88 30240 air');
  rcon('execute positioned 30216 80 30216 run kill @e[type=!player,distance=..38]'); rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 1000');
  for (const b of blocks.filter(b => !b.name.endsWith('_door') && b.name !== 'wall_torch')) rcon(`setblock ${b.position.x} ${b.position.y} ${b.position.z} ${b.name}`);
  rcon(`setblock ${base.door.x} ${base.door.y} ${base.door.z} oak_door[facing=south,half=lower,open=false]`); rcon(`setblock ${base.door.x} ${base.door.y + 1} ${base.door.z} oak_door[facing=south,half=upper,open=false]`);
  for (const b of blocks.filter(b => b.name === 'wall_torch')) rcon(`setblock ${b.position.x} ${b.position.y} ${b.position.z} wall_torch[facing=${b.position.x === origin.x + 1 ? 'east' : 'west'}]`);
  rcon(`item replace block ${container.position.x} ${container.position.y} ${container.position.z} container.0 with bread 8`);
  let prep: Awaited<ReturnType<typeof createCompatibleBot>> | undefined, bot: typeof prep, worker: MinecraftWorker | undefined;
  try {
    prep = await createCompatibleBot(connection); await once(prep, 'spawn');
    rcon(`gamemode survival ${name}`); rcon(`tp ${name} ${base.outside.x + .5} ${base.outside.y} ${base.outside.z - 10 + .5}`); rcon(`clear ${name}`); rcon(`effect clear ${name}`);
    rcon(`effect give ${name} instant_health 1 10 true`); rcon(`effect give ${name} saturation 1 10 true`); await sleep(1200);
    rcon(`effect give ${name} hunger 60 255 true`); await waitFor(() => prep!.food <= 18); rcon(`effect clear ${name}`); assert.equal(prep.food, 18); assert.equal(prep.health, 20);
    const ended = once(prep, 'end'); prep.quit('save actual reserve hunger'); await ended; prep = undefined; await sleep(300);
    bot = await createCompatibleBot(connection); bot.loadPlugin(pathfinder);
    const budget = { destinationsUsed: 13, elapsedMs: 180000 }, messages: WorkerMessage[] = [];
    const launch = WorkerLaunchSchema.parse({ botId: 'reserve-live', sessionId: 'reserve-session', controllerEpoch: 'reserve-epoch', config: { name, connection: { host: connection.host, port: connection.port, version: connection.version, auth: connection.auth } }, rules: { world: container.world, warehouse: container, baseShelter: base, autonomyEnabled: false }, restoreSurvivalRecovery: { startedAt: Date.now() - 1000, targetHealth: 20, checkpoint: { expeditionFoodTarget: 19, resourceRecovery: { $food: budget } } } });
    worker = new MinecraftWorker(launch, bot, message => messages.push(message), { timers: false }); await once(bot, 'spawn');
    await waitFor(() => messages.some(message => message.type === 'bot.ready') && bot!.entity.onGround === true && blocks.every(block => bot!.blockAt(new Vec3(block.position.x, block.position.y, block.position.z))?.name === block.name)); assert.equal(bot.food, 18); assert.equal(bot.health, 20);
    const task = { id: 'base-return', goalId: 'base-return-goal', kind: 'home', params: { position: base.inside, radius: 1.5, basePassage: 'inside' }, completion: { kind: 'position', position: base.inside, radius: 1.5 }, dependencies: [], reservationKeys: [] };
    const assign = (id: string, t = task) => ({ protocolVersion: 1, messageId: randomUUID(), controllerEpoch: launch.controllerEpoch, botId: launch.botId, sessionId: launch.sessionId, sentAt: Date.now(), type: 'task.assign', taskId: t.id, attemptId: id, payload: { task: t, checkpoint: {}, rulesVersion: launch.rules.version } });
    await worker.receive(assign('ordinary-rejected', { ...task, id: 'ordinary-home', params: { ...task.params, position: { x: 30230, y: 80, z: 30230 } } }));
    assert.ok(messages.some(message => message.type === 'task.rejected' && message.attemptId === 'ordinary-rejected'));
    await worker.receive(assign('actual-return'));
    const deadline = Date.now() + 25000;
    while (!messages.some(message => message.type === 'task.result' && message.attemptId === 'actual-return') && Date.now() < deadline) { worker.pollSafety(); await sleep(100); }
    const result = messages.find((message): message is Extract<WorkerMessage, { type: 'task.result' }> => message.type === 'task.result' && message.attemptId === 'actual-return');
    assert.ok(result); assert.equal(result.payload.outcome, 'completed', JSON.stringify({ reason: result.payload.reason, checkpoint: result.payload.checkpoint, position: bot.entity.position })); assert.equal(bot.food, 18);
    assert.ok(bot.entity.position.distanceTo(new Vec3(base.inside.x, base.inside.y, base.inside.z)) <= 1.5);
    const ready = messages.find((message): message is Extract<WorkerMessage, { type: 'bot.ready' }> => message.type === 'bot.ready')!;
    assert.deepEqual((ready.payload.survivalRecovery!.checkpoint.resourceRecovery as { $food: unknown }).$food, budget);
    for (let i = 0; i < 120 && bot.food < 19; i++) { worker.pollSafety(); await sleep(100); }
    await waitFor(() => bot!.food === 20 && bot!.inventory.items().filter(item => item.name === 'bread').reduce((sum, item) => sum + item.count, 0) === 0);
    assert.equal(bot.food, 20); assert.equal(bot.health, 20); assert.equal(bot.inventory.items().filter(item => item.name === 'bread').reduce((sum, item) => sum + item.count, 0), 0);
    const chest = await bot.openContainer(bot.blockAt(new Vec3(container.position.x, container.position.y, container.position.z))!);
    try { assert.equal(chest.containerItems().filter(item => item.name === 'bread').reduce((sum, item) => sum + item.count, 0), 7); }
    finally { await chest.close(); }
    assert.ok(blocks.every(block => bot!.blockAt(new Vec3(block.position.x, block.position.y, block.position.z))?.name === block.name));
    console.log('Actual reserve return', JSON.stringify({ restoredFood: 18, ordinaryDestinationRejected: true, actualBaseReturnCompleted: true, actualBreadTakenAndEaten: 1, finalFood: bot.food, health: bot.health, originalFoodBudget: budget, fixtureBreadSupplied: true, productionWorld: false }));
  } finally {
    prep?.quit('reserve fixture complete'); if (worker) await worker.shutdown('reserve return validation complete'); else bot?.quit('reserve fixture complete'); await sleep(150);
    rcon('forceload remove 30192 30192 30240 30240'); rcon(`gamerule doDaylightCycle ${cycle}`); rcon(`gamerule doMobSpawning ${spawning}`); rcon('time set 1000');
  }
});
