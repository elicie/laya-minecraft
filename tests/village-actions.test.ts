import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { DEFAULT_RULES, type ExpectedBlock, type Position, type TaskSpec } from '../packages/contracts/src';
import { blueprint } from '../packages/contracts/src/blueprints';
import { executeVillageTask } from '../packages/minecraft/src/village-actions';
import { ActionFailure, type ActionServices } from '../packages/minecraft/src/services';

interface FakeBlock { name: string; position: Vec3; boundingBox: 'block' | 'empty'; getProperties(): Record<string, unknown> }
interface FakeEntity { id: number; uuid: string; name: string; position: Vec3; metadata: boolean[]; username?: string }
function fixture() {
  const cells = new Map<string, FakeBlock>();
  const items = new Map<string, number>();
  const entities: Record<number, FakeEntity> = {};
  const unloaded = new Set<string>();
  let held = '';
  let feeds = 0;
  let onFeed = () => {};
  let abortAfterPlacement = false;
  const digged: string[] = [];
  const placed: string[] = [];
  const cellKey = (p: Position) => `${p.x},${p.y},${p.z}`;
  function set(p: Position, name: string, properties: Record<string, unknown> = {}) {
    const cell = { name, position: new Vec3(p.x, p.y, p.z), boundingBox: ['air', 'water', 'wheat', 'carrots', 'potatoes', 'beetroots'].includes(name) ? 'empty' as const : 'block' as const, getProperties: () => properties };
    cells.set(cellKey(p), cell);
    return cell;
  }
  const bot = {
    inventory: { items: () => [...items].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) },
    entities, registry: { entitiesByName: { cow: { metadataKeys: ['baby'] }, sheep: { metadataKeys: ['baby'] } } },
    entity: { position: new Vec3(0, 1, 0) },
    blockAt(p: Position) { return unloaded.has(cellKey(p)) ? null : cells.get(cellKey(p)) ?? set(p, 'air'); },
    async look() {},
    async lookAt() {},
    async equip(item: { name: string }) { held = item.name; },
    async activateBlock(block: FakeBlock) {
      if (held.endsWith('_hoe')) set(block.position, 'farmland');
    },
    activateItem() {
      if (held === 'water_bucket') { set(bot.entity.position, 'water'); items.set('water_bucket', 0); }
    },
    async dig(block: FakeBlock) {
      digged.push(block.name); set(block.position, 'air');
      if (block.name === 'wheat') { items.set('wheat', (items.get('wheat') ?? 0) + 3); items.set('wheat_seeds', (items.get('wheat_seeds') ?? 0) + 2); }
    },
    async activateEntity() { feeds += 1; items.set(held, (items.get(held) ?? 0) - 1); onFeed(); },
  } as unknown as Bot;
  const rules = { ...structuredClone(DEFAULT_RULES), center: { x: 0, y: 1, z: 0 }, radius: 20 };
  const service: ActionServices = {
    bot, rules, signal: new AbortController().signal, checkpoint: {}, observations: [], evidence: [],
    check() { if (abortAfterPlacement && placed.length) throw new ActionFailure('중단', 'CANCELLED', false, true); },
    async pause() {},
    async near(p) { bot.entity.position = new Vec3(p.x, p.y, p.z); },
    async ensureItem(name, quantity) { items.set(name, Math.max(items.get(name) ?? 0, quantity)); },
    async place(p, item, expected = item) {
      placed.push(expected); items.set(item, (items.get(item) ?? 0) - 1); set(p, expected);
      if (expected.endsWith('_door')) set({ ...p, y: p.y + 1 }, expected);
      if (expected.endsWith('_bed')) set({ ...p, x: p.x + 1 }, expected);
    },
    observeInventory() {
      const observation = { id: `inventory-${service.observations.length}`, kind: 'inventory' as const, observedAt: Date.now(), world: rules.world, dimension: rules.dimension,
        data: { items: bot.inventory.items().map(item => ({ name: item.name, count: item.count })) } };
      return observation;
    },
    progress() {},
  };
  function animal(id: number, baby: boolean, x = 0) {
    const entity: FakeEntity = { id, uuid: `cow-${id}`, name: 'cow', position: new Vec3(x, 1, 0), metadata: [baby] };
    entities[id] = entity; return entity;
  }
  return { service, cells, items, entities, unloaded, set, bot, animal, digged, placed,
    get feeds() { return feeds; }, set onFeed(value: () => void) { onFeed = value; },
    set abortAfterPlacement(value: boolean) { abortAfterPlacement = value; } };
}
function task(kind: TaskSpec['kind'], blocks?: ExpectedBlock[]): TaskSpec {
  return { id: 'task', goalId: 'goal', kind, params: {}, dependencies: [], reservationKeys: [],
    completion: kind === 'build' ? { kind: 'blocks', blocks: blocks! } : kind === 'farm' ? { kind: 'farm', plots: 8, mode: 'setup', crop: 'wheat' } : { kind: 'breeding', animal: 'cow', minimum: 1 } };
}

test('build protects existing blocks and validates the full footprint before placement', async () => {
  const f = fixture();
  const blocks = [{ position: { x: 0, y: 1, z: 0 }, name: 'oak_planks' }, { position: { x: 1, y: 1, z: 0 }, name: 'oak_planks' }];
  f.set(blocks[1]!.position, 'diamond_block');
  const protectedResult = await executeVillageTask(task('build', blocks), f.service);
  assert.equal(protectedResult.outcome, 'condition-wait');
  assert.deepEqual(f.placed, []);
  assert.deepEqual(f.digged, []);
  f.set(blocks[1]!.position, 'air'); f.unloaded.add('1,1,0');
  assert.equal((await executeVillageTask(task('build', blocks), f.service)).outcome, 'condition-wait');
  assert.deepEqual(f.placed, []);
  f.unloaded.clear(); f.service.rules.radius = 0.5;
  assert.equal((await executeVillageTask(task('build', blocks), f.service)).outcome, 'condition-wait');
  assert.deepEqual(f.placed, []);
});

test('build verifies generated door upper and bed head without spending duplicate items', async () => {
  const f = fixture();
  const blocks = [
    { position: { x: 0, y: 1, z: 0 }, name: 'oak_door' }, { position: { x: 0, y: 2, z: 0 }, name: 'oak_door' },
    { position: { x: 2, y: 1, z: 0 }, name: 'white_bed' }, { position: { x: 3, y: 1, z: 0 }, name: 'white_bed' },
  ];
  for (const x of [0, 1, 2, 3]) f.set({ x, y: 0, z: 0 }, 'dirt');
  const outcome = await executeVillageTask(task('build', blocks), f.service);
  assert.equal(outcome.outcome, 'completed');
  assert.deepEqual(f.placed, ['white_bed', 'oak_door']);
  assert.equal(outcome.observations.find(o => o.kind === 'blocks')?.data.blocks.length, 4);
  f.abortAfterPlacement = true;
  const interrupted = fixture(); interrupted.abortAfterPlacement = true;
  for (const x of [0, 1, 2, 3]) interrupted.set({ x, y: 0, z: 0 }, 'dirt');
  await assert.rejects(executeVillageTask(task('build', blocks), interrupted.service), (error: unknown) => error instanceof ActionFailure && error.code === 'CANCELLED');
  assert.deepEqual(interrupted.placed, ['white_bed']);
  assert.ok(interrupted.service.checkpoint.build);
});

test('bed placement preserves a west-side approach before utilities and can resume from a utility top', async () => {
  const blocks = [
    { position: { x: 1, y: 1, z: 0 }, name: 'furnace' },
    { position: { x: 2, y: 1, z: 0 }, name: 'white_bed' }, { position: { x: 3, y: 1, z: 0 }, name: 'white_bed' },
  ];
  for (const alreadyBuilt of [false, true]) {
    const f = fixture();
    for (const x of [1, 2, 3]) f.set({ x, y: 0, z: 0 }, 'dirt');
    if (alreadyBuilt) f.set({ x: 1, y: 1, z: 0 }, 'furnace');
    const place = f.service.place;
    f.service.place = async (p, item, expected, face) => {
      if (expected === 'white_bed') assert.deepEqual(f.bot.entity.position, new Vec3(1, alreadyBuilt ? 2 : 1, 0));
      await place(p, item, expected, face);
    };
    assert.equal((await executeVillageTask(task('build', blocks), f.service)).outcome, 'completed');
    assert.deepEqual(f.placed, alreadyBuilt ? ['white_bed'] : ['white_bed', 'furnace']);
  }
});

test('cabin keeps a planned access stair until its fixtures exist and closes it from safe ground', async () => {
  const f = fixture(), blocks = blueprint('cabin', { x: 0, y: 1, z: 0 });
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 5; z++) f.set({ x, y: 0, z }, 'dirt');
  const place = f.service.place;
  let fixturesPresent = false, closedFromGround = false;
  f.service.place = async (p, item, expected, face) => {
    if (expected === 'white_bed') {
      assert.equal(f.bot.blockAt(new Vec3(0, 5, 0))?.name, 'air', 'the roof access must remain open for interior work');
      fixturesPresent = true;
    }
    if (p.x === 0 && p.y === 5 && p.z === 0) assert.ok(fixturesPresent);
    if (p.x === 0 && p.y === 2 && p.z === 3) {
      assert.equal(f.bot.entity.position.x, -0.5); assert.equal(f.bot.entity.position.y, 1);
      closedFromGround = true;
    }
    await place(p, item, expected, face);
    if (p.x === 0 && p.y === 5 && p.z === 3) f.bot.entity.position = new Vec3(1.5, 3, 3.5); // A high placement can reposition onto a utility.
  };
  const result = await executeVillageTask(task('build', blocks), f.service);
  assert.equal(result.outcome, 'completed'); assert.ok(closedFromGround);
  for (const block of blocks) assert.equal(f.bot.blockAt(new Vec3(block.position.x, block.position.y, block.position.z))?.name, block.name);
  const finalPosition = f.bot.entity.position.clone();
  f.service.near = async () => { throw new Error('completed footprint must not require navigation'); };
  assert.equal((await executeVillageTask(task('build', blocks), f.service)).outcome, 'completed');
  assert.deepEqual(f.bot.entity.position, finalPosition);
});

test('access closure resumes from real completed columns after interruption', async () => {
  const f = fixture(), blocks = blueprint('cabin', { x: 0, y: 1, z: 0 });
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 5; z++) f.set({ x, y: 0, z }, 'dirt');
  const place = f.service.place;
  let interrupt = true;
  f.service.place = async (p, item, expected, face) => {
    await place(p, item, expected, face);
    if (interrupt && p.x === 0 && p.y === 5 && p.z === 0) { interrupt = false; throw new ActionFailure('일시 중단', 'CANCELLED', false, true); }
  };
  await assert.rejects(executeVillageTask(task('build', blocks), f.service), (error: unknown) => error instanceof ActionFailure && error.code === 'CANCELLED');
  const near = f.service.near;
  f.service.near = async (p, radius) => {
    assert.notDeepEqual(p, { x: 0.5, y: 4, z: 1.5 }, 'the finished column must be skipped on resume');
    await near(p, radius);
  };
  assert.equal((await executeVillageTask(task('build', blocks), f.service)).outcome, 'completed');
  assert.equal(f.placed.filter(name => name === 'white_bed').length, 1);
  assert.equal(f.bot.entity.position.y, 1);
});

function field(f: ReturnType<typeof fixture>, mature = false) {
  for (let x = -2; x <= 2; x += 1) for (let z = -2; z <= 2; z += 1) f.set({ x, y: 0, z }, 'dirt');
  f.set({ x: 0, y: 0, z: 0 }, 'water');
  for (const x of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || z) {
    f.set({ x, y: 0, z }, mature ? 'farmland' : 'dirt');
    f.set({ x, y: 1, z }, mature ? 'wheat' : 'air', { age: mature ? 7 : 0 });
  }
}

test('eight-plot farm setup checks irrigation, hoes soil, and confirms actual plants', async () => {
  const f = fixture(); field(f);
  const outcome = await executeVillageTask(task('farm'), f.service);
  assert.equal(outcome.outcome, 'completed');
  assert.equal(f.placed.filter(name => name === 'wheat').length, 8);
  const observation = outcome.observations.find(o => o.kind === 'farm');
  assert.ok(observation?.kind === 'farm');
  assert.equal(observation.data.planted, 8); assert.equal(observation.data.watered, 8);
  assert.deepEqual(f.digged, []);
});

test('immature crops wait without retryable failure; mature crops count inventory gains and replant', async () => {
  const growing = fixture(); field(growing);
  await executeVillageTask(task('farm'), growing.service);
  const harvesting = task('farm'); harvesting.completion = { kind: 'farm', plots: 8, mode: 'harvest', crop: 'wheat', quantity: 4, baseline: 0 };
  assert.equal((await executeVillageTask(harvesting, growing.service)).outcome, 'condition-wait');
  assert.deepEqual(growing.digged, []);
  const ripe = fixture(); field(ripe, true);
  const outcome = await executeVillageTask(harvesting, ripe.service);
  assert.equal(outcome.outcome, 'completed');
  assert.equal(outcome.checkpoint.harvestStart, 0);
  const observed = outcome.observations.find(o => o.kind === 'farm');
  assert.ok(observed?.kind === 'farm'); assert.equal(observed.data.harvested, 24); assert.equal(observed.data.planted, 8);
  assert.equal(ripe.items.get('wheat'), 24);
});

test('breed uses registry baby metadata and requires newly observed offspring after feeding', async () => {
  const f = fixture(); f.animal(1, false); f.animal(2, false, 2); f.animal(3, true, 1);
  f.onFeed = () => { if (f.feeds === 2) f.animal(4, true, 1); };
  const outcome = await executeVillageTask(task('breed'), f.service);
  assert.equal(outcome.outcome, 'completed'); assert.equal(f.feeds, 2);
  const birth = outcome.observations.find(o => o.kind === 'breeding');
  assert.ok(birth?.kind === 'breeding'); assert.equal(birth.data.entityId, 'cow-4');
});

test('feeding alone stays waiting and resumes observation without feeding parents again', async () => {
  const f = fixture(); f.animal(1, false); f.animal(2, false, 2);
  assert.equal((await executeVillageTask(task('breed'), f.service)).outcome, 'condition-wait');
  assert.equal(f.feeds, 2);
  f.animal(4, true, 1);
  const outcome = await executeVillageTask(task('breed'), f.service);
  assert.equal(outcome.outcome, 'completed'); assert.equal(f.feeds, 2);
  const unknown = fixture(); unknown.animal(1, false); unknown.animal(2, false, 2);
  (unknown.bot.registry.entitiesByName as unknown as Record<string, { metadataKeys: string[] }>).cow!.metadataKeys = [];
  assert.equal((await executeVillageTask(task('breed'), unknown.service)).outcome, 'condition-wait');
  assert.equal(unknown.feeds, 0);
});

test('breeding resumes after one consumed feed without repeating that parent activation', async () => {
  const f = fixture(); f.animal(1, false); f.animal(2, false, 2);
  f.onFeed = () => { throw new ActionFailure('긴급 대응 중단', 'CANCELLED', false, true); };
  await assert.rejects(executeVillageTask(task('breed'), f.service), /긴급 대응/);
  assert.equal(f.feeds, 1);
  f.onFeed = () => { if (f.feeds === 2) f.animal(3, true, 1); };
  const resumed = await executeVillageTask(task('breed'), f.service);
  assert.equal(resumed.outcome, 'completed');
  assert.equal(f.feeds, 2);
});

test('quantity breeding verifies separate offspring and preserves prior births across partial progress', async () => {
  const f = fixture();
  for (let id = 1; id <= 4; id += 1) f.animal(id, false, id);
  const two = task('breed'); two.completion = { kind: 'breeding', animal: 'cow', minimum: 2 };
  f.onFeed = () => { if (f.feeds === 2) f.animal(5, true, 2); if (f.feeds === 4) f.animal(6, true, 3); };
  assert.equal((await executeVillageTask(two, f.service)).outcome, 'partial');
  f.service.observations = [];
  const completed = await executeVillageTask(two, f.service);
  assert.equal(completed.outcome, 'completed');
  assert.deepEqual(completed.observations.filter(o => o.kind === 'breeding').map(o => o.data.entityId), ['cow-5', 'cow-6']);
  assert.equal(f.feeds, 4);
});
