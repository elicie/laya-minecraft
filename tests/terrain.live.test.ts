import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { BotInputSchema, RulesSchema, preparationSiteCells, isBuildSiteAir, isBuildSiteGround, validateBuildSitePreparation, type BuildSitePreparation, type TaskSpec } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { executeVillageTask } from '../packages/minecraft/src/village-actions';
import { observePreparation } from '../packages/minecraft/src/terrain';

const host = process.env.MC_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function rcon(command: string) { return execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' }); }

test('natural lumpy terrain is only proposed during exploration, then reserved preparation escapes, cuts, fills and proves the site', { timeout: 240000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  rcon('forceload add 1392 1392 1440 1440');
  rcon('fill 1400 75 1400 1424 79 1424 dirt'); rcon('fill 1400 80 1400 1424 90 1424 air');
  rcon('kill @e[type=!player,x=1400,y=75,z=1400,dx=24,dy=16,dz=24]');
  for (let x = 1400; x <= 1424; x++) {
    const top = x % 3 === 0 ? 80 : x % 3 === 1 ? 79 : 78;
    if (top === 78) rcon(`fill ${x} 79 1400 ${x} 79 1424 short_grass`);
    rcon(`fill ${x} ${top} 1400 ${x} ${top} 1424 grass_block`);
  }
  // The real reported failure has a west drop, an east two-high soil edge,
  // and one-high north/south edges. No items or tools are supplied.
  rcon('setblock 1412 79 1412 grass_block');
  rcon('setblock 1413 80 1412 dirt'); rcon('setblock 1413 81 1412 grass_block');
  rcon('setblock 1412 79 1411 dirt'); rcon('setblock 1412 80 1411 grass_block'); rcon('setblock 1412 79 1413 dirt'); rcon('setblock 1412 80 1413 grass_block');
  rcon('fill 1411 78 1412 1411 79 1412 air'); rcon('setblock 1411 77 1412 grass_block');
  rcon('setblock 1407 81 1407 short_grass');
  rcon('setblock 1410 81 1415 tall_grass[half=lower]'); rcon('setblock 1410 82 1415 tall_grass[half=upper]');
  rcon('gamerule doMobSpawning false'); rcon('gamerule doDaylightCycle false'); rcon('time set 6000'); rcon('weather clear');
  const bot = await createCompatibleBot({ host, port: 25566, version: '1.21.1', username: 'LayaTerrainTest', auth: 'offline' });
  bot.loadPlugin(pathfinder); bot.on('error', error => console.error(error.message));
  try {
    await once(bot, 'spawn'); rcon('tp LayaTerrainTest 1412.5 80 1412.5'); rcon('clear LayaTerrainTest');
    await sleep(800);
    const loadedUntil = Date.now() + 10000;
    while (!bot.blockAt(new Vec3(1412, 76, 1412)) && Date.now() < loadedUntil) await sleep(100);
    assert.equal(bot.inventory.items().length, 0); assert.equal(bot.blockAt(new Vec3(1412, 79, 1412))?.name, 'grass_block');
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 3; bot.pathfinder.setMovements(movements);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', center: { x: 1412, y: 80, z: 1412 }, radius: 32, autonomyEnabled: false });
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaTerrainTest', connection: { host, port: 25566, version: '1.21.1' } });
    const executor = new MineflayerExecutor(bot, { world: rules.world, dimension: () => 'overworld', rules, config, villageTask: executeVillageTask, onProgress: (action, reason) => console.log(action, reason) });
    const explore: TaskSpec = { id: 'terrain-site', goalId: 'terrain-warehouse', kind: 'explore', source: 'user', params: { mode: 'build-site', design: 'warehouse', allowPreparation: true, searchRadius: 8 }, completion: { kind: 'exploration', resourceNames: [], minVisits: 1 }, dependencies: [], reservationKeys: [] };
    const services = executor.services(AbortSignal.timeout(180000));
    const proposed = await executor.execute(explore, services), plan = proposed.checkpoint.buildSitePreparation as BuildSitePreparation;
    assert.equal(proposed.outcome, 'completed', proposed.reason); assert.ok(plan);
    assert.ok(plan.edits.some(e => e.after === 'air')); assert.ok(plan.edits.some(e => e.after === 'dirt'));
    assert.ok(validateBuildSitePreparation(plan, observePreparation(services, plan)).ok);
    for (const edit of plan.edits) assert.equal(bot.blockAt(new Vec3(edit.position.x, edit.position.y, edit.position.z))?.name, edit.before, 'exploration must leave every actual block unchanged');
    assert.equal(bot.inventory.items().length, 0); assert.equal(proposed.checkpoint.buildSite, undefined);
    console.log('Observed preparation proposal', JSON.stringify({ origin: plan.origin, path: plan.path, edits: plan.edits }));
    const prepare: TaskSpec = { ...explore, id: 'terrain-prepare', kind: 'build', params: { mode: 'prepare-site', preparation: plan } };
    const prepared = await executor.execute(prepare, services);
    assert.equal(prepared.outcome, 'completed', `${prepared.reason} ${JSON.stringify(prepared.checkpoint)}`);
    for (const cell of preparationSiteCells(plan)) {
      const name = bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name;
      assert.ok(name && (cell.requirement === 'air' ? isBuildSiteAir(name) : isBuildSiteGround(name)), `whole site proof ${JSON.stringify(cell)}=${name}`);
    }
    assert.equal(bot.blockAt(new Vec3(1412, 79, 1412))?.name, 'grass_block', 'the original trapped support must remain');
    assert.ok(bot.entity.position.distanceTo(new Vec3(plan.entrance.x + 0.5, plan.entrance.y, plan.entrance.z + 0.5)) <= 1.5);
    const progress = prepared.checkpoint.preparationProgress as { completedEdits: number; totalEdits: number; excavated: number; filled: number; pathIndex: number; pathLength: number };
    assert.equal(progress.completedEdits, progress.totalEdits); assert.ok(progress.excavated > 0); assert.ok(progress.filled > 0); assert.equal(progress.pathIndex, progress.pathLength);
    console.log('Verified actual prepared site', JSON.stringify({ site: prepared.checkpoint.buildSite, progress, position: bot.entity.position, inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) }));
  } finally {
    const ended = once(bot, 'end'); bot.quit('Disposable terrain preparation validation finished');
    await Promise.race([ended, sleep(1000)]); rcon('forceload remove 1392 1392 1440 1440');
  }
});
