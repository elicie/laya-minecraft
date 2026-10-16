import assert from 'node:assert/strict';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, type Position } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ConditionWait } from '../packages/minecraft/src/services';

function bootstrapFixture(hasSand = true) {
  const data = minecraftData('26.1'), Recipe = require('prismarine-recipe')(data).Recipe;
  const stock = new Map<string, number>(), cells = new Map<string, string>(), dug: string[] = [], crafted: string[] = [];
  const entity = { position: new Vec3(0.5, 64, 0.5) };
  let heldType: number | null = null, scans = 0, opened = 0, closed = 0;
  const furnaceState = { inputCount: 0, outputCount: 0, outputName: '' };
  for (const x of [10, 14]) for (let y = 64; y <= 67; y++) cells.set(new Vec3(x, y, 10).toString(), 'oak_log');
  for (const x of [10, 14]) cells.set(new Vec3(x, 69, 10).toString(), 'oak_leaves');
  for (let x = 4; x <= 11; x++) cells.set(new Vec3(x, 64, 4).toString(), 'stone');
  if (hasSand) for (let x = 4; x <= 9; x++) cells.set(new Vec3(x, 64, 14).toString(), 'sand');
  cells.set(new Vec3(2, 64, 10).toString(), 'coal_ore');
  const items = () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: data.itemsByName[name]!.id, stackSize: 64 }));
  const blockAt = (p: Vec3) => {
    const position = p.floored(), name = cells.get(position.toString()) ?? (position.y <= 63 ? 'dirt' : 'air');
    return { position, name, type: data.blocksByName[name]!.id, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => ({}),
      canHarvest: (type: number | null) => !['stone', 'coal_ore'].includes(name) || type === data.itemsByName.wooden_pickaxe!.id };
  };
  const walkable = (p: Vec3) => blockAt(p).boundingBox === 'empty' && blockAt(p.offset(0, 1, 0)).boundingBox === 'empty' && blockAt(p.offset(0, -1, 0)).boundingBox === 'block';
  const getPathTo = (_movements: unknown, goal: { x: number; y: number; z: number; rangeSq?: number }) => {
    const start = entity.position.floored(), target = new Vec3(goal.x, goal.y, goal.z), queue = [start], previous = new Map<string, Vec3 | null>([[start.toString(), null]]);
    let found: Vec3 | undefined;
    for (let index = 0; index < queue.length && index < 10000; index++) {
      const p = queue[index]!;
      if (p.distanceSquared(target) <= (goal.rangeSq ?? 0)) { found = p; break; }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = p.offset(dx!, 0, dz!);
        if (previous.has(next.toString()) || next.distanceTo(start) > 48 || !walkable(next)) continue;
        previous.set(next.toString(), p); queue.push(next);
      }
    }
    const path = [];
    for (let p = found; p && !p.equals(start); p = previous.get(p.toString()) ?? undefined) path.unshift({ x: p.x, y: p.y, z: p.z, toBreak: [], toPlace: [], parkour: false });
    return { status: found ? 'success' : 'noPath', path };
  };
  const bot = {
    entity, entities: {}, players: {}, registry: data, blockAt, canSeeBlock: () => true,
    inventory: { items, emptySlotCount: () => 36 }, get heldItem() { return heldType === null ? null : { type: heldType }; },
    findBlock(request: { matching(b: ReturnType<typeof blockAt>): boolean; useExtraInfo?(b: ReturnType<typeof blockAt>): boolean }) {
      scans++;
      return [...cells.keys()].map(key => blockAt(new Vec3(...key.slice(1, -1).split(',').map(Number) as [number, number, number])))
        .find(block => request.matching(block) && (!request.useExtraInfo || request.useExtraInfo(block))) ?? null;
    },
    pathfinder: { movements: { canDig: false, allow1by1towers: false }, getPathTo },
    async equip(item: { type: number }) { heldType = item.type; },
    async dig(block: ReturnType<typeof blockAt>) {
      assert.ok(walkable(entity.position.floored()), 'digging requires actual safe feet and head clearance');
      assert.ok(entity.position.distanceTo(block.position) <= 4.5);
      assert.ok(block.canHarvest(heldType), 'stone and coal must wait for the actual crafted pickaxe');
      assert.ok(['oak_log', 'stone', 'sand', 'coal_ore'].includes(block.name));
      dug.push(block.name); cells.set(block.position.toString(), 'air');
      const item = block.name === 'stone' ? 'cobblestone' : block.name === 'coal_ore' ? 'coal' : block.name;
      stock.set(item, (stock.get(item) ?? 0) + 1);
    },
    recipesAll: (id: number) => Recipe.find(id, null),
    recipesFor: (id: number, _metadata: unknown, _minimum: number, table?: unknown) => Recipe.find(id, null).filter((recipe: ReturnType<Bot['recipesAll']>[number]) =>
      (!recipe.requiresTable || table) && recipe.delta.every(i => i.count >= 0 || (stock.get(data.items[i.id]!.name) ?? 0) >= -i.count)),
    async craft(recipe: ReturnType<Bot['recipesAll']>[number], count: number, table?: { name: string }) {
      assert.equal(count, 1); if (recipe.requiresTable) assert.equal(table?.name, 'crafting_table');
      assert.ok(recipe.delta.every(i => i.count >= 0 || (stock.get(data.items[i.id]!.name) ?? 0) >= -i.count), 'all recipe ingredients must genuinely exist');
      for (const i of recipe.delta) { const name = data.items[i.id]!.name; stock.set(name, (stock.get(name) ?? 0) + i.count); }
      crafted.push(data.items[recipe.result.id]!.name);
    },
    async openFurnace(block: ReturnType<typeof blockAt>) {
      assert.equal(block.name, 'furnace'); opened++;
      return {
        inputItem: () => furnaceState.inputCount ? { name: 'sand', count: furnaceState.inputCount } : null,
        outputItem: () => furnaceState.outputCount ? { name: furnaceState.outputName, count: furnaceState.outputCount } : null,
        async putInput(type: number, _metadata: unknown, count: number) {
          const name = data.items[type]!.name; assert.ok(['sand', 'oak_log'].includes(name)); assert.ok((stock.get(name) ?? 0) >= count);
          furnaceState.outputName = name === 'sand' ? 'glass' : 'charcoal'; stock.set(name, stock.get(name)! - count); furnaceState.inputCount = count;
        },
        async putFuel(type: number, _metadata: unknown, count: number) {
          const name = data.items[type]!.name; assert.ok(['coal', 'charcoal'].includes(name) || name.endsWith('_planks')); assert.ok((stock.get(name) ?? 0) >= count);
          assert.ok(count * (name.endsWith('_planks') ? 1.5 : 8) >= furnaceState.inputCount); stock.set(name, stock.get(name)! - count); furnaceState.outputCount = furnaceState.inputCount; furnaceState.inputCount = 0;
        },
        async takeOutput() { stock.set(furnaceState.outputName, (stock.get(furnaceState.outputName) ?? 0) + furnaceState.outputCount); furnaceState.outputCount = 0; },
        async close() { closed++; },
      };
    },
  };
  class BootstrapExecutor extends MineflayerExecutor {
    override async place(p: Position, name: string): Promise<void> {
      assert.ok((stock.get(name) ?? 0) >= 1, 'utilities must actually be crafted before placement');
      assert.equal(blockAt(new Vec3(p.x, p.y, p.z)).name, 'air');
      stock.set(name, stock.get(name)! - 1); cells.set(new Vec3(p.x, p.y, p.z).toString(), name);
    }
  }
  const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'EmptyGlass26Unit', allowedActions: ['collect', 'craft', 'smelt'] }, rules: {} });
  const executor = new BootstrapExecutor(bot as unknown as Bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => launch.rules.dimension }), services = executor.services(new AbortController().signal);
  services.pause = async () => {};
  services.near = async (p, radius = 2) => {
    if (entity.position.distanceTo(new Vec3(p.x, p.y, p.z)) <= radius + 0.5) return;
    const result = getPathTo(bot.pathfinder.movements, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), rangeSq: radius * radius });
    if (result.status !== 'success') throw new ConditionWait('실제로 관측한 지상 경로가 없습니다.');
    for (const step of result.path) { const feet = new Vec3(step.x, step.y, step.z); assert.ok(walkable(feet)); entity.position = feet.offset(0.5, 0, 0.5); }
  };
  return { executor, services, stock, cells, dug, crafted, furnaceState, get scans() { return scans; }, get opened() { return opened; }, get closed() { return closed; } };
}

test('a resumed smelt takes its actual saved-furnace output before searching for already committed raw input', async () => {
  const f = bootstrapFixture(false);
  f.stock.set('glass', 3); f.cells.set(new Vec3(2,64,0).toString(), 'furnace');
  Object.assign(f.furnaceState, { outputName: 'glass', outputCount: 3 });
  f.services.checkpoint.furnacePosition = { x: 2, y: 64, z: 0 };
  f.services.checkpoint.resourceRecovery = { sand: { elapsedMs: 60000, destinationsUsed: 5 } };
  const budget = JSON.stringify(f.services.checkpoint.resourceRecovery);
  await f.executor.execute({ id: 'saved-glass', goalId: 'original-smelt', kind: 'smelt', params: { item: 'glass' }, dependencies: [], reservationKeys: [], completion: { kind: 'inventory', item: 'glass', minimum: 6 } }, f.services);
  assert.equal(f.stock.get('glass'), 6); assert.equal(f.furnaceState.outputCount, 0);
  assert.deepEqual(f.dug, []); assert.deepEqual(f.crafted, []); assert.equal(f.scans, 0);
  assert.equal(JSON.stringify(f.services.checkpoint.resourceRecovery), budget); assert.equal(f.closed, f.opened);
});

test('a resumed smelt waits for its real committed batch before gathering more sand', async () => {
  const f = bootstrapFixture(false);
  f.stock.set('glass', 3); f.cells.set(new Vec3(2,64,0).toString(), 'furnace');
  Object.assign(f.furnaceState, { outputName: 'glass', inputCount: 3 });
  f.services.checkpoint.furnacePosition = { x: 2, y: 64, z: 0 };
  f.services.pause = async () => { f.furnaceState.outputCount = 3; f.furnaceState.inputCount = 0; };
  await f.executor.execute({ id: 'pending-glass', goalId: 'original-smelt', kind: 'smelt', params: { item: 'glass' }, dependencies: [], reservationKeys: [], completion: { kind: 'inventory', item: 'glass', minimum: 6 } }, f.services);
  assert.equal(f.stock.get('glass'), 6); assert.deepEqual(f.dug, []); assert.deepEqual(f.crafted, []);
  assert.equal(f.scans, 0); assert.equal(f.closed, f.opened);
});

test('empty inventory and actual 26.1 recipes bootstrap glass panes from only observed oak, stone, sand and coal', async () => {
  const f = bootstrapFixture();
  await f.executor.ensureItem('glass_pane', 3, f.services);
  assert.equal(f.stock.get('glass_pane'), 16);
  for (const name of ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'furnace', 'glass_pane']) assert.ok(f.crafted.includes(name), `${name} must be actually crafted`);
  assert.equal(f.dug.filter(name => name === 'stone').length, 8);
  assert.equal(f.dug.filter(name => name === 'sand').length, 6);
  assert.ok(f.opened >= 1 && f.opened <= 3, 'an existing furnace may need one additional contents inspection'); assert.equal(f.closed, f.opened);
  assert.ok(f.services.observations.some(o => o.kind === 'inventory' && o.data.items.some(i => i.name === 'glass_pane' && i.count === 16)));
  assert.ok(f.scans < 200, 'shared bootstrap dependencies keep all real wood/fuel variant scans bounded');
});

test('an absent smelting raw source remains in the truthful wait without constructing speculative utilities', async () => {
  const f = bootstrapFixture(false);
  await assert.rejects(f.executor.ensureItem('glass_pane', 3, f.services), (error: unknown) => error instanceof ConditionWait && Array.isArray(error.checkpoint.resourceNames) && error.checkpoint.resourceNames.includes('sand'));
  assert.deepEqual(f.dug, []); assert.deepEqual(f.crafted, []); assert.equal(f.opened, 0);
});

test('sharing a feasible bootstrap cost preserves cycle and depth guards and spends no budget on a valid cache hit', () => {
  const f = bootstrapFixture();
  const evaluation = { remaining: 1024, table: null, recipes: new Map(), sources: new Map(), costs: new Map(), resourceNames: new Set<string>() };
  // Exercise the read-only evaluator with two different ancestries; no library
  // API or production method is replaced, and no acquisition effects occur.
  const evaluator = f.executor as unknown as { acquisitionCost(item: string, minimum: number, chain: Set<string>, services: typeof f.services, context: typeof evaluation): number };
  assert.ok(Number.isFinite(evaluator.acquisitionCost('furnace', 1, new Set(['glass']), f.services, evaluation)));
  const remaining = evaluation.remaining;
  assert.ok(Number.isFinite(evaluator.acquisitionCost('furnace', 1, new Set(['sand']), f.services, evaluation)));
  assert.equal(evaluation.remaining, remaining, 'valid cached facility proof does not spend another graph evaluation');
  assert.equal(evaluator.acquisitionCost('furnace', 1, new Set(['oak_planks']), f.services, evaluation), Infinity, 'cached oak bootstrap must not bypass the caller cycle');
  assert.equal(evaluator.acquisitionCost('furnace', 1, new Set(Array.from({ length: 10 }, (_, i) => `ancestor_${i}`)), f.services, evaluation), Infinity, 'a short cached path must not bypass the combined ancestry limit');
  assert.ok(evaluation.remaining > 0, 'all actual wood variants fit within the unchanged 1024 evaluation budget');
  assert.deepEqual(f.dug, []); assert.deepEqual(f.crafted, []);
});
