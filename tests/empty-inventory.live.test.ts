import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { BotInputSchema, RulesSchema, type Position } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';

const host = process.env.MC_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function rcon(command: string) { return execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' }); }

test('empty inventory gathers natural logs, crafts its table and pickaxe, then returns to mine stone', { timeout: 180000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  rcon('forceload add 1296 1296 1328 1328');
  rcon('fill 1300 80 1300 1324 90 1324 air');
  rcon('fill 1300 77 1300 1324 78 1324 dirt');
  rcon('fill 1300 79 1300 1324 79 1324 grass_block');
  rcon('kill @e[type=!player,x=1300,y=79,z=1300,dx=24,dy=12,dz=24]');
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 6000'); rcon('weather clear');
  const stone = new Vec3(1306, 80, 1306), logs = [80, 81, 82].map(y => new Vec3(1309, y, 1310));
  rcon(`setblock ${stone.x} ${stone.y} ${stone.z} stone`);
  for (const p of logs) rcon(`setblock ${p.x} ${p.y} ${p.z} oak_log`);
  rcon('setblock 1309 84 1310 oak_leaves[persistent=true]');
  const bot = await createCompatibleBot({ host, port: 25566, version: '1.21.1', username: 'LayaEmptySource', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  bot.on('error', error => console.error(error.message));
  try {
    await once(bot, 'spawn'); rcon('tp LayaEmptySource 1302.5 80 1302.5'); rcon('clear LayaEmptySource');
    const loadedUntil = Date.now() + 10000;
    while ((!bot.blockAt(stone) || !bot.blockAt(logs[2])) && Date.now() < loadedUntil) await sleep(100);
    await sleep(800);
    assert.equal(bot.blockAt(stone)?.name, 'stone'); assert.equal(bot.inventory.items().length, 0);
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false;
    movements.allowParkour = false; movements.maxDropDown = 3; bot.pathfinder.setMovements(movements);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', center: { x: 1310, y: 80, z: 1310 }, radius: 32, autonomyEnabled: false });
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaEmptySource', connection: { host, port: 25566, version: '1.21.1' } });
    const executor = new MineflayerExecutor(bot, { world: rules.world, dimension: () => 'overworld', rules, config,
      onProgress: (action, reason) => console.log(action, reason) });
    const services = executor.services(AbortSignal.timeout(120000));
    try { await executor.ensureItem('cobblestone', 1, services); }
    catch (error) {
      console.error('Actual resource pipeline failure', JSON.stringify({
        reason: error instanceof Error ? error.message : String(error), checkpoint: services.checkpoint,
        position: bot.entity.position, inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
        logs: logs.map(p => ({ position: p, actual: bot.blockAt(p)?.name })),
        drops: Object.values(bot.entities).filter(e => e.name === 'item').map(e => ({ id: e.id, position: e.position, metadata: e.metadata })),
      }));
      throw error;
    }
    const tablePosition = services.checkpoint.crafting_tablePosition as Position;
    assert.ok(tablePosition, 'the actual bootstrap must have placed its own table');
    assert.equal(bot.blockAt(new Vec3(tablePosition.x, tablePosition.y, tablePosition.z))?.name, 'crafting_table');
    assert.equal(executor.count('wooden_pickaxe'), 1); assert.equal(executor.count('cobblestone'), 1);
    assert.equal(bot.blockAt(stone)?.name, 'air');
    assert.ok(logs.every(p => bot.blockAt(p)?.name === 'air'), 'all three source logs must have been acquired naturally');
    assert.ok(services.observations.some(o => o.kind === 'inventory' && o.data.items.some(i => i.name === 'cobblestone' && i.count >= 1)));
    console.log('Verified actual empty-inventory resource pipeline', JSON.stringify({ tablePosition, inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) }));
  } finally {
    const ended = once(bot, 'end'); bot.quit('Disposable empty-inventory resource validation finished');
    await Promise.race([ended, sleep(1000)]);
    rcon('forceload remove 1296 1296 1328 1328');
  }
});
