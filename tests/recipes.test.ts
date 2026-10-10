import test from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, type Position } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';

test('actual 26.1 wood recipes choose observed oak and prepare a table and pickaxe from empty inventory', async () => {
  const data = minecraftData('26.1');
  const Recipe = require('prismarine-recipe')(data).Recipe;
  type RecipeValue = ReturnType<Bot['recipesAll']>[number];
  const recipes = (id: number): RecipeValue[] => Recipe.find(id, null);
  const stock = new Map<string, number>(), dug: string[] = [], crafted: string[] = [];
  const cells = new Map<string, ReturnType<typeof block>>();
  function block(name: string, p: Vec3) {
    return { name, position: p, boundingBox: name === 'air' || name.endsWith('_leaves') ? 'empty' : 'block',
      canHarvest: () => true, getProperties: () => ({}) };
  }
  for (let y = 64; y <= 66; y++) { const p = new Vec3(12, y, 12); cells.set(p.toString(), block('oak_log', p)); }
  const leaves = new Vec3(12, 68, 12); cells.set(leaves.toString(), block('oak_leaves', leaves));
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, players: {}, registry: data,
    inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: data.itemsByName[name]!.id, stackSize: 64 })), emptySlotCount: () => 36 },
    findBlock(request: { matching(value: ReturnType<typeof block>): boolean; useExtraInfo?: (value: ReturnType<typeof block>) => boolean }) {
      return [...cells.values()].find(value => request.matching(value) && (!request.useExtraInfo || request.useExtraInfo(value))) ?? null;
    },
    blockAt(p: Vec3) { return cells.get(p.toString()) ?? block(p.y === 63 ? 'grass_block' : 'air', p); },
    async dig(value: ReturnType<typeof block>) { assert.equal(value.name, 'oak_log'); dug.push(value.name); cells.delete(value.position.toString()); stock.set(value.name, (stock.get(value.name) ?? 0) + 1); },
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
  s.near = async p => { bot.entity.position = new Vec3(p.x, p.y, p.z); };
  const actualRecipes = recipes(data.itemsByName.wooden_pickaxe!.id);
  assert.ok(actualRecipes.length >= 12, 'exercise the full real wood variant list');
  assert.ok(actualRecipes[0]!.delta.some(i => i.count < 0 && data.items[i.id]?.name === 'cherry_planks'));
  await executor.ensureItem('wooden_pickaxe', 1, s);
  assert.equal(executor.count('wooden_pickaxe'), 1);
  assert.ok(crafted.includes('crafting_table'));
  assert.equal(dug.length, 3);
  assert.ok(dug.every(name => name === 'oak_log'));
  assert.ok([...cells.values()].some(value => value.name === 'crafting_table'));
});
