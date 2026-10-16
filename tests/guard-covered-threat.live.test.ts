import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder } from 'mineflayer-pathfinder';
import { WorkerLaunchSchema, type WorkerMessage } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MinecraftWorker } from '../packages/minecraft/src/worker';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean) { const until = Date.now() + 15000; while (!check() && Date.now() < until) await sleep(50); assert.ok(check(), 'Actual guard observation timed out.'); }

test('a real guard stays under a roof when a phantom is hidden and reacts when an actual roof opening reveals it', { timeout: 45000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const cycle = /true/.test(rcon('gamerule doDaylightCycle')), spawning = /true/.test(rcon('gamerule doMobSpawning'));
  const name = 'LayaRoofGuard', tag = `laya_roof_${Date.now()}`, messages: WorkerMessage[] = [];
  rcon('forceload add 35984 35984 36016 36016');
  rcon('fill 35984 77 35984 36016 79 36016 stone'); rcon('fill 35984 80 35984 36016 89 36016 air');
  rcon('execute positioned 36000 80 36000 run kill @e[type=!player,distance=..24]');
  rcon('fill 35998 80 35998 36002 83 36002 stone hollow');
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 14000');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline', username: name });
  bot.loadPlugin(pathfinder);
  const launch = WorkerLaunchSchema.parse({ botId: 'roof-guard', sessionId: 'roof-session', controllerEpoch: 'roof-live', config: { name, role: 'guard', allowedActions: ['guard','fight','home','survive'], connection: { host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline' } }, rules: { world: '127.0.0.1:25566', center: { x: 36000, y: 80, z: 36000 }, radius: 16, autonomyEnabled: false } });
  const worker = new MinecraftWorker(launch, bot, message => messages.push(message), { timers: false });
  try {
    await once(bot,'spawn'); rcon(`gamemode survival ${name}`); rcon(`clear ${name}`); rcon(`tp ${name} 36000.5 80 36000.5`);
    rcon(`give ${name} wooden_sword 1`); rcon(`effect give ${name} instant_health 1 10 true`); rcon(`effect give ${name} saturation 1 10 true`);
    await waitFor(() => bot.health === 20 && bot.food === 20 && bot.inventory.items().some(item => item.name === 'wooden_sword') && bot.entity.position.distanceTo(new Vec3(36000.5,80,36000.5)) < .1);
    rcon(`summon phantom 36000.5 85 36000.5 {Tags:["${tag}"],NoAI:1b,PersistenceRequired:1b,Silent:1b}`);
    await waitFor(() => Object.values(bot.entities).some(entity => entity.name === 'phantom'));
    const start = bot.entity.position.clone();
    for (let i = 0; i < 12; i++) { worker.pollSafety(); await sleep(100); }
    assert.equal(messages.some(message => message.type === 'safety.alert'), false);
    assert.ok(bot.entity.position.distanceTo(start) < .1); assert.equal(bot.health,20);
    rcon('setblock 36000 83 36000 air'); await waitFor(() => bot.blockAt(new Vec3(36000,83,36000))?.name === 'air');
    worker.pollSafety(); await waitFor(() => messages.some(message => message.type === 'safety.alert' && message.payload.response === 'attack'));
    console.log('Actual covered threat verified', JSON.stringify({ hiddenPhantomIgnored: true, actualPositionPreserved: true, actualRoofOpeningTriggersDefense: true, productionWorld: false }));
  } finally {
    await worker.shutdown('covered threat fixture complete'); rcon(`kill @e[tag=${tag}]`);
    rcon(`gamerule doDaylightCycle ${cycle}`); rcon(`gamerule doMobSpawning ${spawning}`); rcon('forceload remove 35984 35984 36016 36016');
  }
});
