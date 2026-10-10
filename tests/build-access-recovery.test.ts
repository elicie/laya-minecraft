import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { RulesSchema, accessPreparationProofPositions, validateBuildAccessPreparation, type BuildAccessPreparation, type Position, type TaskSpec } from '../packages/contracts/src';
import { findBuildAccessPreparation, observeAccessPreparation, prepareBuildAccess } from '../packages/minecraft/src/build-access-recovery';
import { checkAbort, ConditionWait, type ActionServices } from '../packages/minecraft/src/services';

const key = (p: Position) => `${p.x},${p.y},${p.z}`;
function fixture() {
  const cells = new Map<string, string>(), edits: Position[] = [], visits: Position[] = [], stock = new Map<string, number>();
  const controller = new AbortController(); let abortAfter = Infinity;
  const read = (p: Vec3) => {
    const name = cells.get(key(p)) ?? (p.z === 0 ? p.y <= 63 ? p.y === 63 ? 'grass_block' : 'dirt' : 'air' : p.y <= 59 ? 'stone' : 'air');
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true };
  };
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) }, pathfinder: { setGoal() {} }, clearControlStates() {}, inventory: { items: () => [...stock].map(([name, count]) => ({ name, count, type: 1 })) },
    blockAt: read,
    async dig(block: { name: string; position: Vec3 }) { assert.ok(bot.entity.position.distanceTo(block.position) < 4.5); edits.push({ ...block.position }); cells.set(key(block.position), 'air'); if (block.name === 'dirt' || block.name === 'grass_block') stock.set('dirt', (stock.get('dirt') ?? 0) + 1); if (edits.length >= abortAfter) controller.abort(); },
  };
  const s: ActionServices = {
    bot: bot as unknown as Bot, rules: RulesSchema.parse({ world: 'validation:25566' }), signal: controller.signal, checkpoint: {}, observations: [], evidence: [],
    check() { checkAbort(controller.signal); }, pause: async () => {},
    async near(p) { const cell = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); assert.notEqual(read(cell.offset(0, -1, 0)).boundingBox, 'empty'); assert.equal(read(cell).name, 'air'); assert.equal(read(cell.offset(0, 1, 0)).name, 'air'); bot.entity.position = new Vec3(p.x, p.y, p.z); visits.push(p); },
    async ensureItem(name) { assert.ok((stock.get(name) ?? 0) >= 1, 'fixture acquires fill material from actual excavation'); },
    async place(p) { assert.ok((stock.get('dirt') ?? 0) > 0); assert.notEqual(read(new Vec3(p.x, p.y - 1, p.z)).boundingBox, 'empty'); stock.set('dirt', stock.get('dirt')! - 1); cells.set(key(p), 'dirt'); edits.push(p); },
    observeInventory: () => ({ id: 'inventory', kind: 'inventory', observedAt: Date.now(), world: s.rules.world, dimension: s.rules.dimension, data: { items: [...stock].map(([name, count]) => ({ name, count })) } }),
    progress() {},
  };
  const task = (preparation: BuildAccessPreparation): TaskSpec => ({ id: 'access', goalId: 'warehouse', kind: 'build', params: { mode: 'prepare-access', parentTaskId: 'building', preparation }, completion: { kind: 'blocks', blocks: [{ position: preparation.target, name: 'air' }] }, dependencies: [], reservationKeys: [] });
  return { bot, s, task, cells, edits, visits, stock, controller, set abortAfter(n: number) { abortAfter = n; } };
}

test('building return proposes a bounded three-dimensional corridor without effects, then actually opens and reaches it', async () => {
  const f = fixture(); f.cells.set('1,64,0', 'dirt'); f.cells.set('1,65,0', 'grass_block');
  const target = { x: 4, y: 64, z: 0 }, plan = findBuildAccessPreparation(f.s, target);
  assert.ok(plan); assert.ok(plan.edits.length > 0); assert.ok(plan.path.some(p => p.y === 65), 'a height-aware route can clear the top of a two-high wall');
  assert.deepEqual(f.edits, []); assert.deepEqual(f.visits, []); assert.deepEqual(f.stock.size, 0);
  assert.equal(validateBuildAccessPreparation(plan, observeAccessPreparation(f.s, plan), { expectedTarget: target }).ok, true);
  const result = await prepareBuildAccess(f.task(plan), f.s);
  assert.equal(result.outcome, 'completed'); assert.ok(f.edits.length > 0); assert.ok(f.bot.entity.position.distanceTo(new Vec3(4.5, 64, 0.5)) < 1);
  assert.equal(f.bot.blockAt(new Vec3(0, 63, 0)).name, 'grass_block', 'the original bot support is preserved');
  assert.ok(result.observations.some(o => o.kind === 'exploration' && o.data.position.x === 4.5));
});

test('return planning preserves facilities, crops, liquid, falling terrain and unknown cells', () => {
  for (const name of ['chest', 'oak_planks', 'farmland', 'wheat', 'water', 'lava', 'sand', 'gravel']) {
    const f = fixture(); f.cells.set('1,64,0', name); f.cells.set('1,65,0', name);
    const plan = findBuildAccessPreparation(f.s, { x: 3, y: 64, z: 0 });
    if (plan) {
      assert.ok(plan.edits.every(e => e.before !== name), name);
      assert.ok(plan.path.every(p => p.x !== 1 || p.z !== 0), 'alternative routes must avoid the facility or hazard');
    }
    assert.equal(f.bot.blockAt(new Vec3(1, 64, 0)).name, name); assert.deepEqual(f.edits, []);
  }
  const f = fixture(), original = f.bot.blockAt;
  f.bot.blockAt = (p: Vec3) => p.x === 1 && p.z === 0 ? null as unknown as ReturnType<typeof original> : original(p);
  const plan = findBuildAccessPreparation(f.s, { x: 3, y: 64, z: 0 });
  if (plan) assert.ok(plan.path.every(p => p.x !== 1 || p.z !== 0), 'an alternative route cannot assume unknown ground');
});

test('a shallow missing support uses verified excavated dirt, while a cave below the fill is refused', async () => {
  const f = fixture(); f.cells.set('1,64,0', 'dirt'); f.cells.set('1,63,0', 'air');
  const plan: BuildAccessPreparation = { start: { x: 0, y: 64, z: 0 }, target: { x: 2, y: 64, z: 0 }, observedAt: Date.now(), path: [0, 1, 2].map(x => ({ x, y: 64, z: 0 })), edits: [{ position: { x: 1, y: 64, z: 0 }, before: 'dirt', after: 'air' }, { position: { x: 1, y: 63, z: 0 }, before: 'air', after: 'dirt' }] };
  assert.equal(validateBuildAccessPreparation(plan, observeAccessPreparation(f.s, plan)).ok, true);
  f.cells.set('1,60,0', 'air'); assert.equal(validateBuildAccessPreparation(plan, observeAccessPreparation(f.s, plan)).ok, false);
  f.cells.delete('1,60,0'); const done = await prepareBuildAccess(f.task(plan), f.s);
  assert.equal(done.outcome, 'completed'); assert.equal(f.bot.blockAt(new Vec3(1, 63, 0)).name, 'dirt'); assert.equal(f.stock.get('dirt'), 0);
});

test('interrupted route preserves actual edits and resumption does not dig them twice', async () => {
  const f = fixture(); f.cells.set('1,64,0', 'dirt'); f.cells.set('1,65,0', 'grass_block');
  const plan = findBuildAccessPreparation(f.s, { x: 3, y: 64, z: 0 }); assert.ok(plan);
  f.abortAfter = 1; await assert.rejects(prepareBuildAccess(f.task(plan), f.s), /중단/);
  const changed = f.edits.length; assert.equal(changed, 1);
  const signal = new AbortController().signal;
  const resumed = { ...f.s, signal, check() { checkAbort(signal); } };
  const result = await prepareBuildAccess(f.task(plan), resumed);
  assert.equal(result.outcome, 'completed'); assert.equal(f.edits.length, changed);
});

test('central plan validation rejects wrong targets, stale source blocks, unsafe neighbors, and protected build cells', () => {
  const f = fixture(); f.cells.set('1,64,0', 'dirt'); f.cells.set('1,65,0', 'grass_block');
  const plan = findBuildAccessPreparation(f.s, { x: 3, y: 64, z: 0 }); assert.ok(plan);
  const blocks = observeAccessPreparation(f.s, plan);
  assert.equal(validateBuildAccessPreparation(plan, blocks, { expectedTarget: { x: 4, y: 64, z: 0 } }).ok, false);
  assert.equal(validateBuildAccessPreparation(plan, blocks, { protectedPositions: [plan.edits[0]!.position] }).ok, false);
  assert.equal(validateBuildAccessPreparation(plan, blocks.slice(1)).ok, false);
  const cut = plan.edits[0]!.position;
  f.cells.set(key(cut), 'air'); assert.equal(validateBuildAccessPreparation(plan, observeAccessPreparation(f.s, plan)).ok, false);
  assert.equal(validateBuildAccessPreparation(plan, observeAccessPreparation(f.s, plan), { allowCompletedEdits: true }).ok, true);
  f.cells.set(`${cut.x},${cut.y},${cut.z + 1}`, 'chest'); assert.equal(validateBuildAccessPreparation(plan, observeAccessPreparation(f.s, plan), { allowCompletedEdits: true }).ok, false);
  assert.ok(accessPreparationProofPositions(plan).length > plan.path.length * 3);
});

test('execution rechecks changed terrain before any effect and fails with observable route conditions', async () => {
  const f = fixture(); f.cells.set('1,64,0', 'dirt'); f.cells.set('1,65,0', 'grass_block');
  const plan = findBuildAccessPreparation(f.s, { x: 3, y: 64, z: 0 }); assert.ok(plan);
  f.cells.set(key(plan.edits[0]!.position), 'chest');
  await assert.rejects(prepareBuildAccess(f.task(plan), f.s), (error: unknown) => error instanceof ConditionWait && error.checkpoint.waitingFor !== undefined);
  assert.deepEqual(f.edits, []); assert.deepEqual(f.visits, []);
});
