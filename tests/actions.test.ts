import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, type TaskSpec } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ActionFailure, ConditionWait } from '../packages/minecraft/src/services';

function options() {
  const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'ActionBot' }, rules: {} });
  return { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => 'overworld' };
}

function navigation(bot: object, sources: Vec3[] = []) {
  const b = bot as { entity: { position: Vec3 }; blockAt(p: Vec3): { name: string; boundingBox?: string }; };
  Object.assign(bot, { canSeeBlock: () => true, findBlocks: (request: { matching(block: unknown): boolean }) => sources.filter(p => request.matching(b.blockAt(p))), pathfinder: {
    movements: { canDig: false, allow1by1towers: false }, getPathTo(_movements: unknown, goal: { x: number; y: number; z: number }) {
      const start = b.entity.position.floored(), target = new Vec3(goal.x, goal.y, goal.z), queue = [start], previous = new Map<string, Vec3 | null>([[start.toString(), null]]);
      let found: Vec3 | undefined;
      for (let index = 0; index < queue.length && index < 10000; index++) {
        const current = queue[index]; if (current.equals(target)) { found = current; break; }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = current.offset(dx!, 0, dz!);
          if (previous.has(next.toString()) || Math.abs(next.x - start.x) > 50 || Math.abs(next.z - start.z) > 50 || b.blockAt(next).boundingBox !== 'empty' || b.blockAt(next.offset(0, 1, 0)).boundingBox !== 'empty' || b.blockAt(next.offset(0, -1, 0)).boundingBox !== 'block') continue;
          previous.set(next.toString(), current); queue.push(next);
        }
      }
      const path = [];
      while (found && !found.equals(start)) { path.unshift({ x: found.x, y: found.y, z: found.z, toBreak: [], toPlace: [], parkour: false }); found = previous.get(found.toString())!; }
      return { status: previous.has(target.toString()) ? 'success' : 'noPath', path };
    },
  } });
}

function woodRecipeFixture(observed: string[], initial: Record<string, number> = {}) {
  const woods = ['cherry', 'oak', 'birch'], names = [...woods.flatMap(wood => [`${wood}_log`, `${wood}_planks`]), 'stick', 'crafting_table', 'wooden_pickaxe'];
  const ids = Object.fromEntries(names.map((name, index) => [name, index + 1]));
  const stock = new Map(Object.entries(initial)), cells = new Map<string, string>(), locations: Vec3[] = [];
  const crafted: string[] = [], dug: string[] = [];
  let held = '', blockedWood = '', failCraft = false, queries = 0;
  const recipe = (output: string, count: number, ingredients: Record<string, number>, requiresTable = false) => ({ requiresTable, result: { id: ids[output], count }, delta: [...Object.entries(ingredients).map(([item, quantity]) => ({ id: ids[item], count: -quantity })), { id: ids[output], count }] });
  const recipes = new Map<number, ReturnType<typeof recipe>[]>();
  for (const wood of woods) recipes.set(ids[`${wood}_planks`], [recipe(`${wood}_planks`, 4, { [`${wood}_log`]: 1 })]);
  recipes.set(ids.stick, woods.map(wood => recipe('stick', 4, { [`${wood}_planks`]: 2 })));
  recipes.set(ids.crafting_table, woods.map(wood => recipe('crafting_table', 1, { [`${wood}_planks`]: 4 })));
  recipes.set(ids.wooden_pickaxe, woods.map(wood => recipe('wooden_pickaxe', 1, { [`${wood}_planks`]: 3, stick: 2 }, true)));
  for (const wood of observed) for (let i = 0; i < 8; i++) {
    const p = new Vec3(10 + i, 64, woods.indexOf(wood) * 6);
    cells.set(p.toString(), `${wood}_log`); cells.set(p.offset(0, 1, 0).toString(), `${wood}_leaves`); locations.push(p);
  }
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, world: { raycast: () => null },
    inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: ids[name] })), emptySlotCount: () => 36 },
    registry: { itemsByName: Object.fromEntries(names.map(name => [name, { id: ids[name] }])), items: Object.fromEntries(names.map(name => [ids[name], { name }])) },
    blockAt(p: Vec3) { const name = cells.get(p.toString()) ?? (p.y === 63 ? 'dirt' : 'air'); return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true, getProperties: () => ({}) }; },
    findBlock(request: { matching: (block: unknown) => boolean; useExtraInfo?: (block: unknown) => boolean }) {
      queries++;
      for (const p of locations) { const block = bot.blockAt(p); if (request.matching(block) && (!request.useExtraInfo || request.useExtraInfo(block))) return block; }
      return null;
    },
    recipesAll(id: number) { return recipes.get(id) ?? []; },
    recipesFor(id: number, _metadata: unknown, _count: number, table: unknown) { return this.recipesAll(id).filter(r => (!r.requiresTable || table) && r.delta.filter(i => i.count < 0).every(i => (stock.get(names[i.id - 1]) ?? 0) >= -i.count)); },
    async equip(item: { name: string }) { held = item.name; },
    async placeBlock(reference: { position: Vec3 }, face: Vec3) { const p = reference.position.plus(face); locations.push(p); cells.set(p.toString(), held); stock.set(held, (stock.get(held) ?? 0) - 1); },
    async dig(block: { name: string; position: Vec3 }) { dug.push(block.name); cells.set(block.position.toString(), 'air'); stock.set(block.name, (stock.get(block.name) ?? 0) + 1); },
    async craft(r: ReturnType<typeof recipe>) {
      if (failCraft) throw new ActionFailure('제작 응답이 확인되지 않았습니다.', 'CRAFT_UNCERTAIN', false, false);
      assert.ok(r.delta.filter(i => i.count < 0).every(i => (stock.get(names[i.id - 1]) ?? 0) >= -i.count));
      for (const delta of r.delta) stock.set(names[delta.id - 1], (stock.get(names[delta.id - 1]) ?? 0) + delta.count);
      crafted.push(names[r.result.id - 1]);
    },
  };
  navigation(bot, locations);
  const executor = new MineflayerExecutor(bot as unknown as Bot, options()), services = executor.services(new AbortController().signal);
  services.pause = async () => {};
  services.near = async p => { if (blockedWood && locations.some(q => bot.blockAt(q).name === `${blockedWood}_log` && q.distanceTo(new Vec3(p.x, p.y, p.z)) < 4)) throw new ConditionWait('NoPath'); bot.entity.position = new Vec3(p.x, p.y, p.z); };
  return { executor, services, bot, stock, cells, locations, crafted, dug, get queries() { return queries; }, set blockedWood(value: string) { blockedWood = value; }, set failCraft(value: boolean) { failCraft = value; } };
}

test('empty inventory builds a crafting table and pickaxe from observed oak or birch despite a cherry-first recipe order', async () => {
  for (const wood of ['oak', 'birch']) {
    const f = woodRecipeFixture([wood]);
    f.services.checkpoint.missingResource = 'cherry_log'; f.services.checkpoint.resourceNames = ['cherry_log'];
    await f.executor.ensureItem('wooden_pickaxe', 1, f.services);
    assert.equal(f.stock.get('wooden_pickaxe'), 1); assert.ok(f.crafted.includes('crafting_table'));
    assert.ok(f.dug.length > 0); assert.ok(f.dug.every(name => name === `${wood}_log`));
    assert.equal(f.services.checkpoint.missingResource, undefined); assert.equal(f.services.checkpoint.resourceNames, undefined);
    assert.ok(f.queries < 100, 'the shared read-only source cache must bound repeated wood probes');
  }
});

test('recipe selection uses inventory first and known preparation failures can choose another observed wood', async () => {
  const stocked = woodRecipeFixture(['oak'], { birch_planks: 16 });
  await stocked.executor.ensureItem('wooden_pickaxe', 1, stocked.services);
  assert.equal(stocked.stock.get('wooden_pickaxe'), 1); assert.deepEqual(stocked.dug, []);
  const blocked = woodRecipeFixture(['oak', 'birch']); blocked.blockedWood = 'oak';
  await blocked.executor.ensureItem('wooden_pickaxe', 1, blocked.services);
  assert.equal(blocked.stock.get('wooden_pickaxe'), 1); assert.ok(blocked.dug.every(name => name === 'birch_log'));
});

test('unavailable wood recipes watch all raw alternatives and never mine constructed planks or protected logs', async () => {
  const f = woodRecipeFixture(['cherry']);
  const placed = new Vec3(30, 64, 0); f.locations.push(placed); f.cells.set(placed.toString(), 'oak_planks');
  f.services.checkpoint.buildProtection = { origin: { x: 10, y: 64, z: 0 }, width: 8, depth: 1, height: 4 };
  f.services.checkpoint.missingResource = 'cherry_log';
  await assert.rejects(f.executor.ensureItem('wooden_pickaxe', 1, f.services), (error: unknown) => {
    assert.ok(error instanceof ConditionWait);
    assert.equal(error.checkpoint.missingResource, undefined); assert.equal(error.checkpoint.missingItem, 'wooden_pickaxe');
    assert.ok(['oak_log', 'birch_log', 'cherry_log'].every(name => (error.checkpoint.resourceNames as string[]).includes(name)));
    return true;
  });
  assert.equal(f.services.checkpoint.missingResource, undefined);
  assert.deepEqual(f.dug, []); assert.deepEqual(f.crafted, []); assert.equal(f.cells.get(placed.toString()), 'oak_planks');
});

test('unknown crafting results and collect restrictions do not cause alternative world actions', async () => {
  const uncertain = woodRecipeFixture(['oak', 'birch']); uncertain.failCraft = true;
  await assert.rejects(uncertain.executor.ensureItem('wooden_pickaxe', 1, uncertain.services), (error: unknown) => error instanceof ActionFailure && error.code === 'CRAFT_UNCERTAIN');
  assert.ok(uncertain.dug.every(name => name === 'oak_log')); assert.deepEqual(uncertain.crafted, []);
  const restricted = woodRecipeFixture(['oak']); restricted.executor.options.config.allowedActions = ['craft'];
  await assert.rejects(restricted.executor.ensureItem('wooden_pickaxe', 1, restricted.services), ConditionWait);
  assert.deepEqual(restricted.dug, []); assert.deepEqual(restricted.crafted, []);
});

test('food preparation uses actual mature potatoes or beetroots and verifies their consumption', async () => {
  for (const [crop, item, age] of [['potatoes', 'potato', 7], ['beetroots', 'beetroot', 3]] as const) {
    let count = 0, held = '', digCount = 0;
    const cropBlock = { name: crop, position: new Vec3(2, 64, 0), boundingBox: 'empty', canHarvest: () => true, getProperties: () => ({ age }) };
    const bot = {
      health: 5, food: 17, entity: { position: new Vec3(0, 64, 0) }, entities: {},
      inventory: { items: () => count ? [{ name: item, count }] : [], emptySlotCount: () => 36 },
      registry: { itemsByName: { carrot: { id: 1 }, potato: { id: 2 }, beetroot: { id: 3 } }, items: {} },
      findBlock(request: { matching: (b: unknown) => boolean; useExtraInfo?: (b: unknown) => boolean }) { return !digCount && request.matching(cropBlock) && (!request.useExtraInfo || request.useExtraInfo(cropBlock)) ? cropBlock : null; },
      blockAt(p: Vec3) { return p.equals(cropBlock.position) && !digCount ? cropBlock : { name: p.y === 63 ? 'dirt' : 'air', position: p, boundingBox: p.y === 63 ? 'block' : 'empty' }; },
      recipesAll: () => [], async dig() { digCount++; count++; },
      async equip(i: { name: string }) { held = i.name; }, async consume() { assert.equal(held, item); count--; bot.food++; },
    };
    navigation(bot, [cropBlock.position]);
    const executor = new MineflayerExecutor(bot as unknown as Bot, options()), services = executor.services(new AbortController().signal);
    services.near = async () => {}; services.pause = async () => {};
    await executor.ensureFood(services); assert.equal(digCount, 1); assert.equal(count, 1);
    assert.equal(await executor.eat(services), true); assert.equal(bot.food, 18); assert.equal(count, 0);
  }
});

test('food availability probes do not hunt at critical health or swallow unknown preparation effects', async () => {
  const f = woodRecipeFixture([]); f.bot.registry.itemsByName.potato = { id: 100 }; f.bot.registry.itemsByName.beef = { id: 101 };
  Object.assign(f.bot, { entities: { 2: { name: 'cow', position: new Vec3(30, 64, 0) } } });
  const foodBot = f.bot as typeof f.bot & { health: number; food: number };
  foodBot.health = 5; foodBot.food = 17;
  await assert.rejects(f.executor.ensureFood(f.services), (error: unknown) => error instanceof ConditionWait && /현재 관측한 범위/.test(error.message));
  assert.deepEqual(f.dug, []);
  const raw = { name: 'potatoes', position: new Vec3(2, 64, 0), boundingBox: 'empty', canHarvest: () => true, getProperties: () => ({ age: 7 }) };
  f.bot.findBlock = request => request.matching(raw) ? raw : null;
  f.executor.ensureItem = async () => { throw new ActionFailure('효과 미확인', 'UNKNOWN', false, false); };
  await assert.rejects(f.executor.ensureFood(f.services), (error: unknown) => error instanceof ActionFailure && error.code === 'UNKNOWN');
});

test('resource matching handles palette blocks without positions and checks protection on full blocks', async () => {
  let stock = 0;
  let positionChecks = 0;
  const log = { name: 'oak_log', position: new Vec3(2, 64, 0), boundingBox: 'block', canHarvest: () => true, getProperties: () => ({}) };
  const bot = {
    inventory: { items: () => stock ? [{ name: 'oak_log', count: stock }] : [], emptySlotCount: () => 36 },
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, players: {}, registry: { itemsByName: { oak_log: { id: 1 } } },
    findBlock(request: { matching: (value: unknown) => boolean; useExtraInfo: (value: unknown) => boolean }) {
      assert.equal(request.matching({ name: 'oak_log', position: null }), true);
      assert.equal(request.useExtraInfo(log), true); positionChecks += 1; return log;
    },
    blockAt(p: Vec3) { return p.equals(log.position.offset(0, 1, 0)) ? { name: 'oak_leaves', boundingBox: 'block' } : p.equals(log.position) ? log : { name: p.y === 63 ? 'dirt' : 'air', position: p, boundingBox: p.y === 63 ? 'block' : 'empty' }; },
    async dig() { stock += 1; }, async equip() {},
  } as unknown as Bot;
  navigation(bot, [log.position]);
  const executor = new MineflayerExecutor(bot, options());
  const services = executor.services(new AbortController().signal); services.pause = async () => {}; services.near = async () => {};
  const task: TaskSpec = { id: 'task', goalId: 'goal', kind: 'collect', params: { item: 'oak_log' }, dependencies: [], reservationKeys: [], completion: { kind: 'inventory', item: 'oak_log', minimum: 1 } };
  const result = await executor.execute(task, services);
  assert.equal(result.outcome, 'completed'); assert.equal(stock, 1); assert.equal(positionChecks, 1);
});

test('collection reobserves falling upper-log drops before navigating and confirms inventory instead of mining another tree', async () => {
  let stock = 0, broken = false, falling = false, descent = 0, pickups = 0;
  const source = new Vec3(2, 66, 0), drop = { name: 'item', position: source.offset(0.5, 0.2, 0.5) };
  const blockAt = (p: Vec3) => {
    const name = p.equals(source) && !broken ? 'oak_log' : p.equals(source.offset(0, 1, 0)) ? 'oak_leaves' : p.y === 63 ? 'dirt' : 'air';
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true, getProperties: () => ({}) };
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, entities: {} as Record<number, typeof drop>, blockAt,
    inventory: { items: () => stock ? [{ name: 'oak_log', count: stock }] : [], emptySlotCount: () => 36 },
    registry: { itemsByName: { oak_log: { id: 1 } } },
    findBlock: () => broken ? null : blockAt(source),
    async dig() { broken = true; falling = true; bot.entities[2] = drop; },
  };
  navigation(bot, [source]);
  const executor = new MineflayerExecutor(bot as unknown as Bot, options()), services = executor.services(new AbortController().signal);
  services.pause = async () => { if (falling) { descent++; if (descent >= 4) drop.position.y = 64.15; } };
  services.near = async (_p, radius) => {
    if (radius === 0 && broken) { assert.equal(Math.floor(drop.position.y), 64, 'a floating item must never be used as a stand target'); pickups++; stock++; delete bot.entities[2]; }
  };
  await executor.ensureItem('oak_log', 1, services);
  assert.equal(stock, 1); assert.equal(pickups, 1); assert.ok(descent >= 4);
});

test('recursive construction gathering preserves the selected foundation and exit ground', async () => {
  let stock = 0;
  const block = (x: number) => ({ name: 'stone', boundingBox: 'block', position: new Vec3(x, 63, 0), canHarvest: () => true, getProperties: () => ({}) });
  const protectedStone = block(0), outsideStone = block(4);
  const bot = {
    inventory: { items: () => stock ? [{ name: 'cobblestone', count: stock }] : [], emptySlotCount: () => 36 },
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, registry: { itemsByName: { cobblestone: { id: 1 } } },
    findBlock(request: { useExtraInfo: (b: unknown) => boolean }) { assert.equal(request.useExtraInfo(protectedStone), false); assert.equal(request.useExtraInfo(outsideStone), true); return outsideStone; },
    blockAt(p: Vec3) { return p.equals(outsideStone.position) ? outsideStone : { name: p.y === 63 ? 'dirt' : 'air', position: p, boundingBox: p.y === 63 ? 'block' : 'empty' }; },
    async equip() {}, async dig(b: unknown) { assert.equal(b, outsideStone); stock++; },
  } as unknown as Bot;
  navigation(bot, [outsideStone.position]);
  const executor = new MineflayerExecutor(bot, options());
  const services = executor.services(new AbortController().signal, { buildProtection: { origin: { x: 0, y: 64, z: 0 }, width: 2, depth: 2, height: 4 } });
  services.near = async p => { bot.entity.position = new Vec3(p.x, p.y, p.z); }; services.pause = async () => {};
  await executor.ensureItem('cobblestone', 1, services);
  assert.equal(stock, 1);
});

test('recursive crafting places its utility outside the selected building and approach ring', async () => {
  const stock = new Map([['crafting_table', 1], ['oak_planks', 3], ['stick', 2]]), cells = new Map<string, string>();
  const recipe = { requiresTable: true, result: { id: 4, count: 1 }, delta: [{ id: 2, count: -3 }, { id: 3, count: -2 }, { id: 4, count: 1 }] };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, world: { raycast: () => null },
    inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) },
    registry: { itemsByName: { wooden_pickaxe: { id: 4 } }, items: { 2: { name: 'oak_planks' }, 3: { name: 'stick' }, 4: { name: 'wooden_pickaxe' } } },
    findBlock: () => null, recipesAll: () => [recipe], recipesFor: () => [recipe],
    blockAt(p: Vec3) { const name = cells.get(p.toString()) ?? (p.y === 63 ? 'stone' : 'air'); return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }; },
    async equip() {},
    async placeBlock(reference: { position: Vec3 }, face: Vec3) {
      const p = reference.position.plus(face);
      assert.ok(p.x < -4 || p.x > 4 || p.z < -3 || p.z > 3, `utility must preserve construction space: ${p}`);
      cells.set(p.toString(), 'crafting_table'); stock.set('crafting_table', 0);
    },
    async craft(_recipe: unknown, _count: number, table: { position: Vec3 }) { assert.equal(cells.get(table.position.toString()), 'crafting_table'); stock.set('wooden_pickaxe', 1); },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, options());
  const services = executor.services(new AbortController().signal, { buildProtection: { origin: { x: -3, y: 64, z: -2 }, width: 7, depth: 5, height: 4 } });
  services.near = async p => { bot.entity.position = new Vec3(p.x, p.y, p.z); };
  await executor.ensureItem('wooden_pickaxe', 1, services);
  assert.equal(stock.get('wooden_pickaxe'), 1); assert.equal(cells.size, 1);
});

test('collection returns to a fresh resource after recursively gathering and crafting its missing tool', async () => {
  for (const lavaAfterCraft of [false, true]) {
    const stock = new Map<string, number>(), cells = new Map<string, string>();
    const resource = new Vec3(2, 64, 0), logs = [20, 22, 24].map(x => new Vec3(x, 64, 0)), utilities: Vec3[] = [];
    let lava = false;
    let heldType: number | null = null;
    const ids = { cobblestone: 1, oak_log: 2, oak_planks: 3, stick: 4, crafting_table: 5, wooden_pickaxe: 6 };
    const recipes = {
      3: { requiresTable: false, result: { id: 3, count: 4 }, delta: [{ id: 2, count: -1 }, { id: 3, count: 4 }] },
      4: { requiresTable: false, result: { id: 4, count: 4 }, delta: [{ id: 3, count: -2 }, { id: 4, count: 4 }] },
      5: { requiresTable: false, result: { id: 5, count: 1 }, delta: [{ id: 3, count: -4 }, { id: 5, count: 1 }] },
      6: { requiresTable: true, result: { id: 6, count: 1 }, delta: [{ id: 3, count: -3 }, { id: 4, count: -2 }, { id: 6, count: 1 }] },
    };
    const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
    const bot = {
      entity: { position: new Vec3(0, 64, 0) }, entities: {}, world: { raycast: () => null },
      inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: ids[name as keyof typeof ids] })), emptySlotCount: () => 36 },
      get heldItem() { return heldType === null ? null : { type: heldType }; },
      registry: { itemsByName: Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, { id }])), items: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { name }])) },
      blockAt(p: Vec3) {
        const name = cells.get(p.toString()) ?? (lava && p.equals(resource.offset(0, 1, 0)) ? 'lava' : p.equals(resource) ? 'stone' : logs.some(log => p.equals(log)) ? 'oak_log' : logs.some(log => p.equals(log.offset(0, 1, 0))) ? 'oak_leaves' : p.y === 63 ? 'dirt' : 'air');
        return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: (type: number | null) => name !== 'stone' || type === ids.wooden_pickaxe, getProperties: () => ({}) };
      },
      findBlock(request: { matching: (b: unknown) => boolean; useExtraInfo?: (b: unknown) => boolean }) {
        for (const p of [resource, ...logs, ...utilities]) {
          const b = bot.blockAt(p); if (request.matching(b) && (!request.useExtraInfo || request.useExtraInfo(b))) return b;
        }
        return null;
      },
      recipesAll(id: number) { return id in recipes ? [recipes[id as keyof typeof recipes]] : []; },
      recipesFor(id: number) { return this.recipesAll(id); },
      async equip(item: { type: number }) { heldType = item.type; },
      async placeBlock(reference: { position: Vec3 }, face: Vec3) { const p = reference.position.plus(face); cells.set(p.toString(), 'crafting_table'); utilities.push(p); stock.set('crafting_table', (stock.get('crafting_table') ?? 0) - 1); },
      async craft(recipe: typeof recipes[3]) {
        for (const delta of recipe.delta) stock.set(names[delta.id], (stock.get(names[delta.id]) ?? 0) + delta.count);
        if (recipe.result.id === ids.wooden_pickaxe && lavaAfterCraft) lava = true;
      },
      async dig(b: { name: string; position: Vec3 }) {
        assert.ok(bot.entity.position.distanceTo(b.position) <= 4.5, 'missing tool acquisition must return to an actually reachable resource');
        if (b.name === 'stone') { assert.equal(lava, false, 'a hazard appearing during tool preparation must prevent mining'); assert.equal(heldType, ids.wooden_pickaxe); stock.set('cobblestone', 1); cells.set(resource.toString(), 'air'); }
        else { stock.set('oak_log', (stock.get('oak_log') ?? 0) + 1); cells.set(b.position.toString(), 'air'); }
      },
    };
    navigation(bot, [resource, ...logs]);
    const executor = new MineflayerExecutor(bot as unknown as Bot, options());
    const services = executor.services(new AbortController().signal);
    services.near = async p => { bot.entity.position = new Vec3(p.x, p.y, p.z); }; services.pause = async () => {};
    if (lavaAfterCraft) await assert.rejects(executor.ensureItem('cobblestone', 1, services), (error: unknown) => error instanceof ConditionWait && error.checkpoint.missingResource === 'cobblestone');
    else await executor.ensureItem('cobblestone', 1, services);
    assert.equal(stock.get('cobblestone') ?? 0, lavaAfterCraft ? 0 : 1); assert.equal(stock.get('wooden_pickaxe'), 1);
  }
});

test('placement selects a visible support face and known refusal waits instead of claiming unknown effects', async () => {
  const target = new Vec3(0, 64, 0);
  let name = 'air';
  let refuse = false;
  let stock = 3;
  const calls: Vec3[] = [];
  const stone = (p: Vec3) => ({ name: 'stone', position: p, boundingBox: 'block' });
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 2) }, inventory: { items: () => [{ name: 'oak_planks', count: stock }] },
    world: { raycast(_start: Vec3, direction: Vec3) { return direction.x > 0.1 ? { position: new Vec3(1, 64, 1), face: 0 } : null; } },
    blockAt(p: Vec3) { return p.equals(target) ? { name, position: target, boundingBox: name === 'air' ? 'empty' : 'block' } : p.equals(target.offset(0, -1, 0)) || p.equals(target.offset(-1, 0, 0)) ? stone(p) : { name: 'air', position: p, boundingBox: 'empty' }; },
    async equip() {},
    async placeBlock(_reference: unknown, face: Vec3) { calls.push(face); if (refuse) throw new Error('Server refused block placement'); name = 'oak_planks'; stock -= 1; },
  }) as unknown as Bot;
  const executor = new MineflayerExecutor(bot, options());
  const services = executor.services(new AbortController().signal); services.near = async () => {};
  await executor.place(target, 'oak_planks', 'oak_planks', services, { x: 0, y: 1, z: 0 });
  assert.ok(calls[0]?.equals(new Vec3(1, 0, 0)));
  assert.equal(name, 'oak_planks');
  name = 'air'; refuse = true;
  await assert.rejects(executor.place(target, 'oak_planks', 'oak_planks', services), (error: unknown) => error instanceof ConditionWait && /설치.*거부/.test(error.message));
});

test('placement moves outside its own body and tries another observed face after a known refusal', async () => {
  const target = new Vec3(0, 64, 0);
  let name = 'air', moves = 0, attempts = 0, stock = 3;
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8 },
    inventory: { items: () => [{ name: 'oak_planks', count: stock }] },
    world: { raycast: () => null },
    blockAt(p: Vec3) {
      if (p.equals(target)) return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' };
      const solid = p.y === 63 || p.equals(target.offset(-1, 0, 0));
      return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty' };
    },
    async equip() {},
    async placeBlock() {
      assert.ok(Math.abs(bot.entity.position.x - 0.5) > 0.8 || Math.abs(bot.entity.position.z - 0.5) > 0.8);
      attempts += 1;
      if (attempts === 1) throw new Error('Server refused block placement');
      name = 'oak_planks'; stock -= 1;
    },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, options());
  const services = executor.services(new AbortController().signal);
  services.near = async p => { bot.entity.position = new Vec3(p.x, p.y, p.z); moves += 1; };
  // Keep the initial reach check from moving onto the block being installed.
  const near = services.near;
  services.near = async (p, radius) => { if (radius === 0) await near(p, radius); };
  await executor.place(target, 'oak_planks', 'oak_planks', services);
  assert.ok(moves > 0); assert.equal(attempts, 2); assert.equal(name, 'oak_planks');
});

test('craft waits for the final public inventory update after the crafting promise resolves', async () => {
  let planks = 0, craftCalls = 0;
  const recipe = { requiresTable: false, result: { id: 2, count: 4 }, delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }] };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'oak_log', count: 2 }, ...(planks ? [{ name: 'oak_planks', count: planks }] : [])] },
    registry: { itemsByName: { oak_log: { id: 1 }, oak_planks: { id: 2 } }, items: { 1: { name: 'oak_log' }, 2: { name: 'oak_planks' } } },
    findBlock: () => null, recipesAll: () => [recipe], recipesFor: () => [recipe],
    async craft(_recipe: unknown, count: number) { craftCalls += 1; assert.equal(count, 1); setTimeout(() => { planks += 4; }, 175); },
  } as unknown as Bot;
  const executor = new MineflayerExecutor(bot, options());
  const services = executor.services(new AbortController().signal);
  await executor.ensureItem('oak_planks', 8, services);
  assert.equal(planks, 8); assert.equal(craftCalls, 2);
  assert.ok(services.observations.some(observation => observation.kind === 'inventory'));
});

test('placement confirms late slot consumption before switching from an exhausted stack', async () => {
  const stacks = [1, 2], blocks = new Map<string, string>(), selected: number[] = [];
  let held = 0;
  const bot = {
    entity: { position: new Vec3(0.5, 64, 2.5) },
    inventory: { items: () => stacks.flatMap((count, slot) => count > 0 ? [{ name: 'oak_planks', count, slot }] : []) },
    world: { raycast: () => null },
    blockAt(p: Vec3) { const name = blocks.get(p.toString()) ?? (p.y === 63 ? 'stone' : 'air'); return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }; },
    async equip(item: { slot: number }) { held = item.slot; },
    async placeBlock(reference: { position: Vec3 }, face: Vec3) {
      assert.ok(stacks[held] > 0, 'an exhausted stack must not be reused');
      selected.push(held); blocks.set(reference.position.plus(face).toString(), 'oak_planks');
      const slot = held; setTimeout(() => { stacks[slot] -= 1; }, 175);
    },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, options());
  const services = executor.services(new AbortController().signal); services.near = async () => {};
  await executor.place(new Vec3(0, 64, 0), 'oak_planks', 'oak_planks', services);
  await executor.place(new Vec3(1, 64, 0), 'oak_planks', 'oak_planks', services);
  assert.deepEqual(selected, [0, 1]); assert.deepEqual(stacks, [0, 1]);
});

test('missing placement acknowledgements and unexplained material loss never retry blindly', async () => {
  for (const consumed of [false, true]) {
    let stock = 3, calls = 0;
    const bot = {
      entity: { position: new Vec3(0.5, 64, 2.5) }, inventory: { items: () => [{ name: 'oak_planks', count: stock }] },
      world: { raycast: () => null },
      blockAt(p: Vec3) { return { name: p.y === 63 ? 'stone' : 'air', position: p, boundingBox: p.y === 63 ? 'block' : 'empty' }; },
      async equip() {},
      async placeBlock() { calls += 1; if (consumed) stock -= 1; throw new Error(consumed ? 'Server refused to place block' : 'Server did not answer the placement'); },
    };
    const executor = new MineflayerExecutor(bot as unknown as Bot, options());
    const services = executor.services(new AbortController().signal); services.near = async () => {};
    await assert.rejects(executor.place(new Vec3(0, 64, 0), 'oak_planks', 'oak_planks', services), (error: unknown) => error instanceof ActionFailure && error.code === 'PLACE_UNCERTAIN' && !error.effectsKnown && error.message.includes('inventoryDelta'));
    assert.equal(calls, 1);
  }
});
