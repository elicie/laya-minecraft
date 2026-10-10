import { z } from 'zod';
import type { ExpectedBlock, Position } from './index';
import { isBuildSiteAir, isBuildSiteGround } from './index';
import { isPreparationTerrain, isPreparationVegetation } from './build-site-preparation';

const cell = z.object({ x: z.number().int().finite(), y: z.number().int().finite(), z: z.number().int().finite() }).strict();
export const BuildAccessPreparationSchema = z.object({
  start: cell, target: cell, observedAt: z.number().int().nonnegative(),
  path: z.array(cell).min(1).max(65),
  edits: z.array(z.object({ position: cell, before: z.string().min(1), after: z.enum(['air', 'dirt']) }).strict()).max(32),
}).strict();
export type BuildAccessPreparation = z.infer<typeof BuildAccessPreparationSchema>;
const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const shift = (p: Position, x: number, y: number, z: number): Position => ({ x: p.x + x, y: p.y + y, z: p.z + z });
const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/** Every route cell, shallow foundation and affected neighbor is reserved. */
export function accessPreparationProofPositions(plan: BuildAccessPreparation): Position[] {
  const cells = plan.path.flatMap(p => [-4, -3, -2, -1, 0, 1, 2].map(y => shift(p, 0, y, 0)));
  for (const edit of plan.edits) cells.push(edit.position, ...neighbors.map(([x, y, z]) => shift(edit.position, x, y, z)));
  return [...new Map(cells.map(p => [key(p), p])).values()];
}
export type AccessPreparationValidation = { ok: true; plan: BuildAccessPreparation; proofPositions: Position[] } | { ok: false; reason: string; position?: Position };

/** Read-only validation shared by the central scheduler and actual executor. */
export function validateBuildAccessPreparation(value: unknown, blocks: readonly ExpectedBlock[], options: { allowCompletedEdits?: boolean; expectedTarget?: Position; protectedPositions?: readonly Position[] } = {}): AccessPreparationValidation {
  const fail = (reason: string, position?: Position): AccessPreparationValidation => ({ ok: false, reason, ...(position ? { position } : {}) });
  const parsed = BuildAccessPreparationSchema.safeParse(value);
  if (!parsed.success) return fail('접근로 계획의 좌표·경로·변경 한도를 확인해야 합니다.');
  const plan = parsed.data;
  if (key(plan.path[0]!) !== key(plan.start) || key(plan.path.at(-1)!) !== key(plan.target) || options.expectedTarget && key(options.expectedTarget) !== key(plan.target)) return fail('접근로는 실제 시작 위치에서 기존 건축 입구까지 연결되어야 합니다.');
  const route = new Set<string>(), allowedCuts = new Set<string>(), allowedFills = new Set<string>();
  for (let i = 0; i < plan.path.length; i++) {
    const p = plan.path[i]!;
    if (route.has(key(p)) || Math.hypot(p.x - plan.start.x, p.z - plan.start.z) > 48 || Math.abs(p.y - plan.start.y) > 8) return fail('접근로는 원점 주변의 제한된 범위에서 반복 없이 연결되어야 합니다.', p);
    if (i) { const previous = plan.path[i - 1]!; if (Math.abs(p.x - previous.x) + Math.abs(p.z - previous.z) !== 1 || Math.abs(p.y - previous.y) > 1) return fail('접근로는 높이 차 한 칸 이내의 인접 발판으로 연결되어야 합니다.', p); }
    route.add(key(p)); for (const y of [0, 1]) allowedCuts.add(key(shift(p, 0, y, 0)));
    if (plan.path[i + 1] && plan.path[i + 1]!.y > p.y) allowedCuts.add(key(shift(p, 0, 2, 0)));
    for (const y of [-1, -2]) allowedFills.add(key(shift(p, 0, y, 0)));
  }
  const proofPositions = accessPreparationProofPositions(plan), actual = new Map(blocks.map(b => [key(b.position), b.name]));
  for (const p of proofPositions) if (!actual.has(key(p))) return fail('경로와 변경 주변의 전체 실제 관측이 필요합니다.', p);
  const protectedCells = new Set((options.protectedPositions ?? []).map(key));
  const originalBody = new Set([-1, 0, 1].map(y => key(shift(plan.start, 0, y, 0))));
  const edits = new Map<string, BuildAccessPreparation['edits'][number]>();
  for (const edit of plan.edits) {
    const k = key(edit.position), name = actual.get(k)!;
    if (edits.has(k) || protectedCells.has(k) || originalBody.has(k)) return fail('중복 변경과 예약 위치·원래 발판·몸 공간의 변경을 허용하지 않습니다.', edit.position);
    if (edit.before === edit.after || (edit.after === 'air' ? !allowedCuts.has(k) || !isPreparationTerrain(edit.before) && !isPreparationVegetation(edit.before) : !allowedFills.has(k) || !isBuildSiteAir(edit.before) && !isPreparationVegetation(edit.before))) return fail('접근에 필요한 천연 지형과 얕은 빈 지반만 변경할 수 있습니다.', edit.position);
    const complete = edit.after === 'air' ? isBuildSiteAir(name) : name === 'dirt' || name === 'grass_block';
    const intermediate = edit.after === 'dirt' && isPreparationVegetation(edit.before) && isBuildSiteAir(name);
    if (name !== edit.before && !(options.allowCompletedEdits && (complete || intermediate))) return fail('변경 전 또는 확인된 완료 상태와 실제 블록이 다릅니다.', edit.position);
    for (const [x, y, z] of neighbors) { const p = shift(edit.position, x, y, z), adjacent = actual.get(key(p))!; if (!isBuildSiteAir(adjacent) && !isPreparationTerrain(adjacent) && !isPreparationVegetation(adjacent)) return fail('시설·작물·액체·중력 블록 옆의 지형은 보존해야 합니다.', p); }
    edits.set(k, edit);
  }
  const final = (p: Position) => edits.get(key(p))?.after ?? actual.get(key(p)) ?? '';
  for (let i = 0; i < plan.path.length; i++) {
    const p = plan.path[i]!;
    if (!isBuildSiteGround(final(shift(p, 0, -1, 0))) || !isBuildSiteAir(final(p)) || !isBuildSiteAir(final(shift(p, 0, 1, 0)))) return fail('실행 후 전체 경로에 실제 발판과 몸·머리 공간이 필요합니다.', p);
    if (plan.path[i + 1] && plan.path[i + 1]!.y > p.y && !isBuildSiteAir(final(shift(p, 0, 2, 0)))) return fail('높은 발판에 오를 때 머리 위 공간이 필요합니다.', shift(p, 0, 2, 0));
    if (plan.edits.some(e => e.after === 'dirt' && e.position.x === p.x && e.position.z === p.z)) for (const y of [-2, -3, -4]) if (!isPreparationTerrain(final(shift(p, 0, y, 0)))) return fail('메우는 경로 아래의 얕은 천연 지지 지반을 확인해야 합니다.', shift(p, 0, y, 0));
  }
  for (const edit of plan.edits) if (edit.after === 'dirt' && !isPreparationTerrain(final(shift(edit.position, 0, -1, 0)))) return fail('채울 블록 아래에 실제 지지 지반이 필요합니다.', edit.position);
  return { ok: true, plan, proofPositions };
}

export function accessPreparationFinalBlocks(plan: BuildAccessPreparation, before: readonly ExpectedBlock[]): ExpectedBlock[] {
  const actual = new Map(before.map(b => [key(b.position), b.name]));
  for (const edit of plan.edits) actual.set(key(edit.position), edit.after);
  return [...new Map(plan.path.flatMap(p => [-1, 0, 1].map(y => shift(p, 0, y, 0))).map(p => [key(p), p])).values()].map(position => ({ position, name: actual.get(key(position)) ?? 'unknown' }));
}
