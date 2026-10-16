import { BuildSitePreparationSchema, buildSiteCells, isBuildSiteAir, isBuildSiteGround, type BuildSiteCell, type BuildSitePreparation, type ExpectedBlock, type Position } from './index';
import { blueprint, resolveBlueprint } from './blueprints';

const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const shift = (p: Position, x: number, y: number, z: number): Position => ({ x: p.x + x, y: p.y + y, z: p.z + z });
const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const terrain = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite']);
const vegetation = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern']);
export function isPreparationTerrain(name: string): boolean { return terrain.has(name); }
export function isPreparationVegetation(name: string): boolean { return vegetation.has(name); }
export function matchesPreparationTarget(edit: BuildSitePreparation['edits'][number], name: string): boolean { return edit.after === 'air' ? isBuildSiteAir(name) : name === 'dirt' || name === 'grass_block'; }
export function preparationSiteCells(plan: BuildSitePreparation): BuildSiteCell[] {
  const size = resolveBlueprint(plan.design, plan.blueprintDefinition);
  const height = Math.max(size.height, ...blueprint(plan.design, { x: 0, y: 0, z: 0 }, size.wood, plan.blueprintDefinition).map(b => b.position.y));
  return buildSiteCells(plan.origin, size.width, size.depth, height);
}
export function preparationProofPositions(plan: BuildSitePreparation): Position[] {
  const cells = preparationSiteCells(plan), result = cells.map(c => c.position);
  for (const cell of cells) if (cell.requirement === 'ground') for (const y of [1, 2, 3]) result.push(shift(cell.position, 0, -y, 0));
  for (const p of plan.path) for (const y of [-4, -3, -2, -1, 0, 1]) result.push(shift(p, 0, y, 0));
  for (const edit of plan.edits) { result.push(edit.position); for (const [x, y, z] of neighbors) result.push(shift(edit.position, x!, y!, z!)); }
  return [...new Map(result.map(p => [key(p), p])).values()];
}
export type PreparationValidation = { ok: true; plan: BuildSitePreparation; cells: BuildSiteCell[]; proofPositions: Position[] } | { ok: false; reason: string; position?: Position };

/** Validate observed before/after terrain without modifying any world or library. */
export function validateBuildSitePreparation(value: unknown, observedBlocks: readonly ExpectedBlock[], options: { near?: Position; allowCompletedEdits?: boolean } = {}): PreparationValidation {
  const parsed = BuildSitePreparationSchema.safeParse(value);
  const fail = (reason: string, position?: Position): PreparationValidation => ({ ok: false, reason, ...(position ? { position } : {}) });
  if (!parsed.success) return fail('부지 정리 계획의 좌표·변경 수량·경로 형식을 확인해야 합니다.');
  const plan = parsed.data;
  let size: ReturnType<typeof resolveBlueprint>;
  try { size = resolveBlueprint(plan.design, plan.blueprintDefinition); } catch { return fail('등록한 설계도의 ID와 고정한 버전을 확인해야 합니다.'); }
  const near = options.near ?? plan.near;
  if (Math.hypot(plan.near.x - near.x, plan.near.y - near.y, plan.near.z - near.z) > 1.5 || Math.hypot(plan.origin.x + (size.width - 1) / 2 - near.x, plan.origin.z + (size.depth - 1) / 2 - near.z) > 32 || Math.abs(plan.origin.y - near.y) > 8) return fail('정리 부지는 관측한 봇 주변의 허용 범위 안에 있어야 합니다.');
  const entrance = { x: plan.origin.x + Math.floor(size.width / 2), y: plan.origin.y, z: plan.origin.z - 1 };
  if (key(entrance) !== key(plan.entrance) || key(plan.path.at(-1)!) !== key(entrance)) return fail('정리 경로는 설계도의 실제 출입 위치까지 이어져야 합니다.');
  const initial = { x: Math.floor(plan.near.x), y: Math.floor(plan.near.y), z: Math.floor(plan.near.z) };
  if (key(initial) !== key(plan.path[0]!)) return fail('정리 경로는 관측한 봇의 실제 발 위치에서 시작해야 합니다.');
  const pathKeys = new Set<string>();
  for (let i = 0; i < plan.path.length; i++) {
    const p = plan.path[i]!;
    if (Math.hypot(p.x - near.x, p.z - near.z) > 32 || Math.abs(p.y - near.y) > 8) return fail('접근로 전체가 관측한 봇 주변의 허용 범위 안에 있어야 합니다.', p);
    if (pathKeys.has(key(p))) return fail('정리 경로는 같은 발 위치를 반복하지 않아야 합니다.', p);
    pathKeys.add(key(p));
    if (i) { const before = plan.path[i - 1]!; if (Math.abs(p.x - before.x) + Math.abs(p.z - before.z) !== 1 || Math.abs(p.y - before.y) > 1) return fail('정리 경로는 한 칸씩 안전하게 연결되어야 합니다.', p); }
  }
  const actual = new Map(observedBlocks.map(b => [key(b.position), b.name]));
  const cells = preparationSiteCells(plan), proofPositions = preparationProofPositions(plan);
  for (const p of proofPositions) if (!actual.has(key(p))) return fail('전체 부지·지지 지반·경로와 변경 주변의 실제 관측이 필요합니다.', p);
  const edits = new Map<string, BuildSitePreparation['edits'][number]>();
  const permitted = new Set(cells.map(c => key(c.position)));
  const cutAllowed = new Set(cells.filter(c => c.requirement === 'air' && c.position.y <= plan.origin.y + 2).map(c => key(c.position)));
  const fillAllowed = new Set<string>();
  for (const c of cells) if (c.requirement === 'ground') for (const y of [0, 1, 2]) fillAllowed.add(key(shift(c.position, 0, -y, 0)));
  for (const c of cells) if (c.requirement === 'ground') for (const y of [1, 2]) permitted.add(key(shift(c.position, 0, -y, 0)));
  for (const p of plan.path) for (const y of [-3, -2, -1, 0, 1]) { const k = key(shift(p, 0, y, 0)); permitted.add(k); (y < 0 ? fillAllowed : cutAllowed).add(k); }
  for (const edit of plan.edits) {
    const k = key(edit.position), p = edit.position;
    if (edits.has(k) || !permitted.has(k)) return fail('변경 좌표는 예약할 부지와 경로 안에 중복 없이 있어야 합니다.', p);
    if (edit.before === edit.after || (edit.after === 'air' ? (!isPreparationTerrain(edit.before) && !isPreparationVegetation(edit.before)) || !cutAllowed.has(k) : (!isBuildSiteAir(edit.before) && !isPreparationVegetation(edit.before)) || !fillAllowed.has(k))) return fail('천연 흙·돌과 자연 풀만 제한된 범위에서 제거하거나 빈 지반을 흙으로 채울 수 있습니다.', p);
    if (k === key(initial) || k === key(shift(initial, 0, -1, 0)) || k === key(shift(initial, 0, 1, 0))) return fail('봇의 현재 발판·몸·머리 공간을 보존해야 합니다.', p);
    const observed = actual.get(k)!;
    const intermediateFill = edit.after === 'dirt' && isPreparationVegetation(edit.before) && isBuildSiteAir(observed);
    if (observed !== edit.before && !(options.allowCompletedEdits && (matchesPreparationTarget(edit, observed) || intermediateFill))) return fail('실제 블록이 검증한 변경 전 또는 완료 후 상태와 다릅니다.', p);
    for (const [x, y, z] of neighbors) {
      const q = shift(p, x!, y!, z!), name = actual.get(key(q))!;
      if (!isBuildSiteAir(name) && !isPreparationTerrain(name) && !isPreparationVegetation(name)) return fail('변경 옆의 기존 시설·작물·액체·중력 블록을 보존해야 합니다.', q);
    }
    edits.set(k, edit);
  }
  const final = (p: Position) => edits.get(key(p))?.after ?? actual.get(key(p));
  for (const cell of cells) if (!(cell.requirement === 'air' ? isBuildSiteAir(final(cell.position)!) : isBuildSiteGround(final(cell.position)!))) return fail('계획 실행 후 전체 건축 공간과 바깥 출입 지반이 안전해야 합니다.', cell.position);
  for (const cell of cells) if (cell.requirement === 'ground') for (const y of [1, 2, 3]) {
    const p = shift(cell.position, 0, -y, 0); if (!isBuildSiteGround(final(p)!)) return fail('빈 동굴이나 액체 위에 지반을 만들 수 없습니다.', p);
  }
  for (const p of plan.path) if (!isBuildSiteGround(final(shift(p, 0, -1, 0))!) || !isBuildSiteAir(final(p)!) || !isBuildSiteAir(final(shift(p, 0, 1, 0))!)) return fail('정리 경로의 발판과 몸·머리 공간을 확인해야 합니다.', p);
  for (const p of plan.path) if (plan.edits.some(e => e.after === 'dirt' && e.position.x === p.x && e.position.z === p.z && e.position.y < p.y)) for (const y of [-2, -3, -4]) { const q = shift(p, 0, y, 0); if (!isBuildSiteGround(final(q)!)) return fail('채우는 접근로 아래에 동굴·액체 없는 지지 지반이 필요합니다.', q); }
  for (const edit of plan.edits) if (edit.after === 'dirt' && !isBuildSiteGround(final(shift(edit.position, 0, -1, 0))!)) return fail('채울 흙 아래에 실제 지지 지반이 필요합니다.', edit.position);
  return { ok: true, plan, cells, proofPositions };
}
