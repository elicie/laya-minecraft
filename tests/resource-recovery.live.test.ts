import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { BotInputSchema, RulesSchema } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ResourceRecovery } from '../packages/minecraft/src/resource-recovery';

if ((process.env.MC_HOST ?? '127.0.0.1') !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, reason: string) { const end = Date.now() + 10000; while (!check()) { if (Date.now() >= end) throw new Error(reason); await sleep(100); } }

test('actual bounded surface recovery preserves inaccessible stone and walks to newly observed stone and food', { timeout: 180000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
  const origin = new Vec3(1718.5, 80, 1718.5), buried = new Vec3(1722, 76, 1718), source = new Vec3(1762, 80, 1718);
  rcon('forceload add 1712 1712 1776 1742');
  rcon('fill 1712 80 1712 1776 85 1742 air'); rcon('fill 1712 75 1712 1776 78 1742 dirt'); rcon('fill 1712 79 1712 1776 79 1742 grass_block');
  rcon('setblock 1722 76 1718 stone');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaResCheck', auth: 'offline', viewDistance: 2 }); bot.loadPlugin(pathfinder); bot.on('error', error => console.error(error.message));
  let revealTimer: NodeJS.Timeout | undefined;
  try {
    await once(bot, 'spawn'); rcon('tp LayaResCheck 1718.5 80 1718.5'); rcon('clear LayaResCheck'); rcon('item replace entity LayaResCheck hotbar.0 with wooden_pickaxe');
    await until(() => bot.entity.position.distanceTo(origin) < 1 && bot.blockAt(buried)?.name === 'stone' && bot.inventory.items().some(i => i.name === 'wooden_pickaxe'), 'initial actual fixture was not observed');
    await sleep(1000); assert.ok(!bot.blockAt(source) || bot.blockAt(source)?.name === 'air', 'the distant source does not exist before actual recovery movement');
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 1; bot.pathfinder.setMovements(movements);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', center: null, autonomyEnabled: false });
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaResCheck', connection: { host: '127.0.0.1', port: 25566, version: '1.21.1' } });
    const executor = new MineflayerExecutor(bot, { config, rules, world: rules.world, dimension: () => 'overworld', onProgress: (action, reason) => console.log(action, reason) });
    const services = executor.services(AbortSignal.timeout(120000));
    // The validation server sends this chunk even with tiny view distance.
    // Reveal a real source only after actual walking, rather than mocking the
    // library's chunk cache or claiming loaded terrain was unknown.
    let revealed = false;
    revealTimer = setInterval(() => { if (!revealed && bot.entity.position.distanceTo(origin) >= 4) { revealed = true; rcon('setblock 1762 80 1718 stone'); } }, 100);
    await executor.ensureItem('cobblestone', 1, services);
    clearInterval(revealTimer); revealTimer = undefined; assert.equal(revealed, true);
    assert.equal(executor.count('cobblestone'), 1); assert.equal(bot.blockAt(source)?.name, 'air'); assert.equal(bot.blockAt(buried)?.name, 'stone');
    assert.ok(services.observations.some(o => o.kind === 'exploration' && o.data.resources.some(r => r.position.x === source.x && r.name === 'stone')));
    assert.ok(services.observations.some(o => o.kind === 'inventory' && o.data.items.some(i => i.name === 'cobblestone' && i.count >= 1)));
    console.log('Verified actual resource recovery', JSON.stringify({ checkpoint: services.checkpoint.resourceRecovery, position: bot.entity.position, inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) }));
    rcon('tp LayaResCheck 1718.5 80 1718.5'); rcon('clear LayaResCheck'); rcon('effect give LayaResCheck instant_health 1 10 true');
    await until(() => bot.entity.position.distanceTo(origin) < 1 && bot.health >= 20 && bot.inventory.items().length === 0, 'food fixture was not restored');
    rcon('effect give LayaResCheck hunger 1 255 true'); await sleep(1600); rcon('effect clear LayaResCheck hunger'); rcon('damage LayaResCheck 15 minecraft:generic');
    await until(() => bot.health <= rules.combat.retreatHealth, 'critical actual health report was not observed');
    const foodServices = executor.services(AbortSignal.timeout(60000));
    let foodRevealed = false;
    revealTimer = setInterval(() => { if (!foodRevealed && bot.entity.position.distanceTo(origin) >= 4) { foodRevealed = true; rcon('setblock 1762 79 1718 farmland[moisture=7]'); rcon('setblock 1762 80 1718 potatoes[age=7]'); } }, 100);
    await executor.ensureFood(foodServices); clearInterval(revealTimer); revealTimer = undefined;
    assert.equal(foodRevealed, true); assert.ok(executor.count('potato') >= 1); assert.equal(bot.blockAt(source)?.name, 'air');
    assert.ok(foodServices.observations.some(o => o.kind === 'exploration' && o.data.resources.some(r => r.name === 'potatoes' && r.position.x === source.x)));
    assert.equal(bot.blockAt(buried)?.name, 'stone');
    console.log('Verified actual critical-health food recovery', JSON.stringify({ health: bot.health, food: bot.food, position: bot.entity.position, inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) }));
    const beforeFood = bot.food, beforePotato = executor.count('potato');
    assert.equal(await executor.eat(foodServices), true);
    await until(() => bot.food > beforeFood && executor.count('potato') < beforePotato, 'actual consumption did not increase food and decrease potatoes');
    console.log('Verified actual potato consumption', JSON.stringify({ beforeFood, afterFood: bot.food, beforePotato, afterPotato: executor.count('potato') }));
  } finally {
    clearInterval(revealTimer);
    const ended = once(bot, 'end'); bot.quit('disposable resource recovery validation complete'); await Promise.race([ended, sleep(1000)]); rcon('forceload remove 1712 1712 1776 1742');
  }
});

test('an actual collect task with a spent distant-origin checkpoint starts a new resource journey and obtains real cobblestone', { timeout: 90000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
  const origin = new Vec3(4906.5,80,4906.5), source = new Vec3(4970,80,4906);
  rcon('forceload add 4898 4898 4982 4922'); rcon('fill 4898 80 4898 4982 85 4922 air');
  rcon('fill 4898 77 4898 4982 78 4922 dirt'); rcon('fill 4898 79 4898 4982 79 4922 grass_block'); rcon('setblock 4970 80 4906 stone');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaRawJourney', auth: 'offline' }); bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn'); rcon('tp LayaRawJourney 4906.5 80 4906.5'); rcon('clear LayaRawJourney'); rcon('item replace entity LayaRawJourney hotbar.0 with wooden_pickaxe');
    await until(() => bot.entity.position.distanceTo(origin) < 1 && bot.inventory.items().some(item => item.name === 'wooden_pickaxe') && bot.blockAt(origin.floored().offset(0,-1,0))?.name === 'grass_block', 'actual resource journey start is missing');
    const movement = new Movements(bot); movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; movement.maxDropDown = 1; bot.pathfinder.setMovements(movement);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', center: null, autonomyEnabled: false });
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaRawJourney' });
    const executor = new MineflayerExecutor(bot, { config, rules, world: rules.world, dimension: () => 'overworld', onProgress: (action, reason) => console.log(action, reason) });
    const services = executor.services(AbortSignal.timeout(70000));
    // Restore a genuinely different saved search region, without issuing a
    // fresh local budget. A pickaxe is provided; the stone is actually mined.
    const old = new ResourceRecovery(bot, services, 'cobblestone', ['stone','cobblestone'], true, () => false);
    old.state.origin = { x: 4800, y: 80, z: 4906 }; old.state.destinationsUsed = 5; old.state.elapsedMs = 60000; old.wait('preserved spent local search', 1);
    const result = await executor.execute({ id: 'collect', goalId: 'preserved-goal', kind: 'collect', params: { item: 'cobblestone', quantity: 1 }, dependencies: [], reservationKeys: [], completion: { kind: 'manual', reason: 'actual inventory proof' } }, services);
    assert.equal(result.outcome, 'completed'); assert.equal(executor.count('cobblestone'), 1); assert.equal(bot.blockAt(source)?.name, 'air');
    const state = (services.checkpoint.resourceRecovery as Record<string, ResourceRecovery['state']>).cobblestone;
    assert.deepEqual(state.origin, { x: 4800, y: 80, z: 4906 }); assert.ok(state.resourceJourney && state.resourceJourney.moves >= 1);
    assert.ok(services.observations.some(o => o.kind === 'inventory' && o.data.items.some(item => item.name === 'cobblestone' && item.count === 1)));
    console.log('Verified actual raw resource journey', JSON.stringify({ savedOrigin: state.origin, initialPosition: origin, actualPosition: bot.entity.position, journeyMoves: state.resourceJourney.moves, cobblestone: executor.count('cobblestone') }));
  } finally { const ended = once(bot, 'end'); bot.quit('disposable raw resource journey validation complete'); await Promise.race([ended,sleep(1000)]); rcon('forceload remove 4898 4898 4982 4922'); }
});
