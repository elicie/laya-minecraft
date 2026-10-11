import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, blueprint, type TaskSpec } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ActionFailure, ConditionWait } from '../packages/minecraft/src/services';

function fixture() {
  const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'ChestAccessUnit' }, rules: {} });
  const blocks = blueprint('warehouse', { x: 3087, y: 80, z: 3088 });
  const chest = blocks.find(block => block.name === 'chest')!;
  assert.deepEqual(chest.position, { x: 3088, y: 81, z: 3089 });
  const container = { id: 'warehouse', world: launch.rules.world, dimension: launch.rules.dimension, position: chest.position };
  const cells = new Map(blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b.name]));
  const key = (p: { x: number; y: number; z: number }) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const entity = { position: new Vec3(3084.5, 80, 3106.2) };
  let stock = 4, stored = 0, opened = 0, closed = 0, transfers = 0, mutations = 0;
  const inventoryItems = () => stock ? [{ name: 'oak_log', count: stock }] : [];
  const containerItems = () => stored ? [{ name: 'oak_log', count: stored }] : [];
  const blockAt = (p: Vec3) => {
    const position = p.floored();
    if (position.x < 3078 || position.x > 3104 || position.z < 3078 || position.z > 3116 || position.y < 76 || position.y > 88) return null;
    const name = cells.get(key(position)) ?? (position.y <= 79 ? 'dirt' : 'air');
    return { position, name, boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  const walkable = (p: Vec3) => blockAt(p)?.boundingBox === 'empty' && blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty' && blockAt(p.offset(0, -1, 0))?.boundingBox === 'block';
  const getPathTo = (_movement: unknown, goal: { x: number; y: number; z: number; rangeSq: number }) => {
    const start = entity.position.floored(), target = new Vec3(goal.x, goal.y, goal.z), queue = [start], previous = new Map<string, Vec3 | null>([[key(start), null]]);
    let found: Vec3 | undefined;
    for (let index = 0; index < queue.length && index < 1100; index++) {
      const p = queue[index]!; if (p.distanceSquared(target) <= goal.rangeSq) { found = p; break; }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = p.offset(dx!, 0, dz!);
        if (previous.has(key(next)) || !walkable(next)) continue;
        previous.set(key(next), p); queue.push(next);
      }
    }
    const path = [];
    for (let p = found; p && !p.equals(start); p = previous.get(key(p)) ?? undefined) path.unshift({ x: p.x, y: p.y, z: p.z, toBreak: [], toPlace: [], parkour: false });
    return { status: found ? 'success' : 'noPath', path };
  };
  const bot = {
    entity, inventory: { items: inventoryItems }, registry: { itemsByName: { oak_log: { id: 1 } } }, blockAt,
    pathfinder: { movements: { canDig: false, canOpenDoors: false }, getPathTo, setGoal() {},
      async goto(goal: Parameters<typeof getPathTo>[1]) {
        const result = getPathTo(this.movements, goal); if (result.status !== 'success') throw new Error('No path to the goal!');
        for (const step of result.path) { const p = new Vec3(step.x, step.y, step.z); assert.ok(walkable(p)); entity.position = p.offset(0.5, 0, 0.5); }
      },
    },
    async openContainer(block: NonNullable<ReturnType<typeof blockAt>>) {
      assert.equal(block.name, 'chest'); assert.ok(entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4.5);
      opened++;
      return { items: inventoryItems, containerItems,
        async deposit(type: number, _metadata: unknown, count: number) { assert.equal(type, 1); assert.ok(stock >= count); stock -= count; stored += count; transfers++; },
        async withdraw(type: number, _metadata: unknown, count: number) { assert.equal(type, 1); assert.ok(stored >= count); stock += count; stored -= count; transfers++; },
        async close() { closed++; },
      };
    },
    async dig() { mutations++; throw new Error('container access must not break a wall'); },
    async placeBlock() { mutations++; throw new Error('container access must not place an approach block'); },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => launch.rules.dimension });
  const task = (kind: 'store' | 'take'): TaskSpec => ({ id: kind, goalId: 'delivery', kind, params: { destination: container, item: 'oak_log', quantity: 4 }, completion: { kind: 'manual', reason: 'actual transfer proof' }, dependencies: [], reservationKeys: [] });
  return { executor, bot, blocks, container, cells, key, getPathTo, task, get opened() { return opened; }, get closed() { return closed; }, get transfers() { return transfers; }, get mutations() { return mutations; }, get stock() { return stock; }, get stored() { return stored; } };
}

test('actual warehouse exterior has no radius-2 node but radius-3 access observes, stores and takes with real count proofs', async () => {
  const f = fixture();
  const target = f.container.position;
  assert.equal(f.getPathTo({}, new goals.GoalNear(target.x, target.y, target.z, 2)).status, 'noPath');
  assert.equal(f.getPathTo({}, new goals.GoalNear(target.x, target.y, target.z, 3)).status, 'success');
  const before = JSON.stringify([...f.cells]);
  await f.executor.observeContainer(f.container, f.executor.services(new AbortController().signal));
  f.bot.entity.position = new Vec3(3084.5, 80, 3106.2);
  const deposited = await f.executor.execute(f.task('store'), f.executor.services(new AbortController().signal));
  assert.equal(f.stock, 0); assert.equal(f.stored, 4);
  assert.ok(deposited.evidence.some(e => e.kind === 'transfer' && e.beforeInventory === 4 && e.afterInventory === 0 && e.beforeContainer === 0 && e.afterContainer === 4));
  f.bot.entity.position = new Vec3(3084.5, 80, 3106.2);
  const withdrawn = await f.executor.execute(f.task('take'), f.executor.services(new AbortController().signal));
  assert.equal(f.stock, 4); assert.equal(f.stored, 0);
  assert.ok(withdrawn.evidence.some(e => e.kind === 'transfer' && e.beforeInventory === 0 && e.afterInventory === 4 && e.beforeContainer === 4 && e.afterContainer === 0));
  assert.equal(f.opened, 3); assert.equal(f.closed, 3); assert.equal(f.transfers, 2); assert.equal(f.mutations, 0); assert.equal(JSON.stringify([...f.cells]), before);
});

test('registration uses the same exterior interaction access and retains actual full-building proof', async () => {
  const f = fixture();
  const task: TaskSpec = { id: 'registration', goalId: 'warehouse', kind: 'build', params: { mode: 'register-warehouse' }, completion: { kind: 'warehouse', container: f.container, blocks: f.blocks }, dependencies: [], reservationKeys: [] };
  const result = await f.executor.execute(task, f.executor.services(new AbortController().signal));
  assert.equal(result.outcome, 'completed'); assert.equal(f.opened, 1); assert.equal(f.closed, 1); assert.equal(f.mutations, 0);
  assert.ok(result.observations.some(o => o.kind === 'blocks' && o.data.blocks.length === f.blocks.length));
  assert.ok(result.observations.some(o => o.kind === 'container' && o.data.container.id === f.container.id));
});

test('failed arrival, changed container or cancellation never opens or starts a transfer', async () => {
  for (const mode of ['far', 'changed', 'cancelled'] as const) for (const operation of ['observe', 'store', 'take'] as const) {
    const f = fixture(), controller = new AbortController(), s = f.executor.services(controller.signal);
    s.near = async (_p, radius) => {
      assert.equal(radius, 3);
      if (mode === 'far') return;
      f.bot.entity.position = new Vec3(3086.5, 80, 3089.5);
      if (mode === 'changed') f.cells.set(f.key(f.container.position), 'air'); else controller.abort();
    };
    await assert.rejects(operation === 'observe' ? f.executor.observeContainer(f.container, s) : f.executor.execute(f.task(operation), s), error => mode === 'cancelled'
      ? error instanceof ActionFailure && error.code === 'CANCELLED'
      : error instanceof ConditionWait);
    assert.equal(f.opened, 0); assert.equal(f.transfers, 0); assert.equal(f.stock, 4); assert.equal(f.stored, 0); assert.equal(f.mutations, 0);
  }
});
