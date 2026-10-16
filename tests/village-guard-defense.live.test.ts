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
import { combatEquipment } from '../packages/minecraft/src/combat-policy';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, seconds = 15) {
  const until = Date.now() + seconds * 1000;
  while (!check() && Date.now() < until) await sleep(50);
  assert.ok(check(), 'Actual validation observation timed out.');
}

test('two wooden-sword guards respond before being hit and stop a real melee mob approaching an unarmed villager', { timeout: 60000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const cycle = /true/.test(rcon('gamerule doDaylightCycle'));
  const spawning = /true/.test(rcon('gamerule doMobSpawning'));
  const tag = `laya_guard_${process.pid}_${Date.now()}`;
  const bots: Bot[] = [], workers: MinecraftWorker[] = [], messages: WorkerMessage[][] = [[], []], firstResponseHealth: number[] = [];
  let actualDeath = false;
  rcon('forceload add 28992 28992 29040 29040');
  rcon('fill 28992 77 28992 29040 79 29040 stone');
  rcon('fill 28992 80 28992 29040 88 29040 air');
  rcon('execute positioned 29016 80 29016 run kill @e[type=!player,distance=..38]');
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 1000');
  try {
    for (const [index, name] of ['LayaGuardLive1', 'LayaGuardLive2', 'LayaVillagerLive'].entries()) {
      const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline', username: name });
      bots.push(bot); bot.loadPlugin(pathfinder);
      if (index < 2) {
        const launch = WorkerLaunchSchema.parse({ botId: `guard-${index}`, sessionId: `session-${index}`, controllerEpoch: 'guard-live', config: { name, role: 'guard', connection: { host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline' } }, rules: { world: '127.0.0.1:25566', center: { x: 29012, y: 80, z: 29011 }, radius: 24, autonomyEnabled: false } });
        workers.push(new MinecraftWorker(launch, bot, message => {
          messages[index]!.push(message);
          if (message.type === 'safety.alert' && message.payload.response === 'attack') firstResponseHealth[index] ??= bot.health;
        }, { timers: false }));
      }
      await once(bot, 'spawn');
      rcon(`gamemode survival ${name}`); rcon(`clear ${name}`);
      const p = index === 2 ? new Vec3(29014.5, 80, 29010.5) : new Vec3(29010.5, 80, 29010.5 + index * 2);
      rcon(`tp ${name} ${p.x} ${p.y} ${p.z}`);
      rcon(`effect give ${name} minecraft:instant_health 1 10 true`);
      rcon(`effect give ${name} minecraft:saturation 1 10 true`);
      if (index < 2) rcon(`give ${name} wooden_sword 1`);
      await waitFor(() => bot.entity.position.distanceTo(p) < .1 && bot.health === 20 && bot.food === 20 && (index === 2 || combatEquipment(bot).weapon));
    }
    for (const bot of bots.slice(0, 2)) {
      assert.deepEqual(combatEquipment(bot), { weapon: true, shield: false, armorPoints: 0 });
      bot.on('entityDead', entity => { if (entity.name === 'husk') actualDeath = true; });
    }
    const minimumHealth = bots.map(bot => bot.health);
    for (const [index, bot] of bots.entries()) bot.on('health', () => { minimumHealth[index] = Math.min(minimumHealth[index]!, bot.health); });
    rcon(`summon husk 29017.5 80 29010.5 {Tags:["${tag}"],PersistenceRequired:1b,Silent:1b,IsBaby:0b}`);
    await waitFor(() => bots.slice(0, 2).every(bot => Object.values(bot.entities).some(entity => entity.name === 'husk')));
    const deadline = Date.now() + 30000;
    while (!actualDeath && Date.now() < deadline) { for (const worker of workers) worker.pollSafety(); await sleep(100); }
    assert.equal(actualDeath, true, 'The clients must receive the real mob death.');
    for (const log of messages) assert.ok(log.some(message => message.type === 'safety.alert' && message.payload.response === 'attack'), 'Each guard must proactively respond through its real worker.');
    assert.deepEqual(firstResponseHealth, [20, 20], 'Both guards must respond before taking damage themselves.');
    assert.ok(minimumHealth.every(health => health > 6), JSON.stringify(minimumHealth));
    assert.equal(bots[2]!.inventory.items().length, 0, 'The protected villager remains unarmed.');
    const remaining = rcon(`execute if entity @e[type=husk,tag=${tag}] run say guard_validation_target_remaining`);
    assert.equal(remaining.includes('guard_validation_target_remaining'), false, remaining);
    console.log('Actual village guard defense', JSON.stringify({ guards: 2, gear: 'wooden_sword; no armor or shield', target: 'one active adult husk', serverConfirmedGone: true, bothWorkersResponded: true, firstResponseHealth, minimumHealth, suppliedFixtureEquipment: true, version: '1.21.1', productionWorld: false, noModelTraining: true }));
  } finally {
    await Promise.allSettled(workers.map(worker => worker.shutdown('guard defense validation complete')));
    bots[2]?.quit('guard defense validation complete');
    await sleep(150);
    rcon(`kill @e[type=husk,tag=${tag}]`);
    rcon('forceload remove 28992 28992 29040 29040');
    rcon(`gamerule doDaylightCycle ${cycle}`); rcon(`gamerule doMobSpawning ${spawning}`); rcon('time set 1000');
  }
});
