import assert from 'node:assert/strict';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';

test('actual 26.1 fuel variants prepare glass from the last available natural wood within the shared evaluation budget', async () => {
  const data = minecraftData('26.1'), Recipe = require('prismarine-recipe')(data).Recipe;
  const fuels = Object.keys(data.itemsByName).filter(name => name.endsWith('_planks') && !['crimson_planks', 'warped_planks', 'bamboo_planks'].includes(name));
  const wood = fuels.at(-1)!.replace('_planks', ''), stock = new Map<string, number>([['sand', 2], ['furnace', 1]]), cells = new Map<string, string>();
  const trunk = new Vec3(10, 64, 0); cells.set(trunk.toString(), `${wood}_log`); cells.set(trunk.offset(0, 3, 0).toString(), `${wood}_leaves`);
  let held = '', output = 0, queryCount = 0, opened = 0, closed = 0;
  const entity = { position: new Vec3(0.5, 64, 0.5) }, dug: string[] = [], crafted: string[] = [];
  const blockAt = (p: Vec3) => {
    const position = p.floored(), name = cells.get(position.toString()) ?? (position.y <= 63 ? 'dirt' : 'air');
    return { position, name, type: data.blocksByName[name]!.id, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true, getProperties: () => ({}) };
  };
  const inventoryItems = () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: data.itemsByName[name]!.id, stackSize: 64 }));
  const bot = {
    entity, entities: {}, registry: data, world: { raycast: () => null },
    inventory: { items: inventoryItems, emptySlotCount: () => 36 }, blockAt, canSeeBlock: () => true,
    findBlock(request: { matching(b: ReturnType<typeof blockAt>): boolean; useExtraInfo?(b: ReturnType<typeof blockAt>): boolean }) {
      queryCount++; return [...cells.keys()].map(key => blockAt(new Vec3(...key.slice(1, -1).split(',').map(Number) as [number, number, number]))).find(block => request.matching(block) && (!request.useExtraInfo || request.useExtraInfo(block))) ?? null;
    },
    async equip(item: { name: string }) { held = item.name; },
    async dig(block: ReturnType<typeof blockAt>) { assert.equal(block.name, `${wood}_log`); dug.push(block.name); cells.set(block.position.toString(), 'air'); stock.set(block.name, 1); },
    async placeBlock(reference: ReturnType<typeof blockAt>, face: Vec3) { assert.equal(held, 'furnace'); cells.set(reference.position.plus(face).toString(), held); stock.set(held, stock.get(held)! - 1); },
    recipesAll: (id: number) => Recipe.find(id, null),
    recipesFor: (id: number) => Recipe.find(id, null).filter((recipe: ReturnType<Bot['recipesAll']>[number]) => !recipe.requiresTable && recipe.delta.every(i => i.count >= 0 || (stock.get(data.items[i.id]!.name) ?? 0) >= -i.count)),
    async craft(recipe: ReturnType<Bot['recipesAll']>[number], count: number) {
      assert.equal(count, 1); assert.ok(recipe.delta.every(i => i.count >= 0 || (stock.get(data.items[i.id]!.name) ?? 0) >= -i.count));
      for (const i of recipe.delta) { const name = data.items[i.id]!.name; stock.set(name, (stock.get(name) ?? 0) + i.count); }
      crafted.push(data.items[recipe.result.id]!.name);
    },
    pathfinder: { movements: { canDig: false, allow1by1towers: false }, getPathTo(_movements: unknown, goal: { x: number; y: number; z: number }) {
      const start = entity.position.floored(), target = new Vec3(goal.x, goal.y, goal.z), queue = [start], previous = new Map<string, Vec3 | null>([[start.toString(), null]]);
      let found: Vec3 | undefined;
      for (let index = 0; index < queue.length && index < 10000; index++) {
        const p = queue[index]!; if (p.equals(target)) { found = p; break; }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = p.offset(dx!, 0, dz!);
          if (previous.has(next.toString()) || next.distanceTo(start) > 50 || blockAt(next).boundingBox !== 'empty' || blockAt(next.offset(0, 1, 0)).boundingBox !== 'empty' || blockAt(next.offset(0, -1, 0)).boundingBox !== 'block') continue;
          previous.set(next.toString(), p); queue.push(next);
        }
      }
      const path = [];
      while (found && !found.equals(start)) { path.unshift({ x: found.x, y: found.y, z: found.z, toBreak: [], toPlace: [], parkour: false }); found = previous.get(found.toString())!; }
      return { status: previous.has(target.toString()) ? 'success' : 'noPath', path };
    } },
    async openFurnace() { opened++; return {
      inputItem: () => null, outputItem: () => output ? { name: 'glass', count: output } : null,
      async putInput(type: number, _metadata: unknown, count: number) { assert.equal(type, data.itemsByName.sand!.id); stock.set('sand', stock.get('sand')! - count); },
      async putFuel(type: number, _metadata: unknown, count: number) { assert.equal(type, data.itemsByName[`${wood}_planks`]!.id); assert.equal(count, 2); stock.set(`${wood}_planks`, stock.get(`${wood}_planks`)! - count); output = 2; },
      async takeOutput() { stock.set('glass', output); output = 0; }, async close() { closed++; },
    }; },
  };
  const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'Fuel26Unit' }, rules: {} });
  const executor = new MineflayerExecutor(bot as unknown as Bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => launch.rules.dimension }), s = executor.services(new AbortController().signal);
  s.pause = async () => {}; s.near = async p => { entity.position = new Vec3(p.x, p.y, p.z); };
  await executor.ensureItem('glass', 2, s);
  assert.equal(stock.get('glass'), 2); assert.deepEqual(dug, [`${wood}_log`]); assert.deepEqual(crafted, [`${wood}_planks`]);
  assert.equal(opened, 1); assert.equal(closed, 1); assert.ok(queryCount < 160, 'source scans remain bounded across all twelve real wood variants');
});
