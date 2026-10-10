import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import {
  BuildAccessPreparationSchema, accessPreparationProofPositions, validateBuildAccessPreparation,
  isBuildSiteAir, isBuildSiteGround, isPreparationTerrain, isPreparationVegetation,
  type BuildAccessPreparation, type ExpectedBlock, type JsonObject, type Position, type ResultPayload, type TaskSpec,
} from '../../contracts/src';
import { ActionFailure, ConditionWait, type ActionServices } from './services';
import { intersectsBotBody } from './terrain';
import { preserveMaterialWait } from './material-wait';

const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const shift = (p: Position, x: number, y: number, z: number): Position => ({ x: p.x + x, y: p.y + y, z: p.z + z });
const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
const feet = (s: ActionServices) => ({ x: Math.floor(s.bot.entity.position.x), y: Math.floor(s.bot.entity.position.y), z: Math.floor(s.bot.entity.position.z) });
const at = (s: ActionServices, p: Position) => s.bot.blockAt(new Vec3(p.x, p.y, p.z));
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
type Edit = BuildAccessPreparation['edits'][number];
const protectedCells = (s: ActionServices) => new Set(Array.isArray(s.checkpoint.protectedPositions) ? (s.checkpoint.protectedPositions as Position[]).map(key) : []);
function facts(s: ActionServices, blocks: ExpectedBlock[]): void {
  s.observations.push({ id: randomUUID(), kind: 'blocks', observedAt: Date.now(), world: s.rules.world, dimension: s.rules.dimension, data: { blocks } });
}
export function observeAccessPreparation(s: ActionServices, plan: BuildAccessPreparation): ExpectedBlock[] {
  return accessPreparationProofPositions(plan).flatMap(p => { const b = at(s, p); return b ? [{ position: p, name: b.name }] : []; });
}

/** Propose only: no digging, movement, placement or resource acquisition. */
export function findBuildAccessPreparation(s: ActionServices, target: Position, building: readonly ExpectedBlock[] = []): BuildAccessPreparation | undefined {
  const start = feet(s), started = Date.now(), deadline = started + 750;
  const protectedSet = protectedCells(s); for (const b of building) protectedSet.add(key(b.position));
  const body = new Set([-1, 0, 1].map(y => key(shift(start, 0, y, 0))));
  const cache = new Map<string, ReturnType<typeof at>>(), probes = new Map<string, Position>();
  const read = (p: Position) => { const k = key(p); if (!cache.has(k)) cache.set(k, at(s, p)); return cache.get(k); };
  const reject = (p: Position) => { if (probes.size < 64) probes.set(key(p), p); return false; };
  const add = (edits: Map<string, Edit>, p: Position, after: Edit['after']) => {
    const block = read(p), k = key(p);
    if (!block) return reject(p);
    if (after === 'air' && isBuildSiteAir(block.name) || block.name === after) return true;
    if (protectedSet.has(k) || body.has(k)) return reject(p);
    if (after === 'air' ? !isPreparationTerrain(block.name) && !isPreparationVegetation(block.name) : !isBuildSiteAir(block.name) && !isPreparationVegetation(block.name)) return reject(p);
    for (const [x, y, z] of neighbors) { const q = shift(p, x, y, z), adjacent = read(q); if (!adjacent || !isBuildSiteAir(adjacent.name) && !isPreparationTerrain(adjacent.name) && !isPreparationVegetation(adjacent.name)) return reject(q); }
    const previous = edits.get(k); if (previous && previous.after !== after) return reject(p);
    edits.set(k, { position: p, before: block.name, after }); return edits.size <= 32;
  };
  const column = (p: Position, edits: Map<string, Edit>) => {
    const ground = read(shift(p, 0, -1, 0)); if (!ground) return reject(shift(p, 0, -1, 0));
    if (!isBuildSiteGround(ground.name)) {
      let gap = 0;
      while (gap < 3) { const b = read(shift(p, 0, -1 - gap, 0)); if (!b || !isBuildSiteAir(b.name) && !isPreparationVegetation(b.name)) break; gap++; }
      if (gap < 1 || gap > 2) return reject(shift(p, 0, -1, 0));
      for (let y = gap + 1; y <= 4; y++) { const b = read(shift(p, 0, -y, 0)); if (!b || !isPreparationTerrain(b.name) || b.boundingBox !== 'block') return reject(shift(p, 0, -y, 0)); }
      for (let y = gap; y >= 1; y--) if (!add(edits, shift(p, 0, -y, 0), 'dirt')) return false;
    }
    for (const y of [0, 1]) if (!add(edits, shift(p, 0, y, 0), 'air')) return false;
    return true;
  };
  type Node = { p: Position; path: Position[]; edits: Map<string, Edit>; cost: number };
  const heuristic = (p: Position) => Math.abs(p.x - target.x) + Math.abs(p.z - target.z) + Math.abs(p.y - target.y);
  const queue: Node[] = [{ p: start, path: [start], edits: new Map(), cost: 0 }], visited = new Map<string, number>();
  let checked = 0;
  while (queue.length && checked < 1536 && Date.now() < deadline) {
    s.check(); queue.sort((a, b) => a.cost + heuristic(a.p) - b.cost - heuristic(b.p));
    const node = queue.shift()!, k = key(node.p); if ((visited.get(k) ?? Infinity) <= node.cost) continue;
    visited.set(k, node.cost); checked++;
    if (k === key(target)) {
      const plan: BuildAccessPreparation = { start, target, observedAt: Date.now(), path: node.path, edits: [...node.edits.values()] };
      const blocks = accessPreparationProofPositions(plan).flatMap(p => { const b = read(p); return b ? [{ position: p, name: b.name }] : []; });
      const checkedPlan = validateBuildAccessPreparation(plan, blocks, { expectedTarget: target, protectedPositions: [...protectedSet].map(k => { const [x, y, z] = k.split(',').map(Number); return { x: x!, y: y!, z: z! }; }) });
      if (checkedPlan.ok) {
        s.checkpoint.accessSearch = { checked, elapsedMs: Date.now() - started, probes: [...probes.values()] };
        facts(s, blocks);
        s.observations.push({ id: randomUUID(), kind: 'position', observedAt: Date.now(), world: s.rules.world, dimension: s.rules.dimension, data: { position: { x: s.bot.entity.position.x, y: s.bot.entity.position.y, z: s.bot.entity.position.z } } });
        return plan;
      }
      if (checkedPlan.position) reject(checkedPlan.position);
      continue;
    }
    if (node.path.length >= 65) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) for (const dy of [0, 1, -1]) {
      const p = shift(node.p, dx, dy, dz);
      if (Math.hypot(p.x - start.x, p.z - start.z) > 48 || Math.abs(p.y - start.y) > 8 || node.path.some(q => key(q) === key(p))) continue;
      const edits = new Map(node.edits);
      if (!column(p, edits) || dy > 0 && !add(edits, shift(node.p, 0, 2, 0), 'air')) continue;
      const extra = [...edits.values()].filter(e => !node.edits.has(key(e.position))).reduce((cost, e) => cost + (e.after === 'dirt' ? 4 : ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium'].includes(e.before) ? 3 : isPreparationVegetation(e.before) ? 0.25 : 10), 0);
      queue.push({ p, path: [...node.path, p], edits, cost: node.cost + 1 + extra + Math.abs(dy) * 0.25 });
    }
  }
  s.checkpoint.accessSearch = { checked, elapsedMs: Date.now() - started, probes: [...probes.values()] };
  return;
}

function wait(s: ActionServices, reason: string, positions: readonly Position[]): never {
  const unique = [...new Map(positions.map(p => [key(p), p])).values()].slice(0, 128);
  s.checkpoint.waitingFor = { kind: 'blocks', causeCode: 'BUILD_ACCESS', positions: unique, watchPosition: true };
  facts(s, unique.flatMap(p => { const b = at(s, p); return b ? [{ position: p, name: b.name }] : []; }));
  throw new ConditionWait(reason, s.checkpoint);
}

export function proposeBuildAccess(s: ActionServices, target: Position, building: readonly ExpectedBlock[], reason: string): never {
  const replans = typeof s.checkpoint.accessReplans === 'number' ? s.checkpoint.accessReplans : 0;
  const plan = replans < 5 ? findBuildAccessPreparation(s, target, building) : undefined;
  if (plan) {
    s.checkpoint.accessReplans = replans + 1; s.checkpoint.buildAccessPreparation = plan as unknown as JsonObject;
    s.progress('접근로 재계획', `기존 건축 입구까지 ${plan.path.length}개 발판과 자연 지형 ${plan.edits.length}개 변경을 제안합니다. 중앙 검증·예약을 기다립니다.`);
    wait(s, '기존 건축 입구로 복귀할 접근로 계획의 중앙 검증과 예약을 기다립니다.', accessPreparationProofPositions(plan));
  }
  const probes = (s.checkpoint.accessSearch as JsonObject | undefined)?.probes;
  const current = feet(s);
  wait(s, replans >= 5 ? '접근로 재계획 5회 한도에 도달했습니다. 실제 지형과 접근 조건 변화를 기다립니다.' : `${reason} 안전하게 열 수 있는 대체 접근로를 찾지 못했습니다.`, [target, shift(target, 0, -1, 0), shift(target, 0, 1, 0), current, shift(current, 0, -1, 0), shift(current, 0, 1, 0), ...(Array.isArray(probes) ? probes as Position[] : [])]);
}

/** Execute a centrally reserved route one verified local effect at a time. */
export async function prepareBuildAccess(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
  const plan = BuildAccessPreparationSchema.parse(task.params.preparation);
  s.checkpoint.buildAccessPreparation = plan as unknown as JsonObject;
  delete s.checkpoint.waitingFor;
  const protection = Array.isArray(s.checkpoint.protectedPositions) ? s.checkpoint.protectedPositions as Position[] : [];
  const validate = () => {
    const blocks = observeAccessPreparation(s, plan), proof = validateBuildAccessPreparation(plan, blocks, { allowCompletedEdits: true, protectedPositions: protection });
    if (!proof.ok) { facts(s, blocks); wait(s, proof.reason, proof.position ? [proof.position] : accessPreparationProofPositions(plan)); }
  };
  const complete = (edit: Edit) => { const name = at(s, edit.position)?.name ?? ''; return edit.after === 'air' ? isBuildSiteAir(name) : name === 'dirt' || name === 'grass_block'; };
  let arrived = 0;
  const progress = () => { const done = plan.edits.filter(complete).length; s.checkpoint.accessPreparationProgress = { completedEdits: done, totalEdits: plan.edits.length, pathIndex: arrived, pathLength: plan.path.length }; s.progress('접근로 정리', `실제 변경 ${done}/${plan.edits.length} · 복귀 ${arrived}/${plan.path.length}`); };
  const material = async (item: string) => { try { await s.ensureItem(item, 1); } catch (error) { if (error instanceof ConditionWait) throw preserveMaterialWait(s, item, error); throw error; } };
  validate();
  const edit = async (e: Edit) => {
    s.check(); validate(); if (complete(e)) return;
    const current = feet(s), p = e.position, block = at(s, p);
    if (!block || intersectsBotBody(p, s.bot.entity.position) || key(p) === key(shift(current, 0, -1, 0)) || distance(shift(p, 0.5, 0.5, 0.5), s.bot.entity.position) > 4.5) wait(s, '현재 발판과 몸을 보존하며 닿는 접근로부터 정리해야 합니다.', [p, current]);
    if (e.after === 'air') {
      if (!block.canHarvest(s.bot.heldItem?.type ?? null)) { await material('wooden_pickaxe'); const tool = s.bot.inventory.items().find(item => item.name.endsWith('_pickaxe') && block.canHarvest(item.type)); if (!tool) wait(s, '자연 돌을 정리할 수 있는 도구가 필요합니다.', [p]); await s.bot.equip(tool, 'hand'); }
      s.check(); validate(); const fresh = at(s, p);
      if (!fresh || intersectsBotBody(p, s.bot.entity.position) || key(p) === key(shift(feet(s), 0, -1, 0)) || distance(fresh.position, s.bot.entity.position) > 4.5) wait(s, '도구 준비 뒤 접근로 위치와 실제 발판을 다시 확인해야 합니다.', [p, feet(s)]);
      if (complete(e)) return;
      const dirtBefore = s.bot.inventory.items().filter(i => i.name === 'dirt').reduce((n, i) => n + i.count, 0);
      s.bot.pathfinder.setGoal(null); s.bot.clearControlStates(); await s.bot.dig(fresh); await s.pause(150);
      if (['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium'].includes(e.before)) {
        await s.recoverDrops?.(p, 'dirt', dirtBefore + 1, plan.edits.filter(e => e.after === 'air' && !complete(e)).map(e => e.position));
      }
    } else {
      await material('dirt'); s.check(); validate();
      if (key(feet(s)) !== key(current)) await s.near(shift(current, 0.5, 0, 0.5), 0);
      const fresh = at(s, p);
      if (fresh && isPreparationVegetation(fresh.name)) { await s.bot.dig(fresh); await s.pause(150); }
      s.check(); validate(); await s.place(p, 'dirt', 'dirt');
    }
    s.check(); if (!complete(e)) throw new ActionFailure('접근로 변경의 실제 결과를 확인하지 못했습니다.', 'TERRAIN_UNCERTAIN', false, false);
    facts(s, [{ position: p, name: at(s, p)!.name }]); s.observations.push(s.observeInventory()); progress();
  };
  for (let i = 0; i < plan.path.length; i++) {
    const step = plan.path[i]!, previous = plan.path[i - 1];
    if (previous && step.y > previous.y) for (const e of plan.edits.filter(e => key(e.position) === key(shift(previous, 0, 2, 0)))) await edit(e);
    const local = plan.edits.filter(e => e.position.x === step.x && e.position.z === step.z && e.position.y <= step.y + 1);
    for (const e of local.filter(e => e.after === 'air').sort((a, b) => b.position.y - a.position.y)) await edit(e);
    for (const e of local.filter(e => e.after === 'dirt').sort((a, b) => a.position.y - b.position.y)) await edit(e);
    s.check(); validate();
    try { await s.near(shift(step, 0.5, 0, 0.5), 0); } catch (error) { s.check(); if (error instanceof ConditionWait) wait(s, error.message, [step, feet(s), ...accessPreparationProofPositions(plan)]); throw error; }
    if (s.bot.entity.position.distanceTo(new Vec3(step.x + 0.5, step.y, step.z + 0.5)) > 1.5) wait(s, '정리한 접근로의 실제 도착을 확인해야 합니다.', [step, feet(s)]);
    arrived = i + 1; progress();
  }
  validate(); if (plan.edits.some(e => !complete(e))) wait(s, '남은 접근로 변경을 확인해야 합니다.', plan.edits.filter(e => !complete(e)).map(e => e.position));
  facts(s, observeAccessPreparation(s, plan)); s.observations.push(s.observeInventory());
  s.observations.push({ id: randomUUID(), kind: 'exploration', observedAt: Date.now(), world: s.rules.world, dimension: s.rules.dimension, data: { position: { x: s.bot.entity.position.x, y: s.bot.entity.position.y, z: s.bot.entity.position.z }, resources: [] } });
  s.checkpoint.accessPreparationComplete = { target: plan.target, observedAt: Date.now() };
  return { outcome: 'completed', checkpoint: s.checkpoint, observations: s.observations, evidence: s.evidence, reason: '예약한 접근로의 실제 변경과 기존 건축 입구 도착을 확인했습니다.' };
}
