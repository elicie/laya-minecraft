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

test('resource matching handles palette blocks without positions and checks protection on full blocks', async () => {
  let stock = 0;
  let positionChecks = 0;
  const log = { name: 'oak_log', position: new Vec3(2, 64, 0), canHarvest: () => true, getProperties: () => ({}) };
  const bot = {
    inventory: { items: () => stock ? [{ name: 'oak_log', count: stock }] : [], emptySlotCount: () => 36 },
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, players: {}, registry: { itemsByName: { oak_log: { id: 1 } } },
    findBlock(request: { matching: (value: unknown) => boolean; useExtraInfo: (value: unknown) => boolean }) {
      assert.equal(request.matching({ name: 'oak_log', position: null }), true);
      assert.equal(request.useExtraInfo(log), true); positionChecks += 1; return log;
    },
    blockAt(p: Vec3) { return p.y === 65 ? { name: 'oak_leaves' } : p.y === 64 && p.x === 2 ? log : { name: 'air' }; },
    async dig() { stock += 1; }, async equip() {},
  } as unknown as Bot;
  const executor = new MineflayerExecutor(bot, options());
  const services = executor.services(new AbortController().signal); services.pause = async () => {}; services.near = async () => {};
  const task: TaskSpec = { id: 'task', goalId: 'goal', kind: 'collect', params: { item: 'oak_log' }, dependencies: [], reservationKeys: [], completion: { kind: 'inventory', item: 'oak_log', minimum: 1 } };
  const result = await executor.execute(task, services);
  assert.equal(result.outcome, 'completed'); assert.equal(stock, 1); assert.equal(positionChecks, 1);
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
