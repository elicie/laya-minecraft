import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { BuildWaitingForSchema, WorkerLaunchSchema, type TaskSpec } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ActionFailure, ConditionWait } from '../packages/minecraft/src/services';

function fixture() {
  const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'WarehouseUnit' }, rules: {} });
  const container = { id: 'warehouse-goal', world: launch.rules.world, dimension: launch.rules.dimension, position: { x: 2, y: 64, z: 2 } };
  const blocks = [{ position: container.position, name: 'chest' }, { position: { x: 3, y: 63, z: 2 }, name: 'cobblestone' }];
  const cells = new Map(blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b.name]));
  const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
  let opened = 0, closed = 0, effects = 0, afterOpen = () => {};
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => [] },
    blockAt(p: Vec3) { return { name: cells.get(key(p)) ?? (p.y < 64 ? 'dirt' : 'air'), position: p }; },
    async openContainer(block: { name: string }) {
      assert.equal(block.name, 'chest'); opened++; afterOpen();
      return { containerItems: () => [{ name: 'oak_log', count: 3 }], async close() { closed++; } };
    },
    async dig() { effects++; }, async placeBlock() { effects++; }, async craft() { effects++; },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => launch.rules.dimension,
    async villageTask() { throw new Error('registration must not invoke terrain preparation or construction'); } });
  const s = executor.services(new AbortController().signal); s.near = async () => {};
  const task: TaskSpec = { id: 'register', goalId: 'goal', kind: 'build', params: { mode: 'register-warehouse', container, requiredBlocks: blocks, protectedPositions: [{ x: 3, y: 63, z: 2 }] }, completion: { kind: 'warehouse', container, blocks }, dependencies: ['build'], reservationKeys: [] };
  return { task, s, executor, cells, key, container, get opened() { return opened; }, get closed() { return closed; }, get effects() { return effects; }, set afterOpen(fn: () => void) { afterOpen = fn; } };
}

test('warehouse registration requires the full actual building and a public container open and close', async () => {
  const f = fixture(), result = await f.executor.execute(f.task, f.s);
  assert.equal(result.outcome, 'completed'); assert.equal(f.opened, 1); assert.equal(f.closed, 1); assert.equal(f.effects, 0);
  assert.ok(result.observations.some(o => o.kind === 'container' && o.data.container.id === f.container.id && o.data.items[0]?.count === 3));
  assert.ok(result.observations.some(o => o.kind === 'blocks' && o.data.blocks.length === 2));
  assert.equal(result.checkpoint.waitingFor, undefined); assert.deepEqual(result.checkpoint.protectedPositions, f.task.params.protectedPositions);
  assert.deepEqual(result.checkpoint.buildProtection, { origin: { x: 2, y: 63, z: 2 }, width: 2, depth: 1, height: 1 });
});

test('missing or changed construction blocks prevent warehouse registration before or after opening', async () => {
  for (const changedDuringOpen of [false, true]) {
    const f = fixture(), remove = () => { f.cells.set('3,63,2', 'air'); };
    if (changedDuringOpen) f.afterOpen = remove; else remove();
    await assert.rejects(f.executor.execute(f.task, f.s), error => {
      assert.ok(error instanceof ConditionWait); const wait = BuildWaitingForSchema.parse(error.checkpoint.waitingFor);
      assert.equal(wait.kind, 'blocks'); assert.equal(wait.causeCode, 'BUILD_OBSERVATION'); return true;
    });
    assert.equal(f.opened, changedDuringOpen ? 1 : 0); assert.equal(f.closed, f.opened); assert.equal(f.effects, 0);
    assert.ok(f.s.observations.some(o => o.kind === 'blocks' && o.data.blocks.some(b => b.name === 'air')));
  }
});

test('blocked actual chest access returns a typed wait and keeps building protection', async () => {
  const f = fixture(); f.s.near = async () => { throw new ConditionWait('NoPath'); };
  await assert.rejects(f.executor.execute(f.task, f.s), error => {
    assert.ok(error instanceof ConditionWait); const wait = BuildWaitingForSchema.parse(error.checkpoint.waitingFor);
    assert.equal(wait.kind, 'blocks'); assert.equal(wait.causeCode, 'BUILD_ACCESS'); assert.equal(wait.watchPosition, true);
    assert.deepEqual(error.checkpoint.protectedPositions, f.task.params.protectedPositions); return true;
  });
  assert.equal(f.opened, 0); assert.equal(f.effects, 0);
});

test('a container outside the verified building or current world cannot be registered', async () => {
  for (const invalidWorld of [false, true]) {
    const f = fixture(); assert.ok(f.task.completion.kind === 'warehouse');
    if (invalidWorld) f.task.completion.container.world = 'another-server'; else f.task.completion.blocks = f.task.completion.blocks.filter(b => b.name !== 'chest');
    await assert.rejects(f.executor.execute(f.task, f.s), ConditionWait); assert.equal(f.opened, 0); assert.equal(f.effects, 0);
  }
});

test('unknown public container failures propagate and never claim registration or start construction', async () => {
  const f = fixture(); f.s.near = async () => { throw new ActionFailure('unknown movement', 'UNKNOWN', false, false); };
  await assert.rejects(f.executor.execute(f.task, f.s), e => e instanceof ActionFailure && e.code === 'UNKNOWN');
  assert.equal(f.effects, 0); assert.equal(f.opened, 0);
});
