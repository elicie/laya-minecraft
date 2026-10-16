import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { DEFAULT_RULES, type ExpectedBlock, type JsonObject, type Position, type TaskSpec } from '../packages/contracts/src';
import { blueprint, materialRequirements } from '../packages/contracts/src/blueprints';
import { executeVillageTask } from '../packages/minecraft/src/village-actions';
import { ActionFailure, ConditionWait, type ActionServices } from '../packages/minecraft/src/services';

function fixture(blocks: ExpectedBlock[], options: { capacity?: number; stackSize?: number; initial?: number; legacy?: boolean } = {}) {
  const cells = new Map<string, string>(), stock = new Map<string, number>(), requests: { item: string; minimum: number }[] = [], placed: ExpectedBlock[] = [];
  const key = (p: Position) => `${p.x},${p.y},${p.z}`;
  if (options.initial) stock.set(blocks[0]!.name, options.initial);
  const bot = { entity: { position: new Vec3(0.5, 1, 0.5) },
    registry: { itemsByName: Object.fromEntries([...new Set(blocks.map(b => b.name === 'wall_torch' ? 'torch' : b.name))].map(name => [name, { stackSize: options.stackSize ?? (name.endsWith('_bed') ? 1 : 64) }])) },
    inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, stackSize: options.stackSize ?? (name.endsWith('_bed') ? 1 : 64) })), ...(options.legacy ? {} : { emptySlotCount: () => options.capacity ?? 1 }) },
    blockAt(p: Position) { const name = cells.get(key(p)) ?? (p.y <= 0 ? 'dirt' : 'air'); return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'air' ? 'empty' : 'block' }; },
    async look() {},
  } as unknown as Bot;
  const rules = { ...structuredClone(DEFAULT_RULES), center: { x: 0, y: 1, z: 0 }, radius: 100 };
  let prepare = async (item: string, minimum: number) => { stock.set(item, minimum); };
  const s: ActionServices = { bot, rules, signal: new AbortController().signal, checkpoint: {}, observations: [], evidence: [], check() {}, async pause() {},
    async near(p) { bot.entity.position = new Vec3(p.x, p.y, p.z); },
    async ensureItem(item, minimum) { requests.push({ item, minimum }); await prepare(item, minimum); },
    async place(p, item, expected = item) {
      assert.ok((stock.get(item) ?? 0) > 0, 'installation requires an actually observed item'); stock.set(item, stock.get(item)! - 1);
      cells.set(key(p), expected); placed.push({ position: p, name: expected });
      if (expected.endsWith('_door')) cells.set(key({ ...p, y: p.y + 1 }), expected);
      if (expected.endsWith('_bed')) cells.set(key({ ...p, x: p.x + 1 }), expected);
    },
    observeInventory() { return { id: `inventory-${s.observations.length}`, kind: 'inventory', observedAt: Date.now(), world: rules.world, dimension: rules.dimension, data: { items: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) } }; }, progress() {},
  };
  const task: TaskSpec = { id: 'build', goalId: 'goal', kind: 'build', source: 'user', params: {}, dependencies: [], reservationKeys: [], completion: { kind: 'blocks', blocks } };
  return { s, task, cells, stock, requests, placed, key, set prepare(value: typeof prepare) { prepare = value; } };
}
const floor = (length: number): ExpectedBlock[] => Array.from({ length }, (_, x) => ({ position: { x, y: 1, z: 0 }, name: 'cobblestone' }));

test('actual remaining floor batches reduce trips and never reacquire already installed blocks', async () => {
  const f = fixture(floor(35));
  for (let x = 0; x < 10; x++) f.cells.set(`${x},1,0`, 'cobblestone');
  const result = await executeVillageTask(f.task, f.s);
  assert.equal(result.outcome, 'completed'); assert.deepEqual(f.requests, [{ item: 'cobblestone', minimum: 16 }, { item: 'cobblestone', minimum: 9 }]);
  assert.equal(f.placed.length, 25); assert.equal(f.stock.get('cobblestone'), 0);
  assert.deepEqual(result.checkpoint.buildMaterial, { item: 'cobblestone', minimum: 1, remaining: 1, current: 1 });
});

test('existing partial stock is used before acquiring another batch and capacity cannot exceed the real stack cap', async () => {
  const stocked = fixture(floor(10), { initial: 7, capacity: 0 });
  stocked.prepare = async (item, minimum) => { if (stocked.requests.length === 1) assert.equal(stocked.placed.length, 7); assert.ok(stocked.placed.length >= 7); assert.equal(minimum, 1); stocked.stock.set(item, 1); };
  assert.equal((await executeVillageTask(stocked.task, stocked.s)).outcome, 'completed'); assert.equal(stocked.requests.length, 3);
  const small = fixture(floor(10), { stackSize: 4, capacity: 1 });
  assert.equal((await executeVillageTask(small.task, small.s)).outcome, 'completed'); assert.deepEqual(small.requests.map(r => r.minimum), [4, 4, 2]);
});

test('legacy capacity mocks and zero free slots retain one-item acquisition and honest space waits', async () => {
  const legacy = fixture(floor(3), { legacy: true });
  assert.equal((await executeVillageTask(legacy.task, legacy.s)).outcome, 'completed'); assert.deepEqual(legacy.requests.map(r => r.minimum), [1, 1, 1]);
  const full = fixture(floor(3), { capacity: 0 }); full.prepare = async () => { throw new ConditionWait('인벤토리 공간이 필요합니다.'); };
  const result = await executeVillageTask(full.task, full.s);
  assert.equal(result.outcome, 'condition-wait'); assert.deepEqual(full.requests, [{ item: 'cobblestone', minimum: 1 }]); assert.equal(full.placed.length, 0);
  assert.equal((result.checkpoint.waitingFor as JsonObject).minimum, 1);
});

test('door and bed generated halves consume one item each and wall torches request their actual item', async () => {
  for (const name of ['oak_door', 'white_bed']) {
    const pair = name.endsWith('_door') ? [{ x: 0, y: 1, z: 0 }, { x: 0, y: 2, z: 0 }] : [{ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }];
    const f = fixture(pair.map(position => ({ position, name })));
    assert.equal((await executeVillageTask(f.task, f.s)).outcome, 'completed'); assert.deepEqual(f.requests, [{ item: name, minimum: 1 }]); assert.equal(f.placed.length, 1);
  }
  const f = fixture([{ position: { x: 1, y: 1, z: 0 }, name: 'wall_torch' }, { position: { x: 1, y: 1, z: 2 }, name: 'wall_torch' }]);
  f.cells.set('0,1,0', 'cobblestone'); f.cells.set('0,1,2', 'cobblestone');
  assert.equal((await executeVillageTask(f.task, f.s)).outcome, 'completed'); assert.deepEqual(f.requests, [{ item: 'torch', minimum: 2 }]);
});

test('a known partial batch installs the confirmed stock and preserves exhausted search budgets until the next real wait', async () => {
  const f = fixture(floor(10)), budget = { origin: { x: 0, y: 1, z: 0 }, destinationsUsed: 5, elapsedMs: 60000, status: 'exhausted' };
  let calls = 0;
  f.prepare = async () => {
    if (++calls === 1) f.stock.set('cobblestone', 7);
    throw new ConditionWait('원천 돌 대기', { missingResource: 'cobblestone', minimum: 10, resourceRecovery: { cobblestone: budget }, waitingFor: { kind: 'inventory', causeCode: 'RESOURCE_MISSING', item: 'cobblestone', minimum: 10, watchPosition: false } });
  };
  const result = await executeVillageTask(f.task, f.s);
  assert.equal(result.outcome, 'condition-wait'); assert.equal(f.placed.length, 7); assert.deepEqual(f.requests.map(r => r.minimum), [10, 3]);
  assert.deepEqual((result.checkpoint.resourceRecovery as JsonObject).cobblestone, budget);
  assert.equal((result.checkpoint.waitingFor as JsonObject).watchPosition, false);
});

test('unknown effects and cancellation are never swallowed even when some actual materials appeared', async () => {
  for (const code of ['CRAFT_UNCERTAIN', 'CANCELLED']) {
    const f = fixture(floor(10)); f.prepare = async () => { f.stock.set('cobblestone', 7); throw new ActionFailure('확인되지 않은 결과', code, false, code === 'CANCELLED'); };
    await assert.rejects(executeVillageTask(f.task, f.s), error => error instanceof ActionFailure && error.code === code); assert.equal(f.placed.length, 0);
  }
});

test('a missing legacy batch carries its actual requested minimum while a nested raw material keeps its own minimum', async () => {
  for (const raw of [false, true]) {
    const f = fixture(floor(20)); f.prepare = async () => { throw new ConditionWait('재료 대기', raw ? { missingResource: 'oak_log', minimum: 2 } : {}); };
    const result = await executeVillageTask(f.task, f.s); assert.equal(result.outcome, 'condition-wait');
    const wait = result.checkpoint.waitingFor as JsonObject;
    assert.equal(wait.minimum, raw ? 2 : 16); assert.equal(wait.item, raw ? 'oak_log' : 'cobblestone');
    assert.deepEqual(result.checkpoint.buildMaterial, { item: 'cobblestone', minimum: 16, remaining: 20, current: 0 });
  }
});

test('an acquisition without actual inventory proof cannot install or claim construction completion', async () => {
  const f = fixture(floor(5)); f.prepare = async () => {};
  const result = await executeVillageTask(f.task, f.s);
  assert.equal(result.outcome, 'condition-wait'); assert.equal(f.placed.length, 0); assert.equal((result.checkpoint.waitingFor as JsonObject).minimum, 5);
});

test('a small warehouse prepares furniture and windows on the ground before final structural stock and postponed cells', async () => {
  const blocks = blueprint('warehouse', { x: 0, y: 1, z: 0 }), required = materialRequirements(blocks), f = fixture(blocks, { capacity: 36 });
  f.task.params.design = 'warehouse';
  f.prepare = async (item, minimum) => {
    assert.equal(f.placed.length, 0, 'no upper construction can precede full ground-level material preparation');
    assert.equal(f.s.bot.entity.position.y, 1); f.stock.set(item, minimum);
  };
  const result = await executeVillageTask(f.task, f.s);
  assert.equal(result.outcome, 'completed', result.reason);
  assert.deepEqual(Object.fromEntries(f.requests.map(request => [request.item, request.minimum])), required);
  assert.equal(f.requests.at(-1)!.item, 'oak_planks'); assert.equal(f.requests.at(-2)!.item, 'cobblestone');
  assert.equal((result.checkpoint.buildPreflight as JsonObject).status, 'ready');
  assert.equal(f.s.bot.entity.position.y, 1);
  assert.ok(f.s.bot.entity.position.x < 0 || f.s.bot.entity.position.x >= 7 || f.s.bot.entity.position.z < 0 || f.s.bot.entity.position.z >= 5);
});

test('insufficient full-design capacity keeps bounded batches including postponed columns and newly completed cells', async () => {
  const blocks = blueprint('warehouse', { x: 0, y: 1, z: 0 }), required = materialRequirements(blocks), f = fixture(blocks, { capacity: 1 }); f.task.params.design = 'warehouse';
  const result = await executeVillageTask(f.task, f.s); assert.equal(result.outcome, 'completed', result.reason);
  for (const [item, total] of Object.entries(required)) {
    const requests = f.requests.filter(request => request.item === item);
    assert.equal(requests.reduce((sum, request) => sum + request.minimum, 0), total, item);
    assert.ok(requests.every(request => request.minimum <= 16));
    if (total > 16) assert.equal(requests.length, Math.ceil(total / 16), 'postponed access cells must share the remaining material batch');
  }
  assert.equal(result.checkpoint.buildPreflight, undefined);
});

test('a partial small-design preparation uses confirmed materials while preserving the actual shortage and bounded search', async () => {
  const blocks = blueprint('warehouse', { x: 0, y: 1, z: 0 }), f = fixture(blocks, { capacity: 36 }); f.task.params.design = 'warehouse';
  const budget = { origin: { x: 0, y: 1, z: 0 }, destinationsUsed: 5, elapsedMs: 60000, status: 'exhausted' }; let windows = 0;
  f.prepare = async (item, minimum) => {
    if (item !== 'glass_pane') { f.stock.set(item, minimum); return; }
    if (++windows === 1) f.stock.set(item, 2);
    throw new ConditionWait('새 모래 관측을 기다립니다.', { missingResource: 'sand', minimum: 6, resourceRecovery: { sand: budget }, waitingFor: { kind: 'inventory', causeCode: 'RESOURCE_MISSING', item: 'sand', minimum: 6, watchPosition: false } });
  };
  const result = await executeVillageTask(f.task, f.s);
  assert.equal(result.outcome, 'condition-wait'); assert.ok(f.placed.length > 35); assert.equal(f.placed.filter(p => p.name === 'glass_pane').length, 2);
  assert.equal((result.checkpoint.buildPreflight as JsonObject).status, 'partial');
  assert.equal(((result.checkpoint.buildPreflight as JsonObject).partialWaits as JsonObject[])[0]!.item, 'glass_pane');
  assert.equal((result.checkpoint.waitingFor as JsonObject).item, 'sand'); assert.equal((result.checkpoint.waitingFor as JsonObject).minimum, 6);
  assert.deepEqual((result.checkpoint.resourceRecovery as JsonObject).sand, budget);
});

test('a failed zero-stock window expedition permits the entire usable warehouse shell but never claims its missing windows are complete', async () => {
  const blocks = blueprint('warehouse', { x: 0, y: 1, z: 0 }), f = fixture(blocks, { capacity: 36 }); f.task.params.design = 'warehouse';
  const trip = { item: 'glass_pane', minimum: 3, home: { x: 3, y: 1, z: -1 }, trail: [{ x: 3, y: 1, z: -1 }], phase: 'complete', returns: 1, failure: 'Actual sand search failed' };
  f.s.checkpoint.resourceTrip = trip;
  const budget = { destinationsUsed: 5, elapsedMs: 60000, status: 'exhausted' }; f.s.checkpoint.resourceRecovery = { sand: budget };
  f.prepare = async (item, minimum) => {
    assert.notEqual(item, 'glass_pane', 'an already failed window search must not block the empty shell again');
    f.stock.set(item, minimum);
    const { failure: _failure, ...completed } = trip;
    f.s.checkpoint.resourceTrip = { ...completed, item, minimum, returns: 2 };
  };
  const shell = await executeVillageTask(f.task, f.s);
  assert.equal(shell.outcome, 'partial');
  assert.ok(blocks.filter(b => b.name !== 'glass_pane').every(b => f.cells.get(f.key(b.position)) === b.name), 'all foundations, walls, roof, doors, chests, lights and access closure must actually match');
  assert.equal(blocks.filter(b => f.cells.get(f.key(b.position)) !== b.name).length, 3);
  assert.equal((shell.checkpoint.buildDeferredWindows as unknown[]).length, 3);
  assert.deepEqual((shell.checkpoint.resourceRecovery as JsonObject).sand, budget);
  assert.equal(f.s.bot.entity.position.y, 1, 'the temporary construction stair was actually closed after descending');
  f.stock.set('glass_pane', 3);
  f.prepare = async () => { assert.fail('completed structural stock must never be gathered again'); };
  const finished = await executeVillageTask(f.task, f.s);
  assert.equal(finished.outcome, 'completed');
  assert.ok(blocks.every(b => f.cells.get(f.key(b.position)) === b.name));
});

test('a resumed survival warehouse commits its foundation before collecting all upper materials and never needs roof crafting',async()=>{
  const blocks=blueprint('warehouse',{x:0,y:1,z:0}),f=fixture(blocks,{capacity:36});f.task.params.design='warehouse';f.s.checkpoint.materialExpedition=true;f.s.checkpoint.confirmedRecoveryDeathId='actual-respawn';
  for(const count of [8,16,24,32,35]){const foundation=await executeVillageTask(f.task,f.s);assert.equal(foundation.outcome,'partial');assert.equal(f.placed.length,count);assert.ok(f.placed.every(p=>p.name==='cobblestone'&&p.position.y===1));}
  assert.deepEqual(f.requests,[8,8,8,8,3].map(minimum=>({item:'cobblestone',minimum})));
  f.prepare=async(item,minimum)=>{assert.equal(f.s.bot.entity.position.y,1,'all upper-material crafting still occurs at the ground entrance');f.stock.set(item,minimum);};
  let complete;for(let step=0;step<20;step++){complete=await executeVillageTask(f.task,f.s);if(complete.outcome==='completed')break;assert.equal(complete.outcome,'partial');}
  assert.equal(complete?.outcome,'completed');assert.ok(blocks.every(b=>f.cells.get(f.key(b.position))===b.name));assert.equal(f.requests.filter(r=>r.item==='cobblestone').length,5);assert.ok(f.requests.filter(r=>r.item==='oak_planks').every(r=>r.minimum<=10));assert.equal(typeof f.s.checkpoint.buildAccess,'string');
});
