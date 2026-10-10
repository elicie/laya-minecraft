import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { BuildSitePreparationSchema, BuildWaitingForSchema, DEFAULT_RULES, type JsonObject, type Position, type TaskSpec } from '../packages/contracts/src';
import { preserveMaterialWait } from '../packages/minecraft/src/material-wait';
import { executeVillageTask } from '../packages/minecraft/src/village-actions';
import { ConditionWait, type ActionServices } from '../packages/minecraft/src/services';

const resource = { x: 17, y: 63, z: 9 }, recovery: JsonObject = { cobblestone: { origin: { x: 0, y: 64, z: 0 }, visited: [], probes: [{ position: resource, name: 'stone' }], failed: [{ position: resource, name: 'stone', reason: 'NO_PATH' }], destinationsUsed: 5, elapsedMs: 60000, status: 'exhausted' } };
function services(hole?: Position): { services: ActionServices; effects: string[] } {
  const effects: string[] = [], rules = { ...structuredClone(DEFAULT_RULES), center: { x: 0, y: 64, z: 0 }, radius: 64 };
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => [] }, blockAt: (p: Position) => ({ name: hole && p.x === hole.x && p.y === hole.y && p.z === hole.z || p.y >= 64 ? 'air' : 'grass_block', position: new Vec3(p.x, p.y, p.z), boundingBox: hole && p.x === hole.x && p.y === hole.y && p.z === hole.z || p.y >= 64 ? 'empty' : 'block', canHarvest: () => true }), dig: async () => { effects.push('dig'); } } as unknown as Bot;
  const service: ActionServices = { bot, rules, signal: new AbortController().signal, checkpoint: { missingResource: 'cherry_log', resourceNames: ['cherry_log'], resourcePositions: [{ x: 99, y: 64, z: 99 }], resourceRecovery: { '$food': { destinationsUsed: 3 } } }, observations: [], evidence: [], check() {}, async pause() {}, async near(p) { bot.entity.position = new Vec3(p.x, p.y, p.z); }, async place() { effects.push('place'); }, progress() {}, async ensureItem() { throw new ConditionWait('원천 돌 접근 경로가 막혔습니다.', { missingResource: 'cobblestone', minimum: 2, resourceNames: ['cobblestone'], resourcePositions: [resource], failedCause: 'NO_SAFE_ACCESS', resourceRecovery: recovery, waitingFor: { kind: 'blocks', causeCode: 'BUILD_ACCESS', positions: [resource] } }); }, observeInventory() { return { id: `inventory-${service.observations.length}`, kind: 'inventory', observedAt: Date.now(), world: rules.world, dimension: rules.dimension, data: { items: [] } }; } };
  return { services: service, effects };
}

function assertContext(checkpoint: JsonObject) {
  const wait = BuildWaitingForSchema.parse(checkpoint.waitingFor); assert.equal(wait.kind, 'inventory');
  if (wait.kind !== 'inventory') return;
  assert.equal(wait.item, 'cobblestone'); assert.equal(wait.minimum, 2); assert.deepEqual(wait.resourceNames, ['stone', 'cobblestone']);
  assert.deepEqual(wait.resourcePositions, [resource]); assert.equal(wait.failedCause, 'NO_SAFE_ACCESS');
  assert.equal(checkpoint.missingResource, 'cobblestone'); assert.deepEqual(checkpoint.resourceNames, ['stone', 'cobblestone']);
  assert.deepEqual(checkpoint.resourceRecovery, { '$food': { destinationsUsed: 3 }, ...recovery });
}

test('material context replaces stale arbitrary wood, preserves nested budgets and does not leak old waitingFor', () => {
  const f = services();
  const error = new ConditionWait('관측한 돌 접근 대기', { missingResource: 'cobblestone', minimum: 2, resourceNames: ['cobblestone'], resourcePositions: [resource], failedCause: 'NO_SAFE_ACCESS', resourceRecovery: recovery, waitingFor: { kind: 'blocks', causeCode: 'BUILD_ACCESS', positions: [resource] } });
  const wrapped = preserveMaterialWait(f.services, 'stone_bricks', error); assert.equal(wrapped.checkpoint, f.services.checkpoint); assert.equal(wrapped.message, error.message); assertContext(wrapped.checkpoint);
});

test('the actual build executor returns recursive source positions and recovery budget without effects', async () => {
  const f = services(), task: TaskSpec = { id: 'build', goalId: 'goal', kind: 'build', source: 'user', params: {}, completion: { kind: 'blocks', blocks: [{ position: { x: 3, y: 64, z: 3 }, name: 'cobblestone' }] }, dependencies: [], reservationKeys: [] };
  const result = await executeVillageTask(task, f.services); assert.equal(result.outcome, 'condition-wait'); assertContext(result.checkpoint); assert.deepEqual(f.effects, []);
});

test('terrain fill material wrapping preserves the same canonical context and bounded search checkpoint', async () => {
  const hole = { x: 3, y: 63, z: 3 }, f = services(hole), plan = BuildSitePreparationSchema.parse({ origin: { x: 1, y: 64, z: 1 }, design: 'cabin', entrance: { x: 3, y: 64, z: 0 }, observedAt: 1, near: { x: 0.5, y: 64, z: 0.5 }, edits: [{ position: hole, before: 'air', after: 'dirt' }], path: [0, 1, 2, 3].map(x => ({ x, y: 64, z: 0 })) });
  const task: TaskSpec = { id: 'prepare', goalId: 'goal', kind: 'build', source: 'user', params: { mode: 'prepare-site', preparation: plan }, completion: { kind: 'exploration', minVisits: 1, resourceNames: [] }, dependencies: [], reservationKeys: [] };
  const result = await executeVillageTask(task, f.services); assert.equal(result.outcome, 'condition-wait'); assertContext(result.checkpoint); assert.deepEqual(f.effects, []); assert.deepEqual(result.checkpoint.buildSitePreparation, plan);
});

test('malformed resource coordinates are excluded, context stays bounded and absent new sources clear stale coordinates', () => {
  const f = services();
  const positions = Array.from({ length: 80 }, (_, x) => ({ x, y: 63, z: 0 }));
  const wrapped = preserveMaterialWait(f.services, 'cobblestone', new ConditionWait('대기', { resourcePositions: [...positions, { x: 2.5, y: 63, z: 0 }], resourceNames: ['stone'] }));
  const first = BuildWaitingForSchema.parse(wrapped.checkpoint.waitingFor); assert.ok(first.kind === 'inventory'); assert.equal(first.resourcePositions?.length, 64);
  preserveMaterialWait(f.services, 'oak_log', new ConditionWait('새 나무 대기', { missingResource: 'oak_log' }));
  assert.equal(f.services.checkpoint.resourcePositions, undefined); assert.deepEqual(f.services.checkpoint.resourceNames, ['oak_log']);
});
