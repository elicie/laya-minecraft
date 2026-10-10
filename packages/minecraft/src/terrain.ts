import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import { BLUEPRINTS } from '../../contracts/src/blueprints';
import { BuildSitePreparationSchema, preparationProofPositions, preparationSiteCells, validateBuildSitePreparation, matchesPreparationTarget, isPreparationTerrain, isPreparationVegetation, isBuildSiteAir, isBuildSiteGround, type BuildSitePreparation, type ExpectedBlock, type Position, type ResultPayload, type TaskSpec } from '../../contracts/src';
import { ActionFailure, ConditionWait, inVillage, type ActionServices } from './services';

const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const shift = (p: Position, x: number, y: number, z: number): Position => ({ x: p.x + x, y: p.y + y, z: p.z + z });
const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
const horizontal = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const softSoil = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium']);
type Edit = BuildSitePreparation['edits'][number];
const weight = (edit: Edit) => edit.after === 'dirt' ? 1 : softSoil.has(edit.before) ? 1 : isPreparationVegetation(edit.before) ? 0.1 : 4;
const actualFeet = (s: ActionServices) => ({ x: Math.floor(s.bot.entity.position.x), y: Math.floor(s.bot.entity.position.y), z: Math.floor(s.bot.entity.position.z) });
const at = (s: ActionServices, p: Position) => s.bot.blockAt(new Vec3(p.x, p.y, p.z));

export function intersectsBotBody(p: Position, feet: Position): boolean {
  const epsilon = 1e-6;
  return p.x < feet.x + 0.3 - epsilon && p.x + 1 > feet.x - 0.3 + epsilon &&
    p.z < feet.z + 0.3 - epsilon && p.z + 1 > feet.z - 0.3 + epsilon &&
    p.y < feet.y + 1.8 - epsilon && p.y + 1 > feet.y + epsilon;
}

export function observePreparation(s: ActionServices, plan: BuildSitePreparation): ExpectedBlock[] {
  return preparationProofPositions(plan).flatMap(p => { const block = at(s, p); return block ? [{ position: p, name: block.name }] : []; });
}
function facts(s: ActionServices, blocks: ExpectedBlock[]): void {
  s.observations.push({ id: randomUUID(), kind: 'blocks', observedAt: Date.now(), world: s.rules.world, dimension: s.rules.dimension, data: { blocks } });
}
function protectedCoordinates(s: ActionServices): Set<string> {
  const value = s.checkpoint.protectedPositions;
  return new Set(Array.isArray(value) ? value.flatMap(p => p && typeof p === 'object' && 'x' in p && 'y' in p && 'z' in p ? [key(p as Position)] : []) : []);
}

/** Bounded, read-only terrain proposal. No movement, digging or placement. */
export function findBuildSitePreparation(task: TaskSpec, s: ActionServices): { plan: BuildSitePreparation; blocks: ExpectedBlock[] } | undefined {
  const design = String(task.params.design ?? task.params.blueprint ?? '');
  if (!Object.hasOwn(BLUEPRINTS, design)) return;
  const dimensions = BLUEPRINTS[design as keyof typeof BLUEPRINTS];
  const startedAt = Date.now(), deadline = startedAt + 750;
  const rejected: { reason: string; position: Position; actual: string }[] = [];
  let lastRejected: { reason: string; position: Position; actual: string } | undefined;
  const near = { x: s.bot.entity.position.x, y: s.bot.entity.position.y, z: s.bot.entity.position.z }, start = actualFeet(s);
  const radius = Math.min(32, typeof task.params.searchRadius === 'number' ? task.params.searchRadius : 32);
  const protectedCells = protectedCoordinates(s), cache = new Map<string, ReturnType<typeof at>>();
  const read = (p: Position) => { const k = key(p); if (!cache.has(k)) cache.set(k, at(s, p)); return cache.get(k)!; };
  const reject = (reason: string, p: Position) => { lastRejected = { reason, position: p, actual: read(p)?.name ?? 'unloaded' }; if (rejected.length < 6) rejected.push(lastRejected); return false; };
  const protectedStart = new Set([-1, 0, 1].map(y => key(shift(start, 0, y, 0))));
  const add = (edits: Map<string, Edit>, p: Position, after: Edit['after']): boolean => {
    const block = read(p), k = key(p);
    if (!block) return reject('지형 청크가 관측되지 않았습니다.', p);
    if ((after === 'air' && isBuildSiteAir(block.name)) || block.name === after) return true;
    if (protectedCells.has(k) || protectedStart.has(k)) return reject('봇의 발판이나 다른 예약 위치를 보존해야 합니다.', p);
    if (after === 'air' ? !(isPreparationTerrain(block.name) || isPreparationVegetation(block.name)) : !(isBuildSiteAir(block.name) || isPreparationVegetation(block.name))) return reject('기존 시설·작물이나 자연 지형이 아닌 블록을 보존합니다.', p);
    for (const [x, y, z] of neighbors) { const q = shift(p, x, y, z), adjacent = read(q); if (!adjacent || !(isPreparationTerrain(adjacent.name) || isPreparationVegetation(adjacent.name) || isBuildSiteAir(adjacent.name))) return reject('인접 시설·작물·액체·중력 블록 또는 미관측 지형을 보존합니다.', q); }
    const old = edits.get(k); if (old && old.after !== after) return false;
    edits.set(k, { position: p, before: block.name, after }); return edits.size <= 192 || reject('지형 변경 192개 한도를 넘습니다.', p);
  };
  const column = (feet: Position, clearance: number, edits: Map<string, Edit>): boolean => {
    // Fill only a shallow open surface depression on solid natural ground.
    // A solid crust above a cave fails this four-layer proof as well.
    let gap = 0;
    while (gap < 4) { const name = read(shift(feet, 0, -1 - gap, 0))?.name ?? ''; if (!isBuildSiteAir(name) && !isPreparationVegetation(name)) break; gap++; }
    if (gap > 2) return reject('메우기 두 층 한도를 넘거나 빈 동굴 위에 있습니다.', shift(feet, 0, -3, 0));
    for (let y = gap + 1; y <= 4; y++) { const p = shift(feet, 0, -y, 0), b = read(p); if (!b || !isPreparationTerrain(b.name) || b.boundingBox !== 'block') return reject('네 층의 실제 천연 지지 지반을 확인해야 합니다.', p); }
    for (let y = gap; y >= 1; y--) if (!add(edits, shift(feet, 0, -y, 0), 'dirt')) return false;
    for (let y = 0; y <= clearance; y++) {
      const p = shift(feet, 0, y, 0), b = read(p);
      if (!b) return reject('전체 건축 공간의 청크가 관측되지 않았습니다.', p);
      if (!isBuildSiteAir(b.name) && y >= 2 && !(y === 2 && isPreparationVegetation(b.name))) return reject('깎기 두 층 한도 위에 기존 블록이 있습니다.', p);
      if (!isBuildSiteAir(b.name) && !add(edits, p, 'air')) return false;
    }
    return true;
  };
  const origins: Position[] = [];
  const anchor = { x: Math.floor(near.x - (dimensions.width - 1) / 2), z: Math.floor(near.z - (dimensions.depth - 1) / 2) };
  for (let dx = -32; dx <= 32; dx++) for (let dz = -32; dz <= 32; dz++) if (Math.hypot(anchor.x + dx + (dimensions.width - 1) / 2 - near.x, anchor.z + dz + (dimensions.depth - 1) / 2 - near.z) <= radius) origins.push({ x: anchor.x + dx, y: start.y, z: anchor.z + dz });
  origins.sort((a, b) => Math.hypot(a.x - anchor.x, a.z - anchor.z) - Math.hypot(b.x - anchor.x, b.z - anchor.z));
  let best: { plan: BuildSitePreparation; blocks: ExpectedBlock[]; cost: number } | undefined;
  let evaluated = 0;
  for (const origin of origins.slice(0, 384)) {
    if (Date.now() >= deadline) break;
    s.check(); evaluated++;
    const entrance = { x: origin.x + Math.floor(dimensions.width / 2), y: origin.y, z: origin.z - 1 };
    const initial: BuildSitePreparation = { origin, design, entrance, near, observedAt: Date.now(), edits: [], path: [start] };
    const cells = preparationSiteCells(initial), edits = new Map<string, Edit>();
    if (task.source !== 'user' && cells.some(c => !inVillage(c.position, s.rules))) continue;
    let possible = true;
    for (const cell of cells.filter(c => c.requirement === 'ground')) {
      const inside = cell.position.x >= origin.x && cell.position.x < origin.x + dimensions.width && cell.position.z >= origin.z && cell.position.z < origin.z + dimensions.depth;
      if (!column(shift(cell.position, 0, 1, 0), inside ? dimensions.height : 1, edits)) { possible = false; break; }
    }
    if (!possible || (best && [...edits.values()].reduce((sum, edit) => sum + weight(edit), 0) > best.cost)) continue;
    // A bounded route through natural soil can be opened one step at a time.
    // Keeping the target plane level lets a trapped bot cut an adjacent wall
    // before any request to walk through it.
    type Node = { p: Position; path: Position[]; edits: Map<string, Edit>; cost: number };
    const heuristic = (p: Position) => Math.abs(p.x - entrance.x) + Math.abs(p.z - entrance.z);
    const queue: Node[] = [{ p: start, path: [start], edits, cost: 0 }], visited = new Set<string>();
    let route: Node | undefined;
    for (let n = 0; n < 768 && queue.length; n++) {
      if (Date.now() >= deadline) break;
      queue.sort((a, b) => a.cost + heuristic(a.p) - b.cost - heuristic(b.p));
      const node = queue.shift()!; if (visited.has(key(node.p))) continue; visited.add(key(node.p));
      if (key(node.p) === key(entrance)) { route = node; break; }
      if (node.path.length >= 65) continue;
      for (const [dx, dz] of horizontal) {
        const p = shift(node.p, dx, 0, dz);
        if (visited.has(key(p)) || Math.hypot(p.x - near.x, p.z - near.z) > radius || protectedCells.has(key(p))) continue;
        const combined = new Map(node.edits);
        if (!column(p, 1, combined)) continue;
        queue.push({ p, path: [...node.path, p], edits: combined, cost: node.cost + 1 + Math.max(0, combined.size - node.edits.size) * 2 });
      }
    }
    if (!route) { reject('변경 한도 안에서 안전하게 열 수 있는 접근로를 확인하지 못했습니다.', entrance); continue; }
    const plan = { ...initial, edits: [...route.edits.values()], path: route.path };
    const blocks = preparationProofPositions(plan).flatMap(p => { const b = read(p); return b ? [{ position: p, name: b.name }] : []; });
    if (!validateBuildSitePreparation(plan, blocks, { near }).ok) continue;
    const cost = plan.edits.reduce((sum, edit) => sum + weight(edit), 0) + Math.hypot(origin.x - anchor.x, origin.z - anchor.z) * 0.2 + plan.path.length * 0.1;
    if (!best || cost < best.cost) best = { plan, blocks, cost };
    if (plan.edits.length === 0 || evaluated >= 64 && best) break;
  }
  s.checkpoint.buildPreparationSearch = { checked: evaluated, elapsedMs: Date.now() - startedAt, evaluationBudgetMs: 750, exhausted: Date.now() >= deadline, rejected, ...(lastRejected ? { lastRejected } : {}) };
  return best ? { plan: best.plan, blocks: best.blocks } : undefined;
}

function wait(s: ActionServices, message: string, positions: Position[], causeCode = 'BUILD_SITE'): never {
  const unique = [...new Map(positions.map(p => [key(p), p])).values()];
  s.checkpoint.waitingFor = { kind: 'blocks', causeCode, positions: unique, ...(causeCode === 'BUILD_ACCESS' ? { watchPosition: true } : {}) };
  facts(s, unique.flatMap(p => { const b = at(s, p); return b ? [{ position: p, name: b.name }] : []; }));
  throw new ConditionWait(`${message} (${unique.slice(0, 4).map(key).join(' / ')})`, s.checkpoint);
}
function inventoryCount(s: ActionServices, name: string): number { return s.bot.inventory.items().filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0); }

/** Execute only a centrally validated/reserved plan, rechecking every effect. */
export async function prepareBuildSite(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
  const plan = BuildSitePreparationSchema.parse(task.params.preparation);
  const proof = preparationProofPositions(plan);
  s.checkpoint.buildSitePreparation = plan;
  s.checkpoint.buildPreparationProtection = proof;
  delete s.checkpoint.waitingFor;
  const elsewhere = protectedCoordinates(s);
  const collision = plan.edits.find(e => elsewhere.has(key(e.position)));
  if (collision) wait(s, '다른 작업이 예약한 위치를 보존해야 합니다.', [collision.position]);
  const complete = (edit: Edit, name: string | undefined) => matchesPreparationTarget(edit, name ?? '');
  const validate = () => {
    const observed = observePreparation(s, plan);
    const check = validateBuildSitePreparation(plan, observed, { allowCompletedEdits: true });
    if (!check.ok) { facts(s, observed); wait(s, check.reason, check.position ? [check.position] : proof.slice(0, 6)); }
  };
  validate();
  let confirmedWaypoints = 0;
  const progress = (stage: 'access' | 'excavate' | 'fill' | 'verify', pathIndex: number) => {
    const done = plan.edits.filter(edit => complete(edit, at(s, edit.position)?.name));
    s.checkpoint.preparationProgress = { stage, completedEdits: done.length, totalEdits: plan.edits.length, excavated: done.filter(e => e.after === 'air').length, filled: done.filter(e => e.after === 'dirt').length, pathIndex: confirmedWaypoints, pathLength: plan.path.length };
    s.progress('부지 정리', `실제 정리 ${done.length}/${plan.edits.length} · 접근 ${pathIndex + 1}/${plan.path.length}`);
  };
  const bodyIntersects = (p: Position) => intersectsBotBody(p, s.bot.entity.position);
  const approach = async (p: Position) => {
    try { await s.near(shift(p, 0.5, 0, 0.5), 0); }
    catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; const feet = actualFeet(s); wait(s, error.message, [p, feet, shift(feet, 0, -1, 0), shift(feet, 0, 1, 0)], 'BUILD_ACCESS'); }
  };
  const material = async (item: string) => {
    try { await s.ensureItem(item, 1); }
    catch (error) {
      if (!(error instanceof ConditionWait)) throw error;
      const missing = typeof error.checkpoint.missingResource === 'string' ? error.checkpoint.missingResource : typeof error.checkpoint.missingItem === 'string' ? error.checkpoint.missingItem : item;
      s.checkpoint.waitingFor = { kind: 'inventory', causeCode: 'BUILD_MATERIAL', item: missing, minimum: typeof error.checkpoint.minimum === 'number' ? error.checkpoint.minimum : 1, watchPosition: true, resourceNames: Array.isArray(error.checkpoint.resourceNames) ? error.checkpoint.resourceNames : [missing] };
      throw new ConditionWait(error.message, s.checkpoint);
    }
  };
  const intermediate = (edit: Edit, name: string | undefined) => edit.after === 'dirt' && isPreparationVegetation(edit.before) && isBuildSiteAir(name ?? '');
  const execute = async (edit: Edit, pathIndex: number): Promise<void> => {
    s.check(); validate();
    const current = at(s, edit.position); if (complete(edit, current?.name)) return;
    if (!current || current.name !== edit.before && !intermediate(edit, current.name)) wait(s, '정리 전에 블록이 바뀌어 기존 상태를 보존합니다.', [edit.position]);
    const feet = actualFeet(s);
    if (bodyIntersects(edit.position) || key(edit.position) === key(shift(feet, 0, -1, 0))) wait(s, '봇의 실제 발판과 몸 공간을 보존해야 합니다.', [edit.position, feet], 'BUILD_ACCESS');
    if (edit.after === 'air') {
      if (s.bot.entity.position.distanceTo(new Vec3(edit.position.x + 0.5, edit.position.y + 0.5, edit.position.z + 0.5)) > 4.5) wait(s, '현재 안전한 발판에서 닿는 자연 지형부터 정리해야 합니다.', [edit.position, feet], 'BUILD_ACCESS');
      if (!current.canHarvest(s.bot.heldItem?.type ?? null)) {
        await material('wooden_pickaxe');
        const tool = s.bot.inventory.items().find(i => i.name.endsWith('_pickaxe') && current.canHarvest(i.type));
        if (!tool) wait(s, '자연 돌을 정리할 수 있는 도구가 필요합니다.', [edit.position]);
        await s.bot.equip(tool, 'hand'); s.check(); validate();
        if (key(actualFeet(s)) !== key(feet)) { await approach(feet); validate(); }
      }
      const refreshed = at(s, edit.position);
      if (complete(edit, refreshed?.name)) return;
      if (!refreshed || refreshed.name !== edit.before || bodyIntersects(edit.position) || key(edit.position) === key(shift(actualFeet(s), 0, -1, 0)) || s.bot.entity.position.distanceTo(new Vec3(edit.position.x + 0.5, edit.position.y + 0.5, edit.position.z + 0.5)) > 4.5) wait(s, '도구 준비 후 정리 위치와 실제 블록을 다시 확인해야 합니다.', [edit.position, actualFeet(s)], 'BUILD_ACCESS');
      const before = inventoryCount(s, 'dirt'); progress('excavate', pathIndex);
      s.bot.pathfinder.setGoal(null); s.bot.clearControlStates();
      await s.bot.dig(at(s, edit.position)!); await s.pause(150);
      if (softSoil.has(edit.before)) await s.recoverDrops?.(edit.position, 'dirt', before + 1, plan.edits.filter(e => e.after === 'air' && !complete(e, at(s, e.position)?.name)).map(e => e.position));
      s.check(); validate();
      if (key(actualFeet(s)) !== key(feet)) { await approach(feet); validate(); }
    } else {
      progress('fill', pathIndex);
      if (inventoryCount(s, 'dirt') < 1) {
        const nearbyCuts = plan.edits.filter(e => e.after === 'air' && softSoil.has(e.before) && !complete(e, at(s, e.position)?.name) && !bodyIntersects(e.position) && key(e.position) !== key(shift(actualFeet(s), 0, -1, 0)) && s.bot.entity.position.distanceTo(new Vec3(e.position.x + 0.5, e.position.y + 0.5, e.position.z + 0.5)) <= 4.5)
          .sort((a, b) => b.position.y - a.position.y);
        for (const cut of nearbyCuts) { if (inventoryCount(s, 'dirt') >= 1) break; await execute(cut, pathIndex); }
      }
      if (inventoryCount(s, 'dirt') < 1) {
        await material('dirt');
      }
      // Both resource collection and recovery of our own excavated drops may
      // move the bot. Return before clearing weeds or filling the original cell.
      s.check(); validate();
      if (key(actualFeet(s)) !== key(feet)) { await approach(feet); validate(); }
      if (complete(edit, at(s, edit.position)?.name)) return;
      const refreshed = at(s, edit.position);
      if (!refreshed || refreshed.name !== edit.before && !intermediate(edit, refreshed.name) || bodyIntersects(edit.position) || key(edit.position) === key(shift(actualFeet(s), 0, -1, 0))) wait(s, '흙 준비 후 실제 블록과 발판을 다시 확인해야 합니다.', [edit.position, actualFeet(s)], 'BUILD_ACCESS');
      if (isPreparationVegetation(refreshed.name)) {
        if (s.bot.entity.position.distanceTo(new Vec3(edit.position.x + 0.5, edit.position.y + 0.5, edit.position.z + 0.5)) > 4.5) wait(s, '메울 자리의 자연 풀에 닿는 안전한 위치가 필요합니다.', [edit.position, actualFeet(s)], 'BUILD_ACCESS');
        progress('excavate', pathIndex); await s.bot.dig(refreshed); await s.pause(150);
        if (!intermediate(edit, at(s, edit.position)?.name)) throw new ActionFailure('자연 풀 제거의 실제 빈 공간을 확인하지 못했습니다.', 'TERRAIN_UNCERTAIN', false, false);
        facts(s, [{ position: edit.position, name: at(s, edit.position)!.name }]);
      }
      s.check(); validate();
      try { await s.place(edit.position, 'dirt', 'dirt'); }
      catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; const feet = actualFeet(s); wait(s, error.message, [edit.position, feet, shift(feet, 0, -1, 0), shift(feet, 0, 1, 0)], 'BUILD_ACCESS'); }
    }
    const final = at(s, edit.position);
    if (!complete(edit, final?.name)) throw new ActionFailure('지형 정리의 실제 블록 변화를 확인하지 못했습니다.', 'TERRAIN_UNCERTAIN', false, false);
    s.observations.push(s.observeInventory()); facts(s, [{ position: edit.position, name: final!.name }]); progress('access', pathIndex);
  };
  // Open the next two-high cell before walking; this also escapes a soil-sided
  // spawn pocket without asking pathfinder to pass through the blocking wall.
  for (let index = 0; index < plan.path.length; index++) {
    s.check(); const step = plan.path[index]!;
    const stepEdits = plan.edits.filter(e => e.position.x === step.x && e.position.z === step.z && e.position.y <= step.y + 1);
    for (const edit of stepEdits.filter(e => e.after === 'air').sort((a, b) => b.position.y - a.position.y)) await execute(edit, index);
    for (const edit of stepEdits.filter(e => e.after === 'dirt').sort((a, b) => a.position.y - b.position.y)) await execute(edit, index);
    if (!isBuildSiteGround(at(s, shift(step, 0, -1, 0))?.name ?? '') || !isBuildSiteAir(at(s, step)?.name ?? '') || !isBuildSiteAir(at(s, shift(step, 0, 1, 0))?.name ?? '')) wait(s, '정리한 접근로의 발판과 머리 공간을 다시 확인해야 합니다.', [step, shift(step, 0, -1, 0), shift(step, 0, 1, 0)], 'BUILD_ACCESS');
    progress('access', index); await approach(step);
    if (s.bot.entity.position.distanceTo(new Vec3(step.x + 0.5, step.y, step.z + 0.5)) > 1.5) wait(s, '접근로에 실제로 도착하지 못했습니다.', [step], 'BUILD_ACCESS');
    confirmedWaypoints = index + 1; progress('access', index);
  }
  // Complete a reachable column before moving to a farther one. Clearing every
  // upper layer first would leave the lower layer blocking all safe footholds.
  for (let iteration = 0; iteration < plan.edits.length; iteration++) {
    s.check();
    const remaining = plan.edits.filter(edit => !complete(edit, at(s, edit.position)?.name));
    if (!remaining.length) break;
    const columns = new Map<string, Edit[]>();
    for (const edit of remaining) { const column = `${edit.position.x},${edit.position.z}`; const entries = columns.get(column) ?? []; entries.push(edit); columns.set(column, entries); }
    const frontier = [...columns.values()].map(entries => entries.sort((a, b) => a.after === b.after ? a.after === 'air' ? b.position.y - a.position.y : a.position.y - b.position.y : a.after === 'air' ? -1 : 1)[0]!);
    const distance = (p: Position) => s.bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5));
    frontier.sort((a, b) => distance(a.position) - distance(b.position));
    const direct = frontier.find(edit => distance(edit.position) <= 4.5 && !bodyIntersects(edit.position) && key(edit.position) !== key(shift(actualFeet(s), 0, -1, 0)));
    if (direct) { await execute(direct, plan.path.length - 1); continue; }
    const remainingCuts = new Set(remaining.filter(e => e.after === 'air').map(e => key(e.position)));
    let reachable: Edit | undefined, navigationAttempts = 0;
    for (const edit of frontier) {
      // Walk only on actual cleared cells; never use soil still due for cutting.
      const stands = proof.filter(p => Math.abs(p.y - plan.origin.y) <= 1 && Math.hypot(p.x - edit.position.x, p.z - edit.position.z) <= 3 &&
        isBuildSiteGround(at(s, shift(p, 0, -1, 0))?.name ?? '') && isBuildSiteAir(at(s, p)?.name ?? '') && isBuildSiteAir(at(s, shift(p, 0, 1, 0))?.name ?? '') && key(p) !== key(edit.position) && key(shift(p, 0, 1, 0)) !== key(edit.position) && !remainingCuts.has(key(shift(p, 0, -1, 0))));
      stands.sort((a, b) => distance(a) - distance(b));
      for (const stand of stands.slice(0, 3)) {
        if (++navigationAttempts > 8) break;
        try { await s.near(shift(stand, 0.5, 0, 0.5), 0); reachable = edit; break; }
        catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; }
      }
      if (reachable || navigationAttempts >= 8) break;
    }
    if (!reachable) wait(s, '남은 자연 지형에 닿는 안전한 접근 위치가 필요합니다.', frontier.slice(0, 6).map(e => e.position), 'BUILD_ACCESS');
    await execute(reachable, plan.path.length - 1);
  }
  validate(); progress('verify', plan.path.length - 1);
  await approach(plan.entrance);
  const blocks = observePreparation(s, plan), cells = preparationSiteCells(plan), names = new Map(blocks.map(b => [key(b.position), b.name]));
  const missing = cells.find(c => !(c.requirement === 'air' ? isBuildSiteAir(names.get(key(c.position)) ?? '') : isBuildSiteGround(names.get(key(c.position)) ?? '')));
  if (missing) wait(s, '정리 후 전체 부지의 실제 상태가 준비 기준을 충족하지 않습니다.', [missing.position]);
  if (s.bot.entity.position.distanceTo(new Vec3(plan.entrance.x + 0.5, plan.entrance.y, plan.entrance.z + 0.5)) > 1.5) wait(s, '정리 후 실제 출입 위치에 도착해야 합니다.', [plan.entrance], 'BUILD_ACCESS');
  facts(s, blocks); s.observations.push(s.observeInventory());
  const observedAt = Date.now(); s.checkpoint.buildSite = { origin: plan.origin, design: plan.design, entrance: plan.entrance, observedAt };
  s.observations.push({ id: randomUUID(), kind: 'exploration', observedAt, world: s.rules.world, dimension: s.rules.dimension, data: { position: { x: s.bot.entity.position.x, y: s.bot.entity.position.y, z: s.bot.entity.position.z }, resources: blocks.filter(b => isBuildSiteGround(b.name)).slice(0, 64) } });
  delete s.checkpoint.waitingFor;
  return { outcome: 'completed', checkpoint: s.checkpoint, observations: s.observations, evidence: s.evidence, reason: '평탄한 부지와 지지 지반, 실제 접근로를 확인했습니다. 건설 단계로 이어갈 수 있습니다.' };
}
