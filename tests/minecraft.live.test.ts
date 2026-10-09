import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { BotInputSchema, RulesSchema, type TaskSpec } from '../packages/contracts/src';
import { blueprint, materialRequirements } from '../packages/contracts/src/blueprints';
import { MineflayerExecutor, createCompatibleBot, createBotViewer, executeVillageTask } from '../packages/minecraft/src';

const host = process.env.MC_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
function rcon(command: string) { return execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' }); }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function task(kind: TaskSpec['kind'], params: TaskSpec['params'], completion: TaskSpec['completion']): TaskSpec {
  return { id: `${kind}-live`, goalId: 'live', source: 'user', kind, params, completion, dependencies: [], reservationKeys: [] };
}

test('disposable Minecraft validates real collection, delivery, crafting, farming, construction, breeding and viewer', { timeout: 300000 }, async t => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  rcon('forceload add 1184 1184 1232 1232');
  rcon('fill 1184 80 1184 1232 90 1232 air');
  rcon('fill 1184 77 1184 1232 78 1232 dirt');
  rcon('fill 1184 79 1184 1232 79 1232 grass_block');
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 6000'); rcon('weather clear');
  rcon('kill @e[type=!player,x=1184,y=79,z=1184,dx=48,dy=12,dz=48]');
  rcon('setblock 1200 80 1200 chest');
  rcon('item replace block 1200 80 1200 container.0 with minecraft:oak_log 10');
  for (let n = 0; n < 22; n++) {
    const x = 1188 + n % 11, z = 1194 + Math.floor(n / 11) * 2;
    rcon(`setblock ${x} 80 ${z} oak_log`); rcon(`setblock ${x} 83 ${z} oak_leaves[persistent=true]`);
  }
  const bot = await createCompatibleBot({ host, port: 25566, version: '1.21.1', username: 'LayaLiveCheck', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  bot.on('error', error => console.error(error.message));
  try {
    await once(bot, 'spawn');
    rcon('tp LayaLiveCheck 1202.5 80 1200.5'); rcon('clear LayaLiveCheck'); rcon('give LayaLiveCheck iron_axe'); rcon('give LayaLiveCheck bread 32');
    // The disposable server has a small view distance; wait for our actual
    // fixture cells rather than requiring every chunk in a 5x5 square.
    await sleep(800);
    const loadedUntil = Date.now() + 10000;
    while ((!bot.blockAt(new Vec3(1200, 80, 1200)) || !bot.blockAt(new Vec3(1216, 80, 1200))) && Date.now() < loadedUntil) await sleep(100);
    assert.equal(bot.blockAt(new Vec3(1200, 80, 1200))?.name, 'chest');
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false;
    movements.blocksToAvoid.add(bot.registry.blocksByName.farmland.id); bot.pathfinder.setMovements(movements);
    const warehouse = { id: 'live-chest', position: { x: 1200, y: 80, z: 1200 }, world: '127.0.0.1:25566', dimension: 'overworld' };
    const rules = RulesSchema.parse({ center: { x: 1208, y: 80, z: 1208 }, radius: 64, warehouse, autonomyEnabled: false });
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaLiveCheck', connection: { host, port: 25566, version: '1.21.1' } });
    const executor = new MineflayerExecutor(bot, { world: rules.world, dimension: () => 'overworld', rules, config, villageTask: executeVillageTask, onProgress: process.env.MC_LIVE_VERBOSE ? (action, reason) => console.log(action, reason) : undefined });
    const services = () => executor.services(AbortSignal.timeout(180000));
    async function resumeWork(work: TaskSpec) {
      const state = services();
      for (let n = 0; n < 12; n++) {
        state.observations = []; state.evidence = [];
        const result = await executor.execute(work, state);
        if (result.outcome === 'completed') return result;
        if (result.outcome !== 'condition-wait' && result.outcome !== 'partial') throw new Error(JSON.stringify(result));
        console.log('Rechecking actual conditions:', work.kind, result.reason);
        await sleep(1000);
      }
      throw new Error(`${work.kind} did not complete: ${JSON.stringify(state.checkpoint)}`);
    }
    const scenario = (name: string, run: () => Promise<void>) => t.test(name, { skip: !!process.env.MC_LIVE_CASE && !name.includes(process.env.MC_LIVE_CASE) }, run);
    await scenario('collect the missing 22 logs and verify exact 32 in the real warehouse', async () => {
      const before = await executor.observeContainer(warehouse, services());
      assert.equal(before.kind === 'container' && before.data.items.find(i => i.name === 'oak_log')?.count, 10);
      const acquired = await executor.execute(task('collect', { item: 'oak_log', quantity: 22 }, { kind: 'inventory', item: 'oak_log', minimum: 22 }), services());
      assert.equal(acquired.outcome, 'completed'); assert.equal(executor.count('oak_log'), 22);
      const stored = await executor.execute(task('store', { item: 'oak_log', quantity: 22, destination: warehouse }, { kind: 'transfer', container: warehouse, item: 'oak_log', quantity: 22, direction: 'store' }), services());
      assert.equal(stored.evidence[0]?.kind, 'transfer');
      const actual = await executor.observeContainer(warehouse, services());
      assert.equal(actual.kind === 'container' && actual.data.items.find(i => i.name === 'oak_log')?.count, 32); assert.equal(executor.count('oak_log'), 0);
    });
    await scenario('craft uses the public recipe API and verifies actual inventory', async () => {
      rcon('give LayaLiveCheck oak_log 2'); await sleep(250);
      if (process.env.MC_LIVE_VERBOSE) console.log('Craft starting inventory', bot.currentWindow?.type, executor.count('oak_log'), bot.inventory.items().map(i => [i.name, i.count]));
      const result = await executor.execute(task('craft', { item: 'oak_planks', quantity: 8 }, { kind: 'inventory', item: 'oak_planks', minimum: 8 }), services());
      assert.equal(result.outcome, 'completed'); assert.equal(executor.count('oak_planks'), 8);
    });
    await scenario('eight plots are watered, hoed and planted through public interaction APIs', async () => {
      rcon('give LayaLiveCheck iron_hoe'); rcon('give LayaLiveCheck water_bucket'); rcon('give LayaLiveCheck wheat_seeds 16'); await sleep(250);
      const result = await resumeWork(task('farm', { crop: 'wheat', mode: 'setup', origin: { x: 1206, y: 79, z: 1206 }, plots: 8 }, { kind: 'farm', mode: 'setup', crop: 'wheat', plots: 8 }));
      assert.equal(result.outcome, 'completed', JSON.stringify(result));
      assert.equal(bot.blockAt(new Vec3(1206, 79, 1206))?.name, 'water');
      for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (x || z) assert.equal(bot.blockAt(new Vec3(1206 + x, 80, 1206 + z))?.name, 'wheat');
      for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (x || z) rcon(`setblock ${1206 + x} 80 ${1206 + z} wheat[age=7]`);
      await sleep(300);
      const harvested = await resumeWork(task('farm', { crop: 'wheat', mode: 'harvest', origin: { x: 1206, y: 79, z: 1206 }, plots: 8, quantity: 4 }, { kind: 'farm', mode: 'harvest', crop: 'wheat', plots: 8, quantity: 4, baseline: 0 }));
      assert.ok(harvested.observations.some(o => o.kind === 'farm' && o.data.harvested >= 4));
      const delivered = await executor.execute(task('store', { item: 'wheat', quantity: 4, destination: warehouse }, { kind: 'transfer', container: warehouse, item: 'wheat', quantity: 4, direction: 'store' }), services());
      assert.equal(delivered.evidence[0]?.quantity, 4);
      const stock = await executor.observeContainer(warehouse, services());
      assert.equal(stock.kind === 'container' && stock.data.items.find(i => i.name === 'wheat')?.count, 4);
    });
    await scenario('cabin verifies its complete server-observed footprint including bed and door', async () => {
      const blocks = blueprint('cabin', { x: 1216, y: 80, z: 1200 });
      for (const [item, amount] of Object.entries(materialRequirements(blocks))) rcon(`give LayaLiveCheck ${item} ${amount}`);
      await sleep(250);
      const result = await resumeWork(task('build', { requiredBlocks: blocks }, { kind: 'blocks', blocks }));
      assert.equal(result.outcome, 'completed');
      for (const cell of blocks) assert.equal(bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name, cell.name);
      const feet = bot.entity.position;
      assert.ok(Math.abs(feet.y - 80) < 0.1, `builder must finish on safe ground: ${feet}`);
      assert.ok(feet.x < 1216 || feet.x >= 1221 || feet.z < 1200 || feet.z >= 1205, `builder must leave the completed footprint: ${feet}`);
      const standing = feet.floored();
      assert.equal(bot.blockAt(standing.offset(0, -1, 0))?.boundingBox, 'block');
      assert.equal(bot.blockAt(standing)?.boundingBox, 'empty');
      assert.equal(bot.blockAt(standing.offset(0, 1, 0))?.boundingBox, 'empty');
    });
    await scenario('feeding is followed by a newly observed baby entity', async () => {
      rcon('fill 1203 80 1211 1209 80 1217 oak_fence outline');
      rcon('fill 1205 80 1211 1207 80 1211 air');
      rcon('summon cow 1205 80 1213 {Age:0,PersistenceRequired:1b}'); rcon('summon cow 1207 80 1214 {Age:0,PersistenceRequired:1b}');
      rcon('give LayaLiveCheck wheat 4'); rcon('tp LayaLiveCheck 1206.5 80 1213.5'); await sleep(500);
      const result = await resumeWork(task('breed', { animal: 'cow', position: { x: 1206, y: 80, z: 1214 } }, { kind: 'breeding', animal: 'cow', minimum: 1 }));
      assert.equal(result.outcome, 'completed', JSON.stringify({ result, animals: Object.values(bot.entities).filter(e => e.name === 'cow').map(e => ({ name: e.name, position: e.position, metadata: e.metadata })) })); assert.equal(result.observations.filter(o => o.kind === 'breeding').length, 1);
    });
    await scenario('viewer serves real 3D assets without adding or replacing any Mineflayer methods', async () => {
      const originalMethods = { blockAt: bot.blockAt, getColumn: bot.world.getColumn, attack: bot.attack };
      const viewer = await createBotViewer(bot, { port: 4199, prefix: '/viewer/live-check' });
      try {
        assert.equal((await fetch('http://127.0.0.1:4199/viewer/live-check/')).status, 200);
        assert.equal(bot.blockAt, originalMethods.blockAt); assert.equal(bot.world.getColumn, originalMethods.getColumn); assert.equal(bot.attack, originalMethods.attack);
      } finally { viewer.close(); }
    });
  } finally { bot.pathfinder.setGoal(null); bot.quit('live validation finished'); }
});
