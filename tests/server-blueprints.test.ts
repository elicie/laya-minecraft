import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BlueprintInputSchema, GoalInputSchema, type BlueprintDefinition, type CommandReceipt, type FleetCheckpoint } from '../packages/contracts/src';
import { FleetController } from '../packages/core/src';
import { createControlServer } from '../apps/server/src/control-server';
import { ControlStore } from '../apps/server/src/store';

function headers(key = randomUUID()) { return { 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': key }; }
const input = () => BlueprintInputSchema.parse({ title: '돌벽 작은 집', template: 'cabin', width: 6, depth: 5, height: 3, wood: 'birch',
  materials: { floor: 'cobblestone', wall: 'stone_bricks', roof: 'birch_planks', window: 'glass_pane' },
  furniture: { chest: false, craftingTable: false, furnace: false, bed: false, lighting: false } });

test('blueprint API validates and deduplicates CRUD, persists the catalog and preserves pinned goals', async () => {
  const store = new ControlStore(':memory:'); let api: ReturnType<typeof createControlServer> | undefined;
  const core = new FleetController({ send() {}, onChange(snapshot, event) { api?.observe(snapshot, event); } });
  api = createControlServer({ core, store, port: 0 });
  const address = await api.listen(), base = `http://127.0.0.1:${address.port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/v1/blueprints`)).json(), []);
    const denied = await fetch(`${base}/api/v1/blueprints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) });
    assert.equal(denied.status, 403);
    const invalid = await fetch(`${base}/api/v1/blueprints`, { method: 'POST', headers: headers(), body: JSON.stringify({ ...input(), materials: { ...input().materials, wall: 'lava' } }) });
    assert.equal(invalid.status, 400); assert.equal(core.getSnapshot().blueprints.length, 0);
    const createKey = randomUUID();
    const created = await fetch(`${base}/api/v1/blueprints`, { method: 'POST', headers: headers(createKey), body: JSON.stringify(input()) });
    assert.equal(created.status, 202); const receipt = await created.json() as CommandReceipt; assert.equal(receipt.state, 'applied');
    const duplicate = await fetch(`${base}/api/v1/blueprints`, { method: 'POST', headers: headers(createKey), body: JSON.stringify(input()) });
    assert.equal((await duplicate.json() as CommandReceipt).id, receipt.id); assert.equal(core.getSnapshot().blueprints.length, 1);
    const definition = core.getSnapshot().blueprints[0]!;
    const goal = core.createGoal({ kind: 'build', source: 'user', params: { blueprint: definition.id, siteSelection: 'nearby' } });
    const pinned = structuredClone(goal.input.params.blueprintDefinition);
    const edit = { ...input(), title: '수정한 돌벽 집', width: 7, materials: { ...input().materials, wall: 'oak_planks' } };
    const changed = await fetch(`${base}/api/v1/blueprints/${definition.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(edit) });
    assert.equal(changed.status, 202); assert.equal((await changed.json() as CommandReceipt).state, 'applied');
    const catalog = await (await fetch(`${base}/api/v1/blueprints`)).json() as BlueprintDefinition[];
    assert.equal(catalog[0]?.version, definition.version + 1); assert.equal(catalog[0]?.width, 7); assert.equal(catalog[0]?.materials.wall, 'oak_planks');
    assert.deepEqual(core.getSnapshot().goals.find(g => g.id === goal.id)?.input.params.blueprintDefinition, pinned);
    const persisted = store.loadCheckpoint<FleetCheckpoint>(); assert.equal(persisted?.blueprints[0]?.version, 2);
    const restored = new FleetController({ send() {}, checkpoint: persisted }); assert.equal(restored.getSnapshot().blueprints[0]?.materials.wall, 'oak_planks');
    const removeKey = randomUUID();
    const removed = await fetch(`${base}/api/v1/blueprints/${definition.id}`, { method: 'DELETE', headers: headers(removeKey), body: '{}' });
    assert.equal(removed.status, 202); assert.equal((await removed.json() as CommandReceipt).state, 'applied');
    assert.deepEqual(await (await fetch(`${base}/api/v1/blueprints`)).json(), []);
    const repeated = await fetch(`${base}/api/v1/blueprints/${definition.id}`, { method: 'DELETE', headers: headers(removeKey), body: '{}' });
    assert.equal(repeated.status, 202);
    assert.deepEqual(core.getSnapshot().goals.find(g => g.id === goal.id)?.input.params.blueprintDefinition, pinned);
    const missing = await fetch(`${base}/api/v1/blueprints/${definition.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(edit) });
    assert.equal(missing.status, 409); assert.equal((await missing.json() as CommandReceipt).state, 'failed');
  } finally { await api.close(); store.close(); }
});

test('goal interpretation receives the current saved blueprint catalog', async () => {
  const store = new ControlStore(':memory:'), core = new FleetController({ send() {} }); const definition = core.createBlueprint(input());
  const api = createControlServer({ core, store, port: 0, async interpret(text, _rules, catalog) {
    assert.equal(text, '돌벽 작은 집 지어'); assert.deepEqual(catalog, [definition]);
    return { goal: GoalInputSchema.parse({ kind: 'build', source: 'user', params: { blueprint: definition.id } }), source: 'code', warnings: [] };
  } });
  const address = await api.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/goals/interpret`, { method: 'POST', headers: headers(), body: JSON.stringify({ text: '돌벽 작은 집 지어' }) });
    assert.equal(response.status, 200); assert.equal((await response.json() as { goal: { params: { blueprint: string } } }).goal.params.blueprint, definition.id);
  } finally { await api.close(); store.close(); }
});
