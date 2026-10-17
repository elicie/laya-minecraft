import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { BotInputSchema, RulesSchema, type TaskSpec } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { executeVillageTask } from '../packages/minecraft/src/village-actions';
if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('real farming crosses a torch on the only dry bank, harvests and replants without removing the light', { timeout: 70000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const start = { x: 29010, y: 80, z: 29010 }, plot = { x: 29022, y: 79, z: 29010 }, torch = new Vec3(29016, 80, 29010), origin = { x: 29021, y: 79, z: 29011 };
  rcon('forceload add 29000 29000 29031 29031');
  rcon('fill 29000 79 29000 29031 85 29031 air');
  rcon('fill 29000 78 29000 29031 78 29031 stone');
  rcon('fill 29000 79 29000 29031 79 29031 water');
  rcon('fill 29010 79 29010 29024 79 29010 stone');
  rcon('setblock 29016 80 29010 torch');
  rcon('setblock 29022 79 29010 farmland[moisture=7]');
  rcon('setblock 29022 80 29010 wheat[age=7]');
  rcon('execute positioned 29016 80 29010 run kill @e[type=!player,distance=..25]');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', auth: 'offline', username: 'LayaTorchFarm' });
  bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn');
    rcon('tp LayaTorchFarm 29010.5 80 29010.5'); rcon('clear LayaTorchFarm'); rcon('give LayaTorchFarm wheat_seeds 1');
    for (let i = 0; i < 160 && (bot.entity.position.distanceTo(new Vec3(29010.5, 80, 29010.5)) > .1 || !bot.entity.onGround || !bot.inventory.items().some(i => i.name === 'wheat_seeds')); i++) await sleep(50);
    const movements = new Movements(bot);
    movements.canDig = false; movements.canOpenDoors = true; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 2; movements.infiniteLiquidDropdownDistance = false; movements.scafoldingBlocks = []; movements.blocksToAvoid.add(bot.registry.blocksByName.farmland!.id);
    bot.pathfinder.setMovements(movements);
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaTorchFarm' }), rules = RulesSchema.parse({ autonomyEnabled: false });
    const executor = new MineflayerExecutor(bot, { config, rules, world: rules.world, dimension: () => 'overworld', villageTask: executeVillageTask });
    const task: TaskSpec = { id: 'torch-farm', goalId: 'torch-farm', source: 'user', kind: 'farm', params: { id: 'torch-bank', origin, positions: [plot], plots: 1, crop: 'wheat', mode: 'harvest', quantity: 1 }, completion: { kind: 'farm', crop: 'wheat', plots: 1, mode: 'harvest', quantity: 1, baseline: 0 }, dependencies: [], reservationKeys: [] };
    const deadline = AbortSignal.timeout(45000);
    let result = await executor.execute(task, executor.services(deadline, { farmAccessOrigin: start }));
    for (let retry = 0; result.outcome === 'condition-wait' && result.checkpoint.farmPendingHarvest && retry < 3; retry++) {
      await sleep(500); result = await executor.execute(task, executor.services(deadline, result.checkpoint));
    }
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.ok(executor.count('wheat') >= 1);
    assert.equal(bot.blockAt(new Vec3(plot.x, plot.y + 1, plot.z))?.name, 'wheat');
    assert.equal(bot.blockAt(torch)?.name, 'torch');
    for (let x = start.x; x <= 29024; x++) assert.equal(bot.blockAt(new Vec3(x, 79, 29010))?.name, x === plot.x ? 'farmland' : 'stone');
    assert.equal(bot.blockAt(new Vec3(origin.x, origin.y, origin.z))?.name, 'water');
    assert.equal(executor.count('torch'), 0); assert.equal(bot.health, 20);
    console.log('Actual torch-bank farming', JSON.stringify({ actualHarvest: executor.count('wheat'), replanted: true, installedTorchRetained: true, bankUnchanged: true, health: bot.health, fixtureItemsAndMaturity: true, productionWorld: false }));
  } finally { bot.quit('torch clearance validation complete'); await sleep(200); rcon('forceload remove 29000 29000 29031 29031'); }
});
