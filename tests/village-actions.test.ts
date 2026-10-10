import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { DEFAULT_RULES, buildSiteCells, isBuildSiteAir, isBuildSiteGround, type ExpectedBlock, type Position, type TaskSpec } from '../packages/contracts/src';
import { blueprint } from '../packages/contracts/src/blueprints';
import { executeVillageTask, exploreBuildSite } from '../packages/minecraft/src/village-actions';
import { ActionFailure, ConditionWait, type ActionServices } from '../packages/minecraft/src/services';

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

function siteTask(): TaskSpec {
  return { ...task('explore'), source: 'user', params: { mode: 'build-site', design: 'warehouse', near: { x: 0, y: 1, z: 0 }, searchRadius: 8 }, completion: { kind: 'exploration', resourceNames: [], minVisits: 1 } };
}
function flatGround(f: ReturnType<typeof fixture>, y = 0) {
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) f.set({ x, y, z }, 'grass_block');
}

test('build-site search observes the whole empty volume, foundation and exits before selecting nearby ground', async () => {
  const f = fixture(); flatGround(f);
  f.set({ x: 0, y: 1, z: 0 }, 'chest'); // Preserve an existing facility even inside a design's empty interior.
  f.set({ x: -3, y: 0, z: -2 }, 'water');
  const selected = await exploreBuildSite(siteTask(), f.service);
  assert.equal(selected.outcome, 'completed');
  const site = selected.checkpoint.buildSite as { origin: Position; entrance: Position; design: string; observedAt: number };
  assert.equal(site.design, 'warehouse'); assert.ok(site.observedAt > 0);
  const proof = new Map(selected.observations.filter(o => o.kind === 'blocks').flatMap(o => o.data.blocks).map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b.name]));
  for (const cell of buildSiteCells(site.origin, 7, 5, 4)) {
    const actual = proof.get(`${cell.position.x},${cell.position.y},${cell.position.z}`);
    assert.ok(actual && (cell.requirement === 'ground' ? isBuildSiteGround(actual) : isBuildSiteAir(actual)));
  }
  assert.equal(f.bot.blockAt(new Vec3(0, 1, 0))?.name, 'chest');
  assert.deepEqual(f.placed, []); assert.deepEqual(f.digged, []);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(site.entrance.x + 0.5, 1, site.entrance.z + 0.5)) < 1.5);
});

test('build-site failure exposes observed coordinates and waits for terrain or position changes', async () => {
  const f = fixture();
  f.set({ x: -3, y: 0, z: -2 }, 'water');
  const result = await exploreBuildSite(siteTask(), f.service);
  assert.equal(result.outcome, 'condition-wait'); assert.equal(result.checkpoint.buildSite, undefined);
  assert.match(result.reason!, /평지.*-?\d+,-?\d+,-?\d+=/);
  const waiting = result.checkpoint.waitingFor as { causeCode: string; positions: Position[]; watchPosition: boolean };
  assert.equal(waiting.causeCode, 'BUILD_SITE'); assert.equal(waiting.watchPosition, true); assert.ok(waiting.positions.length > 0);
  assert.ok(result.observations.some(o => o.kind === 'blocks' && o.data.blocks.length));
  assert.deepEqual(f.digged, []); assert.deepEqual(f.placed, []);
});

test('build-site proof is rechecked after movement and never completes when access failed', async () => {
  const f = fixture(); flatGround(f);
  let approaches = 0;
  const near = f.service.near;
  f.service.near = async (p, r) => { if (++approaches === 1) f.set({ x: -3, y: 1, z: -2 }, 'diamond_block'); await near(p, r); };
  const result = await exploreBuildSite(siteTask(), f.service);
  assert.equal(result.outcome, 'completed'); assert.ok(approaches > 1);
  const site = result.checkpoint.buildSite as { origin: Position };
  assert.ok(!(site.origin.x <= -3 && site.origin.x + 7 > -3 && site.origin.z <= -2 && site.origin.z + 5 > -2));
  const blocked = fixture(); flatGround(blocked);
  blocked.service.near = async () => { throw new ConditionWait('NoPath'); };
  assert.equal((await exploreBuildSite(siteTask(), blocked.service)).outcome, 'condition-wait');
  assert.equal(blocked.service.checkpoint.buildSite, undefined);
});

test('build-site NoPath stops after eight public approach attempts and preserves the latest blocked route', async () => {
  const f = fixture(); flatGround(f);
  let calls = 0, lastEntrance: Position | undefined;
  f.service.near = async p => {
    calls++; lastEntrance = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    f.bot.entity.position = new Vec3(0.4, 1, -0.3);
    throw new ConditionWait(`NoPath approach ${calls}`);
  };
  const result = await exploreBuildSite(siteTask(), f.service, () => 0);
  assert.equal(calls, 8); assert.equal(result.outcome, 'condition-wait'); assert.equal(result.checkpoint.buildSite, undefined);
  const search = result.checkpoint.buildSiteSearch as { accessAttempts: number; stoppedBecause: string; rejected: { actual: string }[]; lastAccessFailure: { position: Position; from: Position; actual: string } };
  assert.equal(search.accessAttempts, 8); assert.equal(search.stoppedBecause, 'attempt-limit'); assert.equal(search.rejected.length, 6);
  assert.equal(search.lastAccessFailure.actual, 'NoPath approach 8'); assert.deepEqual(search.lastAccessFailure.position, lastEntrance); assert.deepEqual(search.lastAccessFailure.from, { x: 0.4, y: 1, z: -0.3 });
  assert.ok(search.rejected.some(entry => entry.actual === 'NoPath approach 8'), 'a full rejection list preserves the last navigation error');
  assert.match(result.reason!, /8회.*NoPath approach 8/);
  const wait = result.checkpoint.waitingFor as { kind: string; causeCode: string; positions: Position[]; watchPosition: boolean };
  assert.equal(wait.kind, 'blocks'); assert.equal(wait.causeCode, 'BUILD_SITE'); assert.equal(wait.watchPosition, true);
  for (const xz of [[0, -1], [1, -1], [-1, -1], [0, 0], [0, -2]]) for (const y of [0, 1, 2]) assert.ok(wait.positions.some(p => p.x === xz[0] && p.y === y && p.z === xz[1]), `the actual choke point neighborhood ${xz[0]},${y},${xz[1]} is watched`);
  assert.deepEqual(f.placed, []); assert.deepEqual(f.digged, []);
});

for (const durationMs of [20000, 19000]) test(`build-site ${durationMs}ms approaches respect the sixty-second budget and finish the last bounded attempt`, async () => {
  const f = fixture(); flatGround(f);
  let now = 0, calls = 0;
  f.service.near = async () => { calls++; now += durationMs; throw new ConditionWait(`NoPath after ${durationMs}ms`); };
  const result = await exploreBuildSite(siteTask(), f.service, () => now);
  assert.equal(calls, Math.ceil(60000 / durationMs)); assert.ok(calls < 8); assert.ok(now >= 60000 && now < 80000);
  const search = result.checkpoint.buildSiteSearch as { stoppedBecause: string; accessElapsedMs: number; elapsedMs: number };
  assert.equal(result.outcome, 'condition-wait'); assert.equal(search.stoppedBecause, 'time-limit'); assert.equal(search.accessElapsedMs, now); assert.equal(search.elapsedMs, now);
  assert.match(result.reason!, /60초.*NoPath/); assert.equal(result.checkpoint.buildSite, undefined);
});

test('build-site cancellation propagates safely instead of becoming a retryable access failure', async () => {
  const f = fixture(); flatGround(f);
  f.service.near = async () => { throw new ActionFailure('안전 중단', 'CANCELLED', false, true); };
  await assert.rejects(exploreBuildSite(siteTask(), f.service, () => 0), (error: unknown) => error instanceof ActionFailure && error.code === 'CANCELLED');
  assert.equal((f.service.checkpoint.buildSiteSearch as { accessAttempts: number }).accessAttempts, 1);
  assert.equal(f.service.checkpoint.buildSite, undefined); assert.equal(f.service.checkpoint.waitingFor, undefined);
});

test('build approaches loaded distant sites and returns after recursive material gathering before inspecting supports', async () => {
  const f = fixture(), blocks = [{ position: { x: 5, y: 1, z: 0 }, name: 'oak_planks' }];
  f.set({ x: 5, y: 0, z: 0 }, 'dirt'); f.bot.entity.position = new Vec3(50, 1, 0);
  const calls: string[] = [], near = f.service.near, ensure = f.service.ensureItem, place = f.service.place;
  f.service.near = async (p, radius) => { calls.push('approach'); await near(p, radius); };
  f.service.ensureItem = async (item, quantity) => { calls.push('materials'); f.bot.entity.position = new Vec3(50, 1, 0); await ensure(item, quantity); };
  f.service.place = async (p, item, expected, face) => { calls.push('place'); assert.ok(f.bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z)) <= 3); await place(p, item, expected, face); };
  assert.equal((await executeVillageTask(task('build', blocks), f.service)).outcome, 'completed');
  assert.deepEqual(calls, ['approach', 'materials', 'approach', 'place']);
  const changed = fixture(); changed.set({ x: 5, y: 0, z: 0 }, 'dirt');
  changed.service.ensureItem = async () => { changed.set({ x: 5, y: 0, z: 0 }, 'air'); };
  const wait = await executeVillageTask(task('build', blocks), changed.service);
  assert.equal(wait.outcome, 'condition-wait'); assert.equal((wait.checkpoint.waitingFor as { causeCode: string }).causeCode, 'BUILD_SUPPORT');
  assert.match(wait.reason!, /5,0,0/); assert.deepEqual(changed.placed, []);
});

test('blueprint foundations and interior occupied blocks are checked before any material work', async () => {
  for (const obstruction of ['foundation', 'interior']) {
    const f = fixture(); flatGround(f);
    const origin = { x: 0, y: 1, z: 0 }, work = task('build', blueprint('warehouse', origin)); work.source = 'user'; work.params = { design: 'warehouse', origin };
    if (obstruction === 'foundation') f.set({ x: 2, y: 0, z: 2 }, 'air');
    else f.set({ x: 3, y: 2, z: 2 }, 'chest');
    f.service.ensureItem = async () => { assert.fail('invalid sites must never gather materials'); };
    const result = await executeVillageTask(work, f.service);
    assert.equal(result.outcome, 'condition-wait'); assert.equal((result.checkpoint.waitingFor as { causeCode: string }).causeCode, 'BUILD_SITE');
    assert.deepEqual(f.placed, []); assert.deepEqual(f.digged, []);
  }
});

test('missing recursive build resources wait for inventory, actual resource observations or a changed position', async () => {
  const f = fixture(), blocks = [{ position: { x: 0, y: 1, z: 0 }, name: 'oak_planks' }];
  f.set({ x: 0, y: 0, z: 0 }, 'dirt');
  f.service.ensureItem = async () => { throw new ConditionWait('나무가 관측되지 않았습니다.', { missingResource: 'oak_log', minimum: 2, resourceNames: ['oak_log'] }); };
  const result = await executeVillageTask(task('build', blocks), f.service);
  assert.equal(result.outcome, 'condition-wait');
  assert.deepEqual(result.checkpoint.waitingFor, { kind: 'inventory', causeCode: 'BUILD_MATERIAL', item: 'oak_log', minimum: 2, resourceNames: ['oak_log'], watchPosition: true });
  assert.deepEqual(f.placed, []); assert.ok(result.observations.some(o => o.kind === 'inventory'));
});

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
