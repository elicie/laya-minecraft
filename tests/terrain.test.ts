import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { RulesSchema, buildSiteCells, isBuildSiteAir, isBuildSiteGround, validateBuildSitePreparation, type BuildSitePreparation, type Position, type TaskSpec } from '../packages/contracts/src';
import { findBuildSitePreparation, intersectsBotBody, observePreparation, prepareBuildSite } from '../packages/minecraft/src/terrain';
import { executeVillageTask, exploreBuildSite } from '../packages/minecraft/src/village-actions';
import { ActionFailure, ConditionWait, checkAbort, type ActionServices } from '../packages/minecraft/src/services';

const key = (p: Position) => `${p.x},${p.y},${p.z}`;
function fixture() {
  const cells = new Map<string, string>(), stock = new Map<string, number>(), dug: Position[] = [], placed: Position[] = [], visited: Position[] = [];
  let abortAt = Infinity;
  const controller = new AbortController();
  const top = (x: number, z: number) => x === 0 && z === 0 ? 63 : Math.abs(x) + Math.abs(z) === 1 ? 65 : 63 + ((x % 3 + z % 3 + 6) % 3 - 1);
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) }, pathfinder: { setGoal() {} }, clearControlStates() {},
    inventory: { items: () => [...stock].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count, type: 1 })) },
    blockAt(p: Vec3) {
      const name = cells.get(key(p)) ?? (p.y <= top(p.x, p.z) ? p.y === top(p.x, p.z) ? 'grass_block' : 'dirt' : 'air');
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true };
    },
    async dig(block: { position: Vec3; name: string }) { dug.push({ x: block.position.x, y: block.position.y, z: block.position.z }); cells.set(key(block.position), 'air'); if (block.name === 'dirt' || block.name === 'grass_block') stock.set('dirt', (stock.get('dirt') ?? 0) + 1); if (dug.length >= abortAt) controller.abort(); },
  };
  const services: ActionServices = {
    bot: bot as unknown as Bot, rules: RulesSchema.parse({ center: { x: 0, y: 64, z: 0 }, radius: 32 }), signal: controller.signal,
    checkpoint: {}, observations: [], evidence: [], check: () => checkAbort(controller.signal), pause: async () => {},
    async near(p) {
      const feet = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      assert.ok(isBuildSiteGround(bot.blockAt(feet.offset(0, -1, 0)).name), 'walking requires actual support');
      assert.ok(isBuildSiteAir(bot.blockAt(feet).name)); assert.ok(isBuildSiteAir(bot.blockAt(feet.offset(0, 1, 0)).name), 'blocked cell must be cleared before navigation');
      bot.entity.position = new Vec3(p.x, p.y, p.z); visited.push({ ...p });
    },
    async ensureItem(name) { throw new Error(`fixture must acquire ${name} from actual excavation`); },
    async place(p) { assert.ok((stock.get('dirt') ?? 0) > 0); placed.push(p); cells.set(key(p), 'dirt'); stock.set('dirt', stock.get('dirt')! - 1); },
    observeInventory: () => ({ id: `inv-${Date.now()}`, kind: 'inventory', observedAt: Date.now(), world: services.rules.world, dimension: services.rules.dimension, data: { items: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) } }),
    progress() {},
  };
  const explore: TaskSpec = { id: 'site', goalId: 'warehouse', kind: 'explore', source: 'user', params: { mode: 'build-site', design: 'cabin', searchRadius: 6 }, completion: { kind: 'exploration', resourceNames: [], minVisits: 1 }, reservationKeys: [], dependencies: [] };
  const prep = (plan: BuildSitePreparation): TaskSpec => ({ ...explore, id: 'prep', kind: 'build', params: { mode: 'prepare-site', preparation: plan } });
  return { cells, stock, dug, placed, visited, controller, bot, services, explore, prep, set abortAt(value: number) { abortAt = value; } };
}

test('terrain exploration proposes observed shallow cut and fill with an escape route without any world effects', async () => {
  const f = fixture();
  const result = await exploreBuildSite(f.explore, f.services);
  assert.equal(result.outcome, 'completed'); assert.equal(result.checkpoint.buildSite, undefined);
  const plan = result.checkpoint.buildSitePreparation as BuildSitePreparation;
  assert.ok(plan); assert.ok(plan.edits.some(e => e.after === 'air')); assert.ok(plan.edits.some(e => e.after === 'dirt'));
  assert.deepEqual(plan.path[0], { x: 0, y: 64, z: 0 }); assert.ok(plan.edits.length <= 192);
  assert.ok(validateBuildSitePreparation(plan, observePreparation(f.services, plan)).ok);
  assert.equal(f.dug.length, 0); assert.equal(f.placed.length, 0); assert.equal(f.visited.length, 0);
});

test('reserved terrain preparation opens the trapped bot escape, reuses actual excavated dirt and proves the complete site', async () => {
  const f = fixture(), proposed = findBuildSitePreparation(f.explore, f.services);
  assert.ok(proposed);
  const originalSupport = f.bot.blockAt(new Vec3(0, 63, 0)).name;
  const result = await prepareBuildSite(f.prep(proposed.plan), f.services);
  assert.equal(result.outcome, 'completed'); assert.ok(f.dug.length > 0); assert.ok(f.placed.length > 0);
  assert.equal(f.bot.blockAt(new Vec3(0, 63, 0)).name, originalSupport);
  assert.ok(f.dug.every(p => !(p.x === 0 && p.z === 0 && [63, 64, 65].includes(p.y))));
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(proposed.plan.entrance.x + 0.5, 64, proposed.plan.entrance.z + 0.5)) < 0.1);
  const final = new Map(observePreparation(f.services, proposed.plan).map(b => [key(b.position), b.name]));
  for (const cell of buildSiteCells(proposed.plan.origin, 5, 5, 4)) assert.ok(cell.requirement === 'air' ? isBuildSiteAir(final.get(key(cell.position))!) : isBuildSiteGround(final.get(key(cell.position))!));
  const progress = result.checkpoint.preparationProgress as { completedEdits: number; totalEdits: number; pathIndex: number; pathLength: number };
  assert.equal(progress.completedEdits, progress.totalEdits); assert.equal(progress.pathIndex, progress.pathLength);
});

test('preparation cancellation preserves actual edits and resumption never digs or spends dirt twice', async () => {
  const f = fixture(), proposed = findBuildSitePreparation(f.explore, f.services); assert.ok(proposed);
  f.abortAt = 3;
  await assert.rejects(prepareBuildSite(f.prep(proposed.plan), f.services), (error: unknown) => error instanceof ActionFailure && error.code === 'CANCELLED');
  const before = [...f.dug], retryController = new AbortController();
  f.services.signal = retryController.signal; f.services.check = () => checkAbort(retryController.signal); f.abortAt = Infinity;
  const result = await prepareBuildSite(f.prep(proposed.plan), f.services);
  assert.equal(result.outcome, 'completed'); assert.equal(new Set(f.dug.map(key)).size, f.dug.length);
  assert.ok(before.every(p => f.dug.filter(q => key(p) === key(q)).length === 1));
});

test('world changes, adjacent facilities or hazards and other reservations stop preparation before any effect', async () => {
  for (const obstruction of ['chest', 'farmland', 'water', 'gravel', 'oak_log']) {
    const f = fixture(), proposed = findBuildSitePreparation(f.explore, f.services); assert.ok(proposed);
    const edit = proposed.plan.edits.find(e => e.after === 'air')!;
    f.cells.set(key(edit.position), obstruction);
    const result = await executeVillageTask(f.prep(proposed.plan), f.services);
    assert.equal(result.outcome, 'condition-wait'); assert.equal(f.dug.length, 0); assert.equal(f.placed.length, 0);
    assert.equal(f.cells.get(key(edit.position)), obstruction);
  }
  const reserved = fixture(), proposed = findBuildSitePreparation(reserved.explore, reserved.services); assert.ok(proposed);
  reserved.services.checkpoint.protectedPositions = [proposed.plan.edits[0]!.position];
  await assert.rejects(prepareBuildSite(reserved.prep(proposed.plan), reserved.services), /예약/);
  assert.equal(reserved.dug.length, 0);
});

test('allowPreparation=false keeps exploration read-only without generating a terrain plan', async () => {
  const f = fixture(); f.explore.params.allowPreparation = false;
  const result = await exploreBuildSite(f.explore, f.services);
  assert.equal(result.outcome, 'condition-wait'); assert.equal(result.checkpoint.buildSitePreparation, undefined);
  assert.equal(f.dug.length, 0); assert.equal(f.placed.length, 0);
});

test('natural meadow grass can be cleared but crops, flowers and trees remain excluded', () => {
  const f = fixture();
  // Cover every locally eligible building cell with ordinary meadow weeds.
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) {
    if (Math.abs(x) + Math.abs(z) < 2) continue;
    for (let y = 63; y <= 66; y++) {
      const p = new Vec3(x, y, z);
      if (f.bot.blockAt(p).name === 'air' && f.bot.blockAt(p.offset(0, -1, 0)).name === 'grass_block') { f.cells.set(key(p), 'short_grass'); break; }
    }
  }
  const proposal = findBuildSitePreparation(f.explore, f.services); assert.ok(proposal);
  assert.ok(proposal.plan.edits.some(e => e.before === 'short_grass'));
  assert.ok(validateBuildSitePreparation(proposal.plan, proposal.blocks).ok);
  const weed = proposal.plan.edits.find(e => e.before === 'short_grass')!;
  for (const name of ['wheat', 'poppy', 'oak_log']) {
    f.cells.set(key(weed.position), name);
    assert.equal(validateBuildSitePreparation(proposal.plan, observePreparation(f.services, proposal.plan)).ok, false);
  }
});

test('terrain contact at the actual reported decimal corner is not body overlap', () => {
  const feet = { x: 66.418, y: 68, z: -2.3 };
  assert.equal(intersectsBotBody({ x: 66, y: 68, z: -2 }, feet), false);
  assert.equal(intersectsBotBody({ x: 66, y: 68, z: -3 }, feet), true);
  assert.equal(intersectsBotBody({ x: 66, y: 67, z: -3 }, feet), false);
});

test('wide terrain opens reachable columns before farther cuts that need those footholds', async () => {
  const f = fixture(); f.explore.params.design = 'warehouse';
  const originalNear = f.services.near;
  f.services.near = async (target, radius) => {
    const start = { x: Math.floor(f.bot.entity.position.x), y: 64, z: Math.floor(f.bot.entity.position.z) };
    const end = { x: Math.floor(target.x), y: 64, z: Math.floor(target.z) }, seen = new Set<string>(), queue = [start];
    while (queue.length && seen.size < 1600) {
      const p = queue.shift()!; if (seen.has(key(p))) continue; seen.add(key(p));
      if (key(p) === key(end)) return originalNear(target, radius);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = new Vec3(p.x + dx!, 64, p.z + dz!);
        if (Math.abs(q.x) > 18 || Math.abs(q.z) > 18 || seen.has(key(q))) continue;
        if (isBuildSiteGround(f.bot.blockAt(q.offset(0, -1, 0)).name) && isBuildSiteAir(f.bot.blockAt(q).name) && isBuildSiteAir(f.bot.blockAt(q.offset(0, 1, 0)).name)) queue.push(q);
      }
    }
    throw new ConditionWait('No connected cleared foothold');
  };
  const originalDig = f.bot.dig;
  f.bot.dig = async block => { assert.ok(f.bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4.5); await originalDig(block); };
  const proposed = findBuildSitePreparation(f.explore, f.services); assert.ok(proposed);
  const result = await prepareBuildSite(f.prep(proposed.plan), f.services);
  assert.equal(result.outcome, 'completed'); assert.ok(proposed.plan.edits.length > 30);
});

test('excavated soil pickup can move the bot and filling returns to the actual approach first', async () => {
  const f = fixture(), proposed = findBuildSitePreparation(f.explore, f.services); assert.ok(proposed);
  const far = new Vec3(-15.5, 63, -15.5);
  // Keep this distant pickup destination physically supported and clear.
  f.cells.set('-16,62,-16', 'dirt'); f.cells.set('-16,63,-16', 'air'); f.cells.set('-16,64,-16', 'air');
  f.services.recoverDrops = async () => { f.bot.entity.position = far.clone(); };
  const originalPlace = f.services.place;
  f.services.place = async (p, item, expected, face) => {
    assert.ok(f.bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) <= 4.5, 'fill must return from the pickup destination');
    await originalPlace(p, item, expected, face);
  };
  const result = await prepareBuildSite(f.prep(proposed.plan), f.services);
  assert.equal(result.outcome, 'completed'); assert.ok(f.placed.length > 0);
});

test('grass-to-fill replacement resumes from actual intermediate air and completes only after soil is placed', async () => {
  const f = fixture(), proposal = findBuildSitePreparation(f.explore, f.services); assert.ok(proposal);
  const fill = proposal.plan.edits.find(e => e.after === 'dirt')!; f.cells.set(key(fill.position), 'short_grass'); fill.before = 'short_grass';
  const dig = f.bot.dig;
  f.bot.dig = async block => { await dig(block); if (key(block.position) === key(fill.position)) f.controller.abort(); };
  await assert.rejects(prepareBuildSite(f.prep(proposal.plan), f.services), (error: unknown) => error instanceof ActionFailure && error.code === 'CANCELLED');
  assert.equal(f.cells.get(key(fill.position)), 'air');
  assert.equal(f.services.checkpoint.buildSite, undefined);
  const resumed = new AbortController(); f.services.signal = resumed.signal; f.services.check = () => checkAbort(resumed.signal);
  const result = await prepareBuildSite(f.prep(proposal.plan), f.services);
  assert.equal(result.outcome, 'completed'); assert.equal(f.cells.get(key(fill.position)), 'dirt');
  assert.equal(f.dug.filter(p => key(p) === key(fill.position)).length, 1);
});
