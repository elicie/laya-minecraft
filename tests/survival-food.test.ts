import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ActionFailure, ConditionWait } from '../packages/minecraft/src/services';

function fixture(options: { warehouse?: boolean; food?: Record<string, number>; health?: number } = {}) {
  const data = minecraftData('26.1'), Recipe = require('prismarine-recipe')(data).Recipe, emitter = new EventEmitter();
  const stock = new Map<string, number>(), stored = new Map(Object.entries(options.food ?? {})), cells = new Map<string, string>(), ages = new Map<string, number>();
  const dug: string[] = [], crafted: string[] = [], attacked: string[] = [];
  let opened = 0, closed = 0, withdrawn = 0, held = '', unsafeWithdraw = false;
  const entity = { id: 1, position: new Vec3(0.5, 64, 0.5) };
  const blockAt = (p: Vec3) => {
    const position = p.floored(), name = cells.get(position.toString()) ?? (position.y <= 63 ? 'dirt' : 'air');
    return { name, position, boundingBox: ['air', 'wheat', 'potatoes', 'carrots', 'beetroots', 'short_grass'].includes(name) ? 'empty' : 'block',
      canHarvest: () => true, getProperties: () => ({ age: ages.get(position.toString()) ?? 7 }) };
  };
  const playerItems = () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: data.itemsByName[name]!.id, stackSize: 64 }));
  const containerItems = () => [...stored].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count }));
  const walkable = (p: Vec3) => blockAt(p).boundingBox === 'empty' && blockAt(p.offset(0, 1, 0)).boundingBox === 'empty' && blockAt(p.offset(0, -1, 0)).boundingBox === 'block';
  const getPathTo = (_movement: unknown, goal: { x: number; y: number; z: number }) => {
    const start = entity.position.floored(), target = new Vec3(goal.x, goal.y, goal.z), queue = [start], previous = new Map<string, Vec3 | null>([[start.toString(), null]]);
    let found: Vec3 | undefined;
    for (let index = 0; index < queue.length && index < 10000; index++) {
      const p = queue[index]!; if (p.equals(target)) { found = p; break; }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = p.offset(dx!, 0, dz!); if (previous.has(next.toString()) || next.distanceTo(start) > 48 || !walkable(next)) continue;
        previous.set(next.toString(), p); queue.push(next);
      }
    }
    const path = [];
    for (let p = found; p && !p.equals(start); p = previous.get(p.toString()) ?? undefined) path.unshift({ x: p.x, y: p.y, z: p.z, toBreak: [], toPlace: [], parkour: false });
    return { status: found ? 'success' : 'noPath', path };
  };
  const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'SurvivalFoodUnit', allowedActions: ['collect', 'craft', 'smelt', 'hunt', 'take'] }, rules: {} });
  const container = { id: 'food-warehouse', world: launch.rules.world, dimension: launch.rules.dimension, position: { x: 2, y: 64, z: 0 } };
  if (options.warehouse) { launch.rules.warehouse = container; cells.set('(2, 64, 0)', 'chest'); }
  const bot = Object.assign(emitter, {
    entity, entities: {} as Record<number, Entity>, players: {}, health: options.health ?? 6.333, food: 17, registry: data, blockAt,
    inventory: { items: playerItems, emptySlotCount: () => 36 }, world: { raycast: () => null },
    findBlock(request: { matching(b: ReturnType<typeof blockAt>): boolean; useExtraInfo?(b: ReturnType<typeof blockAt>): boolean }) {
      return [...cells.keys()].map(key => blockAt(new Vec3(...key.slice(1, -1).split(',').map(Number) as [number, number, number])))
        .find(block => request.matching(block) && (!request.useExtraInfo || request.useExtraInfo(block))) ?? null;
    },
    canSeeBlock: () => true,
    pathfinder: { movements: { canDig: false, allow1by1towers: false }, getPathTo },
    async equip(item: { name: string }) { held = item.name; },
    async dig(block: ReturnType<typeof blockAt>) {
      assert.ok(walkable(entity.position.floored())); assert.ok(entity.position.distanceTo(block.position) <= 4.5);
      if (block.name === 'wheat') assert.equal(block.getProperties().age, 7);
      dug.push(block.name); cells.set(block.position.toString(), 'air');
      const name = block.name === 'melon' ? 'melon_slice' : block.name;
      stock.set(name, (stock.get(name) ?? 0) + (block.name === 'melon' ? 3 : 1));
    },
    recipesAll: (id: number) => Recipe.find(id, null),
    recipesFor: (id: number, _metadata: unknown, _minimum: number, table?: unknown) => Recipe.find(id, null).filter((r: ReturnType<Bot['recipesAll']>[number]) =>
      (!r.requiresTable || table) && r.delta.every(i => i.count >= 0 || (stock.get(data.items[i.id]!.name) ?? 0) >= -i.count)),
    async craft(recipe: ReturnType<Bot['recipesAll']>[number], _count: number, table?: { name: string }) {
      if (recipe.requiresTable) assert.equal(table?.name, 'crafting_table');
      for (const ingredient of recipe.delta) { const name = data.items[ingredient.id]!.name; assert.ok((stock.get(name) ?? 0) + ingredient.count >= 0); stock.set(name, (stock.get(name) ?? 0) + ingredient.count); }
      crafted.push(data.items[recipe.result.id]!.name);
    },
    async consume() { assert.ok((stock.get(held) ?? 0) > 0); stock.set(held, stock.get(held)! - 1); bot.food = Math.min(20, bot.food + data.foodsByName[held]!.foodPoints); },
    async openContainer() {
      opened++;
      return { containerItems, items: playerItems,
        async withdraw(type: number, _metadata: unknown, count: number) {
          assert.equal(count, 1); const name = data.items[type]!.name; assert.ok((stored.get(name) ?? 0) >= count); stored.set(name, stored.get(name)! - count); stock.set(name, (stock.get(name) ?? 0) + count); withdrawn++;
          if (unsafeWithdraw) throw new Error('server transfer acknowledgement missing');
        }, async close() { closed++; },
      };
    },
    clearControlStates() {}, deactivateItem() {}, async lookAt() {},
    attack(target: Entity) {
      assert.equal(target.name, 'cow'); attacked.push(target.name!); delete bot.entities[target.id]; stock.set('beef', (stock.get('beef') ?? 0) + 1); emitter.emit('entityDead', target);
    },
  });
  const executor = new MineflayerExecutor(bot as unknown as Bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => launch.rules.dimension }), s = executor.services(new AbortController().signal);
  s.pause = async () => {}; s.near = async (p, radius = 2) => {
    if (entity.position.distanceTo(new Vec3(p.x, p.y, p.z)) <= radius + 0.5) return;
    const result = getPathTo({}, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    if (result.status !== 'success') throw new ConditionWait('actual loaded ground has no safe route');
    for (const step of result.path) { const q = new Vec3(step.x, step.y, step.z); assert.ok(walkable(q)); entity.position = q.offset(0.5, 0, 0.5); }
  };
  return { executor, s, bot, stock, stored, cells, ages, dug, crafted, attacked, container, launch, add(name: string, x = 4, z = 0) { cells.set(new Vec3(x, 64, z).toString(), name); },
    get opened() { return opened; }, get closed() { return closed; }, get withdrawn() { return withdrawn; }, set unsafeWithdraw(value: boolean) { unsafeWithdraw = value; } };
}

test('without a warehouse low-health recovery harvests actual melon drops and confirms consumption', async () => {
  const f = fixture(); f.add('melon', 8); await f.executor.ensureFood(f.s);
  assert.deepEqual(f.dug, ['melon']); assert.equal(f.stock.get('melon_slice'), 3); assert.equal(f.opened, 0);
  assert.equal(await f.executor.eat(f.s), true); assert.equal(f.bot.food, 19); assert.equal(f.stock.get('melon_slice'), 2);
});

test('food crafting without a warehouse uses actual mature wheat, an observed table and real ingredient counts', async () => {
  const f = fixture(); f.add('crafting_table', 2, 2); for (let x = 4; x <= 6; x++) f.add('wheat', x, 0);
  await f.executor.ensureFood(f.s); assert.equal(f.stock.get('bread'), 1); assert.equal(f.dug.filter(name => name === 'wheat').length, 3); assert.deepEqual(f.crafted, ['bread']);
  assert.equal(await f.executor.eat(f.s), true); assert.equal(f.bot.food, 20);
});

test('one observed passive cow can supply food at health 6.333 without a weapon, but critical health and protected livestock cannot', async () => {
  for (const mode of ['allowed', 'critical', 'protected'] as const) {
    const f = fixture({ health: mode === 'critical' ? 5 : 6.333 });
    const cow = { id: 2, uuid: 'actual-cow', name: 'cow', type: 'animal', position: new Vec3(2, 64, 0), height: 1.4 } as unknown as Entity; f.bot.entities[cow.id] = cow;
    if (mode === 'protected') f.launch.rules.center = { x: 2, y: 64, z: 0 };
    if (mode === 'allowed') { await f.executor.ensureFood(f.s); assert.equal(f.stock.get('beef'), 1); assert.deepEqual(f.attacked, ['cow']); assert.ok(f.s.observations.some(o => o.kind === 'entity-death')); }
    else { await assert.rejects(f.executor.ensureFood(f.s), ConditionWait); assert.deepEqual(f.attacked, []); }
  }
});

test('a configured warehouse supplies exactly one actual food item with inventory and container transfer proofs', async () => {
  const f = fixture({ warehouse: true, food: { bread: 8 } }); await f.executor.ensureFood(f.s);
  assert.equal(f.stock.get('bread'), 1); assert.equal(f.stored.get('bread'), 7); assert.equal(f.withdrawn, 1); assert.equal(f.opened, 2); assert.equal(f.closed, 2); assert.deepEqual(f.dug, []);
  assert.ok(f.s.evidence.some(e => e.kind === 'transfer' && e.direction === 'take' && e.quantity === 1 && e.beforeInventory === 0 && e.afterInventory === 1 && e.beforeContainer === 8 && e.afterContainer === 7));
  assert.deepEqual(f.s.checkpoint.foodWarehouse, { container: f.container, items: [{ name: 'bread', count: 7 }] });
});

test('an empty or inaccessible warehouse falls back to actual natural food without inventing container stock', async () => {
  for (const blocked of [false, true]) {
    const f = fixture({ warehouse: true }); f.add('melon', 8);
    if (blocked) { const near = f.s.near; f.s.near = async (p, r) => { if (p.x === 2 && p.z === 0) throw new ConditionWait('warehouse route blocked'); return near(p, r); }; }
    await f.executor.ensureFood(f.s); assert.equal(f.stock.get('melon_slice'), 3); assert.equal(f.withdrawn, 0); assert.equal(f.closed, f.opened);
    if (!blocked) assert.deepEqual(f.s.checkpoint.foodWarehouse, { container: f.container, items: [] });
  }
});

test('warehouse take permission and world/dimension limits are preserved', async () => {
  for (const forbidden of ['permission', 'world', 'dimension'] as const) {
    const f = fixture({ warehouse: true, food: { bread: 8 } }); f.add('melon', 8);
    if (forbidden === 'permission') f.launch.config.allowedActions = f.launch.config.allowedActions.filter(action => action !== 'take');
    else f.container[forbidden] = 'another';
    await f.executor.ensureFood(f.s); assert.equal(f.opened, 0); assert.equal(f.withdrawn, 0); assert.equal(f.stored.get('bread'), 8); assert.equal(f.stock.get('melon_slice'), 3);
  }
});

test('unknown warehouse transfer effects propagate instead of hunting or harvesting another source', async () => {
  const f = fixture({ warehouse: true, food: { bread: 8 } }); f.add('melon', 8); f.unsafeWithdraw = true;
  await assert.rejects(f.executor.ensureFood(f.s), error => error instanceof ActionFailure && error.code === 'TRANSFER_UNCERTAIN' && !error.effectsKnown);
  assert.equal(f.withdrawn, 1); assert.equal(f.closed, f.opened); assert.deepEqual(f.dug, []); assert.deepEqual(f.attacked, []);
});

test('protected melons and missing food never authorize unrelated harvesting or claim food acquisition', async () => {
  const f = fixture(); f.add('melon', 8); f.s.checkpoint.protectedPositions = [{ x: 8, y: 64, z: 0 }];
  await assert.rejects(f.executor.ensureFood(f.s), (error: unknown) => error instanceof ConditionWait && error.checkpoint.missingFood === true && Array.isArray(error.checkpoint.resourceNames) && error.checkpoint.resourceNames.includes('melon'));
  assert.deepEqual(f.dug, []); assert.deepEqual(f.crafted, []); assert.equal(f.stock.size, 0);
});

test('a blocked warehouse with no natural food records exact access observations and waits without discarding its reason', async () => {
  const f = fixture({ warehouse: true, food: { bread: 8 } });
  f.s.near = async () => { throw new ConditionWait('warehouse route blocked'); };
  await assert.rejects(f.executor.ensureFood(f.s), (error: unknown) => {
    assert.ok(error instanceof ConditionWait); assert.equal(error.checkpoint.foodCause, 'warehouse route blocked');
    const positions = error.checkpoint.resourcePositions as { x: number; y: number; z: number }[];
    assert.ok(positions.some(p => p.x === 2 && p.y === 64 && p.z === 0)); return true;
  });
  assert.ok(f.s.observations.some(o => o.kind === 'blocks' && o.data.blocks.some(b => b.name === 'chest')));
  assert.equal(f.opened, 0); assert.equal(f.withdrawn, 0); assert.deepEqual(f.dug, []); assert.equal(f.s.checkpoint.foodWarehouse, undefined);
});
