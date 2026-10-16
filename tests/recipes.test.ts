import test from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { WorkerLaunchSchema, type Position } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ConditionWait } from '../packages/minecraft/src/services';

test('actual 26.1 wood recipes choose observed oak and prepare a table and pickaxe from empty inventory', async () => {
  const data = minecraftData('26.1');
  const Recipe = require('prismarine-recipe')(data).Recipe;
  type RecipeValue = ReturnType<Bot['recipesAll']>[number];
  const recipes = (id: number): RecipeValue[] => Recipe.find(id, null);
  const stock = new Map<string, number>(), dug: string[] = [], crafted: string[] = [], checkedPaths: Vec3[][] = [];
  const entity = { position: new Vec3(0.5, 64, 0.5) };
  const cells = new Map<string, ReturnType<typeof block>>();
  function block(name: string, p: Vec3) {
    return { name, position: p, type: data.blocksByName[name]!.id, boundingBox: name === 'air' ? 'empty' : 'block',
      canHarvest: () => true, getProperties: () => ({}) };
  }
  const blockAt = (p: Vec3) => {
    const cell = p.floored();
    if (cell.x < -4 || cell.x > 20 || cell.z < -4 || cell.z > 20 || cell.y < 60 || cell.y > 72) return null;
    return cells.get(cell.toString()) ?? block(cell.y <= 63 ? 'grass_block' : 'air', cell);
  };
  const walkable = (p: Vec3) => blockAt(p)?.boundingBox === 'empty' && blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty' && blockAt(p.offset(0, -1, 0))?.boundingBox === 'block';
  const getPathTo = (_movements: unknown, goal: { x: number; y: number; z: number; rangeSq: number }) => {
    const start = entity.position.floored(), queue = [start], previous = new Map<string, Vec3 | null>([[start.toString(), null]]);
    let found: Vec3 | undefined;
    for (let index = 0; index < queue.length && index < 625; index++) {
      const current = queue[index]!;
      if (current.distanceSquared(new Vec3(goal.x, goal.y, goal.z)) <= goal.rangeSq) { found = current; break; }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = current.offset(dx!, 0, dz!);
        if (previous.has(next.toString()) || !walkable(next)) continue;
        previous.set(next.toString(), current); queue.push(next);
      }
    }
    const path: { x: number; y: number; z: number; toBreak: never[]; toPlace: never[]; parkour: false }[] = [];
    for (let step = found; step && !step.equals(start); step = previous.get(step.toString()) ?? undefined) path.unshift({ x: step.x, y: step.y, z: step.z, toBreak: [], toPlace: [], parkour: false });
    if (found) checkedPaths.push(path.map(step => new Vec3(step.x, step.y, step.z)));
    return { status: found ? 'success' : 'noPath', path };
  };
  const canSeeBlock = (target: ReturnType<typeof block>) => {
    const eyes = entity.position.offset(0, 1.62, 0);
    // Test actual loaded collisions to the six face centres, rather than grant
    // visibility through the other trunk cells or a placed crafting table.
    return [[0.001, 0.5, 0.5], [0.999, 0.5, 0.5], [0.5, 0.001, 0.5], [0.5, 0.999, 0.5], [0.5, 0.5, 0.001], [0.5, 0.5, 0.999]].some(([x, y, z]) => {
      const face = target.position.offset(x!, y!, z!), delta = face.minus(eyes), steps = Math.ceil(delta.norm() / 0.05);
      for (let index = 0; index <= steps; index++) {
        const actual = blockAt(eyes.plus(delta.scaled(index / Math.max(1, steps))));
        if (!actual) return false;
        if (actual.boundingBox === 'block') return actual.position.equals(target.position);
      }
      return false;
    });
  };
  for (let y = 64; y <= 66; y++) { const p = new Vec3(12, y, 12); cells.set(p.toString(), block('oak_log', p)); }
  const leaves = new Vec3(12, 68, 12); cells.set(leaves.toString(), block('oak_leaves', leaves));
  const bot = {
    entity, entities: {}, players: {}, registry: data,
    inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: data.itemsByName[name]!.id, stackSize: 64 })), emptySlotCount: () => 36 },
    findBlock(request: { matching(value: ReturnType<typeof block>): boolean; useExtraInfo?: (value: ReturnType<typeof block>) => boolean }) {
      return [...cells.values()].find(value => request.matching(value) && (!request.useExtraInfo || request.useExtraInfo(value))) ?? null;
    },
    blockAt, canSeeBlock, async equip() {},
    pathfinder: { movements: { canDig: false, allow1by1towers: false }, getPathTo },
    async dig(value: ReturnType<typeof block>) { assert.equal(value.name, 'oak_log'); assert.ok(canSeeBlock(value), 'a log must actually be visible before digging'); assert.ok(walkable(entity.position.floored())); dug.push(value.name); cells.delete(value.position.toString()); stock.set(value.name, (stock.get(value.name) ?? 0) + 1); },
    recipesAll: (id: number) => recipes(id),
    recipesFor(id: number, _metadata: unknown, _minimum: number, table?: unknown) {
      return recipes(id).filter(recipe => (!recipe.requiresTable || !!table) && recipe.delta.every(i => i.count >= 0 || (stock.get(data.items[i.id]!.name) ?? 0) >= -i.count));
    },
    async craft(recipe: RecipeValue, count: number) {
      assert.equal(count, 1);
      for (const i of recipe.delta) if (i.count < 0) assert.ok((stock.get(data.items[i.id]!.name) ?? 0) >= -i.count, 'only genuinely prepared ingredients may be crafted');
      for (const i of recipe.delta) { const name = data.items[i.id]!.name; stock.set(name, (stock.get(name) ?? 0) + i.count); }
      crafted.push(data.items[recipe.result.id]!.name);
    },
  } as unknown as Bot;
  class RecipeExecutor extends MineflayerExecutor {
    override async place(p: Position, itemName: string, expectedName: string | undefined): Promise<void> {
      assert.ok((stock.get(itemName) ?? 0) >= 1);
      stock.set(itemName, stock.get(itemName)! - 1);
      const point = new Vec3(p.x, p.y, p.z); cells.set(point.toString(), block(expectedName ?? itemName, point));
    }
  }
  const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'Recipe26Check' }, rules: {} });
  const executor = new RecipeExecutor(bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => 'overworld' });
  const s = executor.services(new AbortController().signal);
  s.pause = async () => {};
  s.near = async (p, radius = 2) => {
    if (entity.position.distanceTo(new Vec3(p.x, p.y, p.z)) <= radius + 0.5) return;
    const result = getPathTo(bot.pathfinder.movements, new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), radius));
    if (result.status !== 'success') throw new ConditionWait('테스트의 실제 관측 지면에서 걸을 경로가 없습니다.');
    for (const step of result.path) { const point = new Vec3(step.x, step.y, step.z); assert.ok(walkable(point)); entity.position = point.offset(0.5, 0, 0.5); }
  };
  const actualRecipes = recipes(data.itemsByName.wooden_pickaxe!.id);
  assert.ok(actualRecipes.length >= 12, 'exercise the full real wood variant list');
  assert.ok(actualRecipes[0]!.delta.some(i => i.count < 0 && data.items[i.id]?.name === 'cherry_planks'));
  await executor.ensureItem('wooden_pickaxe', 1, s);
  assert.equal(executor.count('wooden_pickaxe'), 1);
  assert.ok(crafted.includes('crafting_table'));
  assert.equal(dug.length, 3);
  assert.ok(dug.every(name => name === 'oak_log'));
  assert.ok([...cells.values()].some(value => value.name === 'crafting_table'));
  assert.ok(checkedPaths.some(path => path.length > 10), 'bootstrap walks on the observed ground to the oak tree');
  assert.ok(checkedPaths.every(path => path.every((p, index) => !index || p.distanceTo(path[index - 1]!) === 1)), 'all simulated moves use adjacent ground cells');
});
