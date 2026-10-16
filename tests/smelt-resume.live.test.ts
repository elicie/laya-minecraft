import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { WorkerLaunchSchema, type TaskSpec } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { inventory } from '../packages/minecraft/src/observations';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, seconds = 15) {
  const until = Date.now() + seconds * 1000;
  while (!check() && Date.now() < until) await sleep(50);
  assert.ok(check(), 'Actual validation observation timed out.');
}

test('an actual six-sand batch resumes from its saved furnace after interruption and a fresh executor', { timeout: 100000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const cycle = /true/.test(rcon('gamerule doDaylightCycle'));
  const spawning = /true/.test(rcon('gamerule doMobSpawning'));
  const name = 'LayaSmeltResume', furnacePosition = { x: 35002, y: 80, z: 35000 };
  rcon('forceload add 34992 34992 35016 35016');
  rcon('fill 34992 77 34992 35016 79 35016 stone'); rcon('fill 34992 80 34992 35016 86 35016 air');
  rcon('execute positioned 35000 80 35000 run kill @e[type=!player,distance=..20]');
  rcon('setblock 35002 80 35000 furnace');
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 1000');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline', username: name });
  bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn'); rcon(`gamemode survival ${name}`); rcon(`clear ${name}`); rcon(`tp ${name} 35000.5 80 35000.5`);
    rcon(`give ${name} sand 6`); rcon(`give ${name} coal 1`);
    rcon(`effect give ${name} instant_health 1 10 true`); rcon(`effect give ${name} saturation 1 10 true`);
    const count = (item: string) => inventory(bot).filter(stack => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
    await waitFor(() => count('sand') === 6 && count('coal') === 1 && bot.entity.position.distanceTo(new Vec3(35000.5,80,35000.5)) < .1 && bot.blockAt(new Vec3(35002,80,35000))?.name === 'furnace');
    const movement = new Movements(bot); movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; bot.pathfinder.setMovements(movement);
    const launch = WorkerLaunchSchema.parse({ botId: 'smelt-resume', sessionId: 'smelt-session', controllerEpoch: 'smelt-live', config: { name, connection: { host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline' }, allowedActions: ['smelt'] }, rules: { world: '127.0.0.1:25566', autonomyEnabled: false } });
    let lastProgress = '';
    const options = { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => 'overworld', onProgress: (action: string, reason: string) => { if (reason !== lastProgress) { lastProgress = reason; console.log('Actual smelt progress', action, reason); } } };
    const first = new MineflayerExecutor(bot, options), abort = new AbortController();
    const services = first.services(abort.signal, { furnacePosition });
    const task: TaskSpec = { id: 'same-task', goalId: 'same-goal', kind: 'smelt', params: { item: 'glass' }, dependencies: [], reservationKeys: [], completion: { kind: 'inventory', item: 'glass', minimum: 6 } };
    let firstError: { code?: string } | undefined;
    const interrupted = first.execute(task, services).then(() => false, error => { firstError = error; return true; });
    try { await waitFor(() => count('glass') === 3 || !!firstError, 45); }
    catch (error) { console.log('Interrupted batch diagnostic', JSON.stringify({ inventory: bot.inventory.items(), checkpoint: services.checkpoint, firstError, furnace: rcon('data get block 35002 80 35000') })); abort.abort(); await interrupted; throw error; }
    assert.equal(firstError, undefined); abort.abort('fixture-night-interruption'); assert.equal(await interrupted, true); assert.equal((firstError as { code?: string } | undefined)?.code, 'CANCELLED');
    assert.equal(count('sand'), 0); assert.equal(count('glass'), 3);
    const checkpoint = JSON.parse(JSON.stringify(services.checkpoint));
    const second = new MineflayerExecutor(bot, options), resumed = second.services(AbortSignal.timeout(55000), checkpoint);
    await second.execute(task, resumed);
    await waitFor(() => count('glass') === 6);
    assert.equal(count('sand'), 0); assert.equal(count('glass'), 6);
    const window = await bot.openFurnace(bot.blockAt(new Vec3(35002,80,35000))!);
    try { assert.equal(window.inputItem(), null); assert.equal(window.outputItem(), null); } finally { window.close(); }
    console.log('Actual interrupted batch recovered', JSON.stringify({ originalSand: 6, collectedBeforeInterruption: 3, finalGlass: count('glass'), extraSandGathered: 0, freshExecutor: true, fixtureMaterials: true, productionWorld: false }));
  } finally {
    bot.quit('smelt resume fixture complete'); await sleep(200);
    rcon(`gamerule doDaylightCycle ${cycle}`); rcon(`gamerule doMobSpawning ${spawning}`); rcon('forceload remove 34992 34992 35016 35016');
  }
});
