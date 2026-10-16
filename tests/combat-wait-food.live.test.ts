import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder } from 'mineflayer-pathfinder';
import type { Bot } from 'mineflayer';
import { WorkerLaunchSchema, type WorkerMessage } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MinecraftWorker } from '../packages/minecraft/src/worker';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, seconds = 15) {
  const until = Date.now() + seconds * 1000;
  while (!check() && Date.now() < until) await sleep(25);
  assert.ok(check(), 'Actual validation observation timed out.');
}

test('an injured real guard eats after a blocked retreat threat disappears', { timeout: 60000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const cycle = /true/.test(rcon('gamerule doDaylightCycle'));
  const spawning = /true/.test(rcon('gamerule doMobSpawning'));
  const name = 'LayaWaitFoodLive', tag = `laya_wait_food_${Date.now()}`;
  const messages: WorkerMessage[] = [];
  let bot: Bot | undefined, worker: MinecraftWorker | undefined;
  rcon('forceload add 33984 33984 34016 34016');
  rcon('fill 33984 77 33984 34016 79 34016 stone');
  rcon('fill 33984 80 33984 34016 88 34016 air');
  rcon('execute positioned 34000 80 34000 run kill @e[type=!player,distance=..24]');
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 1000');
  // A real enclosed footing leaves no ground escape to the distant threat.
  rcon('fill 33999 80 33999 34001 83 34001 glass hollow');
  try {
    bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline', username: name });
    bot.loadPlugin(pathfinder);
    const launch = WorkerLaunchSchema.parse({ botId: 'wait-food', sessionId: 'wait-session', controllerEpoch: 'wait-live', config: { name, role: 'guard', connection: { host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline' } }, rules: { world: '127.0.0.1:25566', center: { x: 34000, y: 80, z: 34000 }, radius: 20, autonomyEnabled: false } });
    worker = new MinecraftWorker(launch, bot, message => messages.push(message), { timers: false });
    await once(bot, 'spawn');
    rcon(`gamemode survival ${name}`); rcon(`clear ${name}`); rcon(`tp ${name} 34000.5 80 34000.5`);
    rcon(`effect give ${name} instant_health 1 10 true`); rcon(`effect give ${name} saturation 1 10 true`);
    await waitFor(() => bot!.health === 20 && bot!.food === 20 && bot!.entity.position.distanceTo(new Vec3(34000.5,80,34000.5)) < .1);
    await sleep(3500);
    rcon(`effect give ${name} hunger 60 255 true`); await waitFor(() => bot!.food <= 17); rcon(`effect clear ${name}`);
    assert.equal(bot.food, 17);
    rcon(`damage ${name} 19 minecraft:generic`); await waitFor(() => bot!.health === 1);
    rcon(`give ${name} bread 1`); await waitFor(() => bot!.inventory.items().some(item => item.name === 'bread'));
    rcon(`summon husk 34004.5 80 34000.5 {Tags:["${tag}"],NoAI:1b,PersistenceRequired:1b,Silent:1b,IsBaby:0b}`);
    await waitFor(() => Object.values(bot!.entities).some(entity => entity.name === 'husk'));
    worker.pollSafety();
    await waitFor(() => messages.some(message => message.type === 'safety.alert' && message.payload.reason.includes('안전한 대응을 확인하지 못했습니다')));
    assert.equal(bot.food, 17); assert.equal(bot.health, 1);
    rcon(`kill @e[tag=${tag}]`); await waitFor(() => !Object.values(bot!.entities).some(entity => entity.name === 'husk'));
    const deadline = Date.now() + 12000;
    while (bot.food < 18 && Date.now() < deadline) { worker.pollSafety(); await sleep(100); }
    await waitFor(() => bot!.food === 20 && !bot!.inventory.items().some(item => item.name === 'bread'));
    assert.equal(bot.food, 20); assert.equal(bot.inventory.items().some(item => item.name === 'bread'), false);
    assert.ok(bot.health > 0); assert.ok(messages.some(message => message.type === 'bot.status' && message.payload.survivalRecovery));
    console.log('Actual critical retreat wait recovery', JSON.stringify({ initialHealth: 1, initialFood: 17, breadActuallyEaten: 1, finalFood: bot.food, finalHealth: bot.health, productionWorld: false, fixtureItems: true }));
  } finally {
    if (worker) await worker.shutdown('combat wait food fixture complete'); else bot?.quit('fixture complete');
    rcon(`kill @e[tag=${tag}]`); rcon(`gamerule doDaylightCycle ${cycle}`); rcon(`gamerule doMobSpawning ${spawning}`);
    rcon('forceload remove 33984 33984 34016 34016');
  }
});
