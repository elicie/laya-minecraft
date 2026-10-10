import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Movements, pathfinder } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { BotInputSchema, RulesSchema } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { combatEquipment, assessCombat } from '../packages/minecraft/src/combat-policy';
import { safeCombatStand } from '../packages/minecraft/src/combat-retreat';
import { ConditionWait } from '../packages/minecraft/src/services';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, seconds = 10) { const end = Date.now() + seconds * 1000; while (!predicate() && Date.now() < end) await delay(100); assert.ok(predicate(), 'Timed out waiting for actual validation observations.'); }

test('unarmed ranged defense retreats along actual higher ground into observed cover without terrain changes', { timeout: 100000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  assert.equal(rcon('list').includes('LayaCombatCheck'), false);
  rcon('forceload add 1888 1888 1952 1952');
  rcon('fill 1888 80 1888 1919 91 1952 air'); rcon('fill 1920 80 1888 1952 91 1952 air');
  rcon('fill 1888 77 1888 1952 79 1952 stone');
  rcon('fill 1888 80 1888 1915 80 1952 stone');
  rcon('fill 1916 80 1904 1916 84 1936 stone_bricks');
  rcon('kill @e[type=!player,x=1888,y=77,z=1888,dx=64,dy=16,dz=64]');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaCombatCheck', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn');
    rcon('tp LayaCombatCheck 1920.5 80 1920.5'); rcon('clear LayaCombatCheck');
    rcon('effect give LayaCombatCheck minecraft:instant_health 1 10 true'); rcon('effect give LayaCombatCheck minecraft:saturation 1 10 true');
    await waitFor(() => bot.health === 20 && bot.food === 20 && bot.entity.position.distanceTo(new Vec3(1920.5, 80, 1920.5)) < 0.1 && !!bot.blockAt(new Vec3(1902, 80, 1920)));
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 1;
    bot.pathfinder.setMovements(movements);
    rcon('summon skeleton 1922.5 80 1920.5 {NoAI:1b,Silent:1b,Invulnerable:1b,PersistenceRequired:1b}');
    await waitFor(() => Object.values(bot.entities).some(entity => entity.name === 'skeleton' && entity.position.distanceTo(bot.entity.position) < 4));
    const target = Object.values(bot.entities).find(entity => entity.name === 'skeleton' && entity.position.distanceTo(bot.entity.position) < 4)!;
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', autonomyEnabled: false }), { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaCombatCheck' });
    const equipment = combatEquipment(bot);
    assert.equal(equipment.weapon, false); assert.equal(equipment.shield, false);
    assert.equal(assessCombat({ role: 'builder', health: bot.health, food: bot.food, ...equipment, enemies: 1, allies: 0, attacked: true, threateningVillage: false, targetName: 'skeleton', distance: bot.entity.position.distanceTo(target.position) }, rules).response, 'retreat');
    const executor = new MineflayerExecutor(bot, { world: rules.world, dimension: () => 'overworld', config, rules });
    const services = executor.services(AbortSignal.timeout(60000)), start = bot.entity.position.clone();
    await assert.rejects(executor.fightEntity(target, services), error => error instanceof ConditionWait && /지원과 회복/.test(error.message));
    const actual = bot.entity.position, recovery = services.checkpoint.retreatRecovery as { status: string; attempts: number; elapsedMs: number; probes: { position: { x: number; y: number; z: number }; name: string }[] };
    assert.equal(recovery.status, 'safe', JSON.stringify(services.checkpoint)); assert.ok(recovery.attempts <= 6);
    assert.ok(actual.distanceTo(start) >= 6); assert.equal(Math.floor(actual.y), 81); assert.ok(actual.x < 1916);
    assert.ok(actual.distanceTo(target.position) >= 8); assert.equal(safeCombatStand(bot, actual), true);
    const eye = target.position.offset(0, 1.6, 0), delta = actual.offset(0, 1.5, 0).minus(eye);
    assert.ok(bot.world.raycast(eye, delta.scaled(1 / delta.norm()), delta.norm() - 0.3), 'actual solid cover must block the ranged line of sight');
    for (const p of [new Vec3(1916, 80, 1904), new Vec3(1916, 84, 1920), new Vec3(1902, 80, 1920), new Vec3(1920, 79, 1920)]) assert.ok(bot.blockAt(p)?.boundingBox === 'block');
    assert.equal(bot.inventory.items().length, 0);
    console.log('Verified actual bounded combat retreat', JSON.stringify({ start, actual, threat: target.position, health: bot.health, food: bot.food, actualCover: true, status: recovery.status, attempts: recovery.attempts, elapsedMs: recovery.elapsedMs, probeCount: recovery.probes.length, probes: recovery.probes.slice(0, 3) }));
  } finally { bot.quit('combat validation complete'); await delay(200); rcon('kill @e[type=skeleton,x=1888,y=77,z=1888,dx=64,dy=16,dz=64]'); rcon('forceload remove 1888 1888 1952 1952'); }
});
