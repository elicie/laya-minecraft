import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, WorkerMessageSchema, type Position } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ResourceRecovery, safeResourceStand } from '../packages/minecraft/src/resource-recovery';
import { ActionFailure, ConditionWait } from '../packages/minecraft/src/services';

function fixture() {
  const cells = new Map<string, string>(), ages = new Map<string, number>(), sources: Vec3[] = [], stock = new Map<string, number>(), moved: Vec3[] = [], dug: Vec3[] = [];
  let loaded = (_p: Vec3) => true, routeAllowed = (_p: Vec3) => true, visible = (_p: Vec3) => true;
  const blockAt = (p: Vec3) => {
    if (!loaded(p)) return null;
    const name = cells.get(p.toString()) ?? (p.y === 63 ? 'dirt' : 'air');
    return { name, position: p, boundingBox: ['air', 'cave_air', 'potatoes'].includes(name) ? 'empty' : 'block', canHarvest: () => true, getProperties: () => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(name) ? { age: ages.get(p.toString()) ?? 7 } : {} };
  };
  const launch = WorkerLaunchSchema.parse({ botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch', config: { name: 'RecoveryUnit' }, rules: { autonomyEnabled: false } });
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {}, health: 5, food: 17, blockAt,
    inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, stackSize: 64 })), emptySlotCount: () => 36 },
    registry: { itemsByName: { cobblestone: { id: 1 }, potato: { id: 2 } }, items: {} }, recipesAll: () => [],
    findBlock(request: { matching(b: unknown): boolean; useExtraInfo?(b: unknown): boolean }) { return sources.map(blockAt).find(b => b && request.matching(b) && (!request.useExtraInfo || request.useExtraInfo(b))) ?? null; },
    findBlocks(request: { point?: Position; matching(b: unknown): boolean }) { assert.ok(request.point, 'recovery resource scans must use their fixed anchor'); return sources.filter(p => { const b = blockAt(p); return b && request.matching(b); }).slice(0, 64); },
    canSeeBlock(block: { position: Vec3 }) { return visible(bot.entity.position); },
    async equip() {}, async dig(block: { name: string; position: Vec3 }) { dug.push(block.position); cells.set(block.position.toString(), 'air'); const item = block.name === 'stone' ? 'cobblestone' : block.name === 'potatoes' ? 'potato' : block.name; stock.set(item, (stock.get(item) ?? 0) + 1); },
    pathfinder: { movements: { canDig: false, allow1by1towers: false }, getPathTo(_movements: unknown, goal: { x: number; y: number; z: number }) {
      const target = new Vec3(goal.x, goal.y, goal.z); if (!routeAllowed(target)) return { status: 'noPath', path: [] };
      const start = bot.entity.position.floored(), queue = [start], previous = new Map<string, Vec3 | null>([[start.toString(), null]]);
      let found: Vec3 | undefined;
      for (let index = 0; index < queue.length && index < 10000; index++) {
        const p = queue[index]; if (p.equals(target)) { found = p; break; }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = p.offset(dx!, 0, dz!); if (previous.has(next.toString()) || next.distanceTo(start) > 50 || blockAt(next)?.boundingBox !== 'empty' || blockAt(next.offset(0, 1, 0))?.boundingBox !== 'empty' || blockAt(next.offset(0, -1, 0))?.boundingBox !== 'block') continue;
          previous.set(next.toString(), p); queue.push(next);
        }
      }
      const path = [];
      while (found && !found.equals(start)) { path.unshift({ x: found.x, y: found.y, z: found.z, toBreak: [], toPlace: [], parkour: false }); found = previous.get(found.toString())!; }
      return { status: previous.has(target.toString()) ? 'success' : 'noPath', path };
    } },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => 'overworld' }), services = executor.services(new AbortController().signal);
  services.pause = async () => {};
  services.near = async p => { const destination = new Vec3(p.x, p.y, p.z); moved.push(destination); bot.entity.position = destination; };
  const add = (p: Vec3, name: string) => { sources.push(p); cells.set(p.toString(), name); };
  return { bot, executor, services, cells, ages, sources, stock, moved, dug, add, launch, set loaded(fn: typeof loaded) { loaded = fn; }, set routeAllowed(fn: typeof routeAllowed) { routeAllowed = fn; }, set visible(fn: typeof visible) { visible = fn; } };
}

test('an unreachable exposed source is retained while actual walking discovers and collects another source', async () => {
  const f = fixture(), inaccessible = new Vec3(6, 64, 0), discovered = new Vec3(12, 64, 3);
  f.add(inaccessible, 'stone'); f.add(discovered, 'stone');
  f.loaded = p => !p.equals(discovered) || f.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) > 4;
  f.routeAllowed = p => !(p.x >= 3 && p.x <= 7 && Math.abs(p.z) <= 2);
  await f.executor.ensureItem('cobblestone', 1, f.services);
  assert.equal(f.stock.get('cobblestone'), 1); assert.deepEqual(f.dug, [discovered]); assert.equal(f.cells.get(inaccessible.toString()), 'stone');
  const records = f.services.checkpoint.resourceRecovery as Record<string, { origin: Position; failed: { position: Position }[] }>;
  assert.deepEqual(records.cobblestone.origin, { x: 0, y: 64, z: 0 }); assert.ok(records.cobblestone.failed.some(p => p.position.x === 6));
  assert.ok(f.services.observations.some(o => o.kind === 'exploration' && o.data.resources.some(r => r.position.x === discovered.x)));
});

test('critical health food recovery walks to observed ground and harvests a newly loaded crop without hunting', async () => {
  const f = fixture(), crop = new Vec3(12, 64, 3); f.add(crop, 'potatoes'); f.loaded = p => !p.equals(crop) || f.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) > 4;
  await f.executor.ensureFood(f.services); assert.equal(f.stock.get('potato'), 1); assert.deepEqual(f.dug, [crop]);
  assert.ok(f.services.observations.some(o => o.kind === 'exploration')); assert.equal(f.services.checkpoint.resourceRecoveryScope, undefined);
});

test('five failed destinations exhaust the same checkpoint and timestamps, own movement or unload grant no new budget', async () => {
  const f = fixture(); for (let x = 10; x < 23; x++) for (let z = 10; z < 15; z++) f.add(new Vec3(x, 64, z), 'stone'); f.routeAllowed = () => false;
  let clock = 0; const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone', 'cobblestone'], true, () => false, () => clock);
  assert.equal(await recovery.move(), false); assert.equal(recovery.state.destinationsUsed, 5); const wait = recovery.wait('blocked', 1);
  for (let n = 0; n < 10; n++) { clock += 100000; f.bot.entity.position.x += 0.01; const next = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone', 'cobblestone'], true, () => false, () => clock); assert.equal(next.state.destinationsUsed, 5); assert.equal(await next.move(), false); }
  f.loaded = () => false; assert.equal(new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone', 'cobblestone'], true, () => false).state.status, 'exhausted');
  assert.ok((wait.checkpoint.resourcePositions as unknown[]).length <= 64); assert.deepEqual(wait.checkpoint.resourceNames, ['stone', 'cobblestone']);
  WorkerMessageSchema.parse({ protocolVersion: 1, messageId: 'result', controllerEpoch: 'epoch', botId: 'bot', sessionId: 'session', sentAt: 1, type: 'task.result', taskId: 'task', attemptId: 'attempt', payload: { outcome: 'condition-wait', reason: wait.message, checkpoint: wait.checkpoint, observations: [], evidence: [] } });
});

test('a newly observed related source restores a bounded budget without moving the original anchor', async () => {
  const f = fixture(), recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  recovery.state.destinationsUsed = 5; recovery.wait('empty', 1); f.bot.entity.position.x = 8; f.add(new Vec3(12, 64, 3), 'stone');
  const changed = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  assert.equal(changed.state.destinationsUsed, 0); assert.deepEqual(changed.state.origin, { x: 0, y: 64, z: 0 });
});

test('search time is charged across checkpoint resumes and the running move is the final bounded attempt', async () => {
  const f = fixture(); let clock = 0; f.services.near = async () => { clock += 21000; throw new ConditionWait('NoPath'); };
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => clock);
  assert.equal(await recovery.move(), false); assert.equal(recovery.state.destinationsUsed, 3); assert.equal(recovery.state.elapsedMs, 63000); recovery.wait('timed out');
  const resumed = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => clock); assert.equal(await resumed.move(), false); assert.equal(resumed.state.elapsedMs, 63000);
});

test('unobserved, hazardous, cliff and protected destinations never become exploration moves', async () => {
  for (const bad of ['unknown', 'water', 'lava', 'cliff', 'protected']) {
    const f = fixture(), p = new Vec3(8, 64, 0);
    if (bad === 'unknown') f.loaded = q => !q.equals(p);
    if (bad === 'water' || bad === 'lava') f.cells.set(p.toString(), bad);
    if (bad === 'cliff') { f.cells.set(p.offset(1, -1, 0).toString(), 'air'); f.cells.set(p.offset(1, -2, 0).toString(), 'air'); }
    assert.equal(safeResourceStand(f.bot as unknown as Bot, p, q => bad === 'protected' && q.x === p.x), false);
  }
  const f = fixture(); f.executor.options.config.allowedActions = ['collect'];
  await assert.rejects(f.executor.ensureItem('cobblestone', 1, f.services), ConditionWait); assert.deepEqual(f.moved, []); assert.deepEqual(f.dug, []);
});

test('unknown navigation effects and cancellation propagate without exploration or consuming another candidate', async () => {
  for (const code of ['UNKNOWN', 'CANCELLED']) {
    const f = fixture(); f.add(new Vec3(2, 64, 0), 'stone'); f.services.near = async () => { throw new ActionFailure('uncertain', code, false, code === 'CANCELLED'); };
    await assert.rejects(f.executor.ensureItem('cobblestone', 1, f.services), error => error instanceof ActionFailure && error.code === code); assert.deepEqual(f.dug, []); assert.equal(f.services.observations.length, 0);
  }
  const f = fixture(); Object.assign(f.bot.pathfinder, { setGoal() {}, async goto() { throw new ActionFailure('movement effect unknown', 'UNKNOWN', false, false); } });
  await assert.rejects(f.executor.near({ x: 8, y: 64, z: 0 }, new AbortController().signal), error => error instanceof ActionFailure && error.code === 'UNKNOWN');
});

test('blocked sight tries distinct observed stand positions before rejecting the whole source', async () => {
  const f = fixture(); f.add(new Vec3(2, 64, 0), 'stone'); f.visible = p => p.x > 0.6;
  await f.executor.ensureItem('cobblestone', 1, f.services); assert.equal(f.stock.get('cobblestone'), 1); assert.ok(f.moved.length >= 2); assert.notDeepEqual(f.moved[0], f.moved[1]);
});

test('the 128 concealed-candidate cap still performs bounded exploration and returns a valid resource wait', async () => {
  const f = fixture();
  for (let x = 19; x <= 34; x++) for (let z = -1; z <= 11; z++) for (let y = 63; y <= 66; y++) f.cells.set(new Vec3(x, y, z).toString(), 'stone');
  for (let x = 20; x < 33; x++) for (let z = 0; z < 10; z++) f.sources.push(new Vec3(x, 64, z));
  await assert.rejects(f.executor.ensureItem('cobblestone', 1, f.services), error => {
    assert.ok(error instanceof ConditionWait); assert.equal(error.checkpoint.missingResource, 'cobblestone'); assert.deepEqual(error.checkpoint.resourceNames, ['stone', 'cobblestone']); assert.ok((error.checkpoint.resourcePositions as unknown[]).length <= 64); return true;
  });
  assert.ok(f.services.observations.some(o => o.kind === 'exploration')); assert.deepEqual(f.dug, []);
  const state = (f.services.checkpoint.resourceRecovery as Record<string, { destinationsUsed: number }>).cobblestone; assert.ok(state.destinationsUsed <= 5);
});

test('fresh crop maturity and loaded collision observations are required immediately before digging', async () => {
  const f = fixture(), crop = new Vec3(2, 64, 0); f.add(crop, 'potatoes');
  const original = f.bot.blockAt; let age = 7;
  f.bot.blockAt = p => { const b = original(p); return b?.name === 'potatoes' ? { ...b, getProperties: () => ({ age }) } : b; };
  f.services.near = async p => { f.bot.entity.position = new Vec3(p.x, p.y, p.z); age = 0; };
  await assert.rejects(f.executor.ensureItem('potato', 1, f.services), ConditionWait); assert.deepEqual(f.dug, []);
  const unknown = fixture(); unknown.add(new Vec3(2, 64, 0), 'stone'); unknown.loaded = p => p.y !== 63;
  await assert.rejects(unknown.executor.ensureItem('cobblestone', 1, unknown.services), ConditionWait); assert.deepEqual(unknown.moved, []); assert.deepEqual(unknown.dug, []);
});

test('an actually observed blocked route cell is watched and its hazard removal restores the exhausted budget', async () => {
  const f = fixture(), hazard = new Vec3(4, 64, 0), originalPath = f.bot.pathfinder.getPathTo;
  f.cells.set(hazard.toString(), 'lava');
  f.bot.pathfinder.getPathTo = (movements, goal) => {
    // A public path result can precede a server block update. Recovery must
    // recheck actual route cells, rather than trusting that older result.
    f.cells.delete(hazard.toString()); const path = originalPath(movements, goal); f.cells.set(hazard.toString(), 'lava'); return path;
  };
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  await assert.rejects(recovery.approach(new Vec3(8.5, 64, 0.5)), ConditionWait); recovery.state.destinationsUsed = 5;
  const wait = recovery.wait('blocked route'); assert.ok((wait.checkpoint.resourcePositions as Position[]).some(p => p.x === hazard.x && p.y === hazard.y && p.z === hazard.z)); assert.equal(f.moved.length, 0);
  f.cells.delete(hazard.toString()); f.bot.pathfinder.getPathTo = originalPath;
  const changed = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  assert.equal(changed.state.destinationsUsed, 0); assert.equal(await changed.move(), true);
});

test('a filtered immature crop is exactly watched without exploration permission and actual maturity resumes collection', async () => {
  const f = fixture(), crop = new Vec3(2, 64, 0); f.add(crop, 'potatoes'); f.ages.set(crop.toString(), 0); f.executor.options.config.allowedActions = ['collect'];
  await assert.rejects(f.executor.ensureItem('potato', 1, f.services), error => {
    assert.ok(error instanceof ConditionWait); const wait = error.checkpoint.waitingFor as { resourcePositions: Position[] };
    assert.ok(wait.resourcePositions.some(p => p.x === crop.x && p.y === crop.y && p.z === crop.z)); return true;
  });
  assert.equal(f.dug.length, 0); assert.equal(f.moved.length, 0);
  f.ages.set(crop.toString(), 7); await f.executor.ensureItem('potato', 1, f.services); assert.equal(f.stock.get('potato'), 1);
});

test('eight failed approaches leave the remaining exploration moves usable and arrival opens a new stand budget', async () => {
  const f = fixture(), destination = new Vec3(8.5, 64, 0.5);
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false);
  const near = f.services.near; f.services.near = async () => { throw new ConditionWait('NoPath'); };
  for (let n = 0; n < 8; n++) await assert.rejects(recovery.approach(destination), ConditionWait);
  await assert.rejects(recovery.approach(destination), ConditionWait);
  assert.equal(recovery.state.approachesUsed, 8); assert.equal(recovery.state.status, 'searching'); assert.equal(recovery.state.destinationsUsed, 0);
  f.services.near = near;
  assert.equal(await recovery.move(), true); assert.equal(recovery.state.destinationsUsed, 1); assert.equal(recovery.state.approachesUsed, 0);
});

test('a source stand loop that reaches eight failures still walks and collects the newly observed source', async () => {
  const f = fixture(), discovered = new Vec3(12, 64, 5);
  for (const x of [6, 8, 10]) f.add(new Vec3(x, 64, 0), 'stone'); f.add(discovered, 'stone');
  f.loaded = p => !p.equals(discovered) || f.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) > 4;
  let failedApproaches = 0;
  f.routeAllowed = p => { if (p.x >= 3 && p.x <= 12 && Math.abs(p.z) <= 2) { failedApproaches++; return false; } return true; };
  await f.executor.ensureItem('cobblestone', 1, f.services);
  assert.equal(failedApproaches, 8); assert.equal(f.stock.get('cobblestone'), 1); assert.deepEqual(f.dug, [discovered]);
  assert.ok(f.services.observations.some(o => o.kind === 'exploration'));
});

test('only the exact premature-exhaustion checkpoint regains its remaining moves without resetting origin or budgets', async () => {
  const reason = '자원 접근 예산을 소진했습니다. 실제 자원이나 접근 지형의 변화를 기다립니다.';
  for (const [destinationsUsed, elapsedMs, approachesUsed, checkpointReason, expected] of [[2, 1791, 8, reason, 'searching'], [5, 1791, 8, reason, 'exhausted'], [2, 60000, 8, reason, 'exhausted'], [2, 1791, 7, reason, 'exhausted'], [2, 1791, 8, 'actual search exhausted', 'exhausted']] as const) {
    const f = fixture(), recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 1);
    recovery.state.visited = [{ x: 8, y: 64, z: 0 }, { x: 16, y: 64, z: 0 }]; recovery.state.destinationsUsed = destinationsUsed; recovery.state.elapsedMs = elapsedMs; recovery.state.approachesUsed = approachesUsed; recovery.state.reason = checkpointReason;
    recovery.wait(checkpointReason, 1); const before = JSON.parse(JSON.stringify(recovery.state));
    f.bot.entity.position = new Vec3(16.5, 64, 0.5);
    const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 1);
    assert.deepEqual(restored.state, { ...before, status: expected, ...(expected === 'searching' ? { approachBudgetRepairApplied: true } : {}) });
    if (expected === 'searching') {
      assert.equal(await restored.move(), true); assert.equal(restored.state.destinationsUsed, 3); assert.equal(restored.state.elapsedMs, 1791); assert.equal(restored.state.approachesUsed, 0); assert.equal(restored.state.visited.length, 3);
      assert.deepEqual(restored.state.origin, { x: 0, y: 64, z: 0 });
    } else assert.equal(await restored.move(), false);
  }
});

test('a migrated checkpoint with no safe destination is repaired only once across repeated checkpoint restores', async () => {
  const f = fixture(), reason = '자원 접근 예산을 소진했습니다. 실제 자원이나 접근 지형의 변화를 기다립니다.';
  const recovery = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 1);
  recovery.state.visited = [{ x: 8, y: 64, z: 0 }, { x: 16, y: 64, z: 0 }]; recovery.state.destinationsUsed = 2; recovery.state.approachesUsed = 8; recovery.state.elapsedMs = 1791; recovery.wait(reason, 1);
  f.bot.entity.position = new Vec3(16.5, 64, 0.5); f.loaded = p => Math.abs(p.x - 16) <= 2 && Math.abs(p.z) <= 2;
  const restored = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 1);
  assert.equal(restored.state.status, 'searching'); assert.equal(await restored.move(), false);
  const result = restored.wait(reason, 1);
  WorkerMessageSchema.parse({ protocolVersion: 1, messageId: 'repaired-result', controllerEpoch: 'epoch', botId: 'bot', sessionId: 'session', sentAt: 1, type: 'task.result', taskId: 'task', attemptId: 'attempt', payload: { outcome: 'condition-wait', checkpoint: result.checkpoint } });
  for (let n = 0; n < 5; n++) {
    const next = new ResourceRecovery(f.bot as unknown as Bot, f.services, 'cobblestone', ['stone'], true, () => false, () => 100000 + n);
    assert.equal(next.state.status, 'exhausted'); assert.equal(next.state.approachBudgetRepairApplied, true); assert.equal(next.state.destinationsUsed, 2); assert.equal(next.state.approachesUsed, 8); assert.equal(next.state.elapsedMs, 1791); assert.equal(next.state.visited.length, 2); assert.deepEqual(next.state.origin, { x: 0, y: 64, z: 0 }); assert.equal(await next.move(), false);
  }
});
