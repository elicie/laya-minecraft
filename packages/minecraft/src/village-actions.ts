import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { ExpectedBlockSchema, itemCount, type ExpectedBlock, type JsonObject, type Position, type ResultPayload, type TaskSpec } from '../../contracts/src';
import { ActionFailure, ConditionWait, inVillage, type ActionServices } from './services';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const CROPS = {
  wheat: { seed: 'wheat_seeds', produce: 'wheat', age: 7 },
  carrots: { seed: 'carrot', produce: 'carrot', age: 7 },
  potatoes: { seed: 'potato', produce: 'potato', age: 7 },
  beetroots: { seed: 'beetroot_seeds', produce: 'beetroot', age: 3 },
} as const;
const FEED: Record<string, string[]> = { cow: ['wheat'], sheep: ['wheat'], pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds'] };
type Entity = Bot['entity'];

function position(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  return ['x', 'y', 'z'].every(key => typeof p[key] === 'number' && Number.isInteger(p[key])) ? { x: p.x as number, y: p.y as number, z: p.z as number } : undefined;
}
function at(s: ActionServices, p: Position) { return s.bot.blockAt(new Vec3(p.x, p.y, p.z)); }
function offset(p: Position, x: number, y: number, z: number): Position { return { x: p.x + x, y: p.y + y, z: p.z + z }; }
function key(p: Position): string { return `${p.x},${p.y},${p.z}`; }
function count(s: ActionServices, name: string): number { return itemCount(s.bot.inventory.items(), name); }
function recordInventory(s: ActionServices): void { s.observations.push(s.observeInventory()); }
function facts(s: ActionServices, task: TaskSpec, blocks: ExpectedBlock[]): void {
  s.observations.push({ id: randomUUID(), kind: 'blocks', observedAt: Date.now(), world: s.rules.world, dimension: s.rules.dimension, data: { blocks } });
  const expected = task.completion.kind === 'blocks' ? task.completion.blocks : [];
  const expectedNames = new Map(expected.map(block => [key(block.position), block.name]));
  const matching = blocks.filter(block => expectedNames.get(key(block.position)) === block.name).length;
  s.progress(task.kind, expected.length ? `실제 블록 ${blocks.length}개 관측 · 설계와 일치 ${matching}/${expected.length}` : `실제 블록 ${blocks.length}개를 확인했습니다.`);
}
function result(s: ActionServices, outcome: ResultPayload['outcome'], reason?: string): ResultPayload {
  return { outcome, observations: s.observations, evidence: s.evidence, checkpoint: s.checkpoint, reason };
}
function requireBounds(s: ActionServices, positions: Position[]): void {
  if (!s.rules.center) throw new ConditionWait('마을 중심과 반경을 설정해야 합니다.', s.checkpoint);
  if (positions.some(p => !inVillage(p, s.rules))) throw new ConditionWait('전체 작업 구역이 설정한 마을 반경 안에 있어야 합니다.', s.checkpoint);
}
function observedBlocks(s: ActionServices, blocks: ExpectedBlock[]): ExpectedBlock[] {
  return blocks.flatMap(expected => {
    const block = at(s, expected.position);
    return block ? [{ position: expected.position, name: block.name }] : [];
  });
}

interface BuildAccess { id: string; columns: ExpectedBlock[][]; stands: Position[]; exit: Position; }
function constructionAccess(s: ActionServices, blocks: ExpectedBlock[]): BuildAccess | undefined {
  const low = Math.min(...blocks.map(block => block.position.y)), high = Math.max(...blocks.map(block => block.position.y));
  const height = high - low;
  // A short perimeter stair keeps house builders mobile without extra blocks or large falls.
  if (height < 3 || height > 4) return;
  const minX = Math.min(...blocks.map(block => block.position.x)), maxX = Math.max(...blocks.map(block => block.position.x));
  const minZ = Math.min(...blocks.map(block => block.position.z)), maxZ = Math.max(...blocks.map(block => block.position.z));
  const byPosition = new Map(blocks.map(block => [key(block.position), block]));
  const plans: BuildAccess[] = [];
  for (const [x, outsideX] of [[minX, minX - 1], [maxX, maxX + 1]]) for (const [startZ, direction] of [[minZ, 1], [maxZ, -1]]) {
    const stands = Array.from({ length: height }, (_, i) => ({ x, y: high - i, z: startZ + direction * i }));
    if (stands.some(stand => stand.z < minZ || stand.z > maxZ)) continue;
    const supports = stands.map(stand => byPosition.get(key(offset(stand, 0, -1, 0))));
    if (supports.some(block => !block || !(block.name.endsWith('_planks') || ['cobblestone', 'stone', 'stone_bricks', 'bricks'].includes(block.name)))) continue;
    const columns = stands.map(stand => blocks.filter(block => block.position.x === stand.x && block.position.z === stand.z && block.position.y >= stand.y).sort((a, b) => b.position.y - a.position.y));
    if (columns.some(column => !column.length || column.some(block => block.name.endsWith('_door') || block.name.endsWith('_bed') || ['chest', 'furnace', 'crafting_table', 'ladder', 'wall_torch'].includes(block.name)))) continue;
    plans.push({ id: `${x},${startZ},${direction}`, columns, stands, exit: { x: outsideX, y: low, z: stands.at(-1)!.z } });
  }
  const saved = typeof s.checkpoint.buildAccess === 'string' ? s.checkpoint.buildAccess : undefined;
  const selected = plans.find(plan => (!saved || saved === plan.id) && at(s, offset(plan.exit, 0, -1, 0))?.boundingBox === 'block' && at(s, plan.exit)?.boundingBox === 'empty' && at(s, offset(plan.exit, 0, 1, 0))?.boundingBox === 'empty');
  if (saved && !selected) throw new ConditionWait('보존한 건축 접근로의 출구를 다시 확인해야 합니다.', s.checkpoint);
  if (selected) s.checkpoint.buildAccess = selected.id;
  return selected;
}

async function build(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
  const raw = task.completion.kind === 'blocks' ? task.completion.blocks : task.params.requiredBlocks;
  if (!Array.isArray(raw) || !raw.length || raw.length > 10000) throw new ConditionWait('실제 건축 블록 배치가 필요합니다.');
  const blocks = raw.map(value => ExpectedBlockSchema.parse(value));
  if (blocks.some(b => !position(b.position))) throw new ConditionWait('건축 좌표는 정수 블록 좌표여야 합니다.');
  if (new Set(blocks.map(b => key(b.position))).size !== blocks.length) throw new ConditionWait('건축 배치에 중복 좌표가 있습니다.');
  if ((task as TaskSpec & { source?: string }).source !== 'user') requireBounds(s, blocks.map(b => b.position));
  if (blocks.some(block => !at(s, block.position))) await s.near(blocks[0]!.position, 4);
  // Inspect the entire footprint before making a change, including generated bed/door parts.
  for (const expected of blocks) {
    const existing = at(s, expected.position);
    if (!existing) throw new ConditionWait('전체 건축 구역을 관측해야 합니다.', s.checkpoint);
    if (existing.name !== expected.name && !AIR.has(existing.name)) throw new ConditionWait(`기존 ${existing.name} 블록을 보존합니다. 부지를 변경해 주세요.`, s.checkpoint);
  }
  if (blocks.every(block => at(s, block.position)?.name === block.name)) {
    facts(s, task, observedBlocks(s, blocks)); recordInventory(s);
    return result(s, 'completed', '전체 설계도와 실제 블록 배치가 일치합니다.');
  }
  const access = constructionAccess(s, blocks);
  const postponed = new Set(access?.columns.flat().map(block => key(block.position)) ?? []);
  const fixture = (name: string) => name.endsWith('_door') || name.endsWith('_bed') || ['chest', 'crafting_table', 'furnace', 'wall_torch', 'ladder'].includes(name);
  // Beds need a free approach on their foot side before nearby utilities occupy it.
  const placementOrder = (name: string) => name.endsWith('_bed') ? 1 : fixture(name) ? 2 : 0;
  const ordered = blocks.filter(block => !postponed.has(key(block.position))).sort((a, b) => placementOrder(a.name) - placementOrder(b.name) || a.position.y - b.position.y || a.position.x - b.position.x || a.position.z - b.position.z);
  const generated = new Set<string>();
  for (const expected of ordered) {
    s.check();
    const existing = at(s, expected.position);
    if (!existing) throw new ConditionWait('건축 구역의 관측이 끊겼습니다.', s.checkpoint);
    if (existing.name === expected.name) continue;
    if (!AIR.has(existing.name)) throw new ConditionWait('설치 직전에 부지 상태가 바뀌었습니다. 기존 블록을 보존합니다.', s.checkpoint);
    if (generated.has(key(expected.position))) throw new ConditionWait('문이나 침대의 자동 생성 부분을 다시 확인해야 합니다.', s.checkpoint);
    const below = offset(expected.position, 0, -1, 0);
    if (expected.name.endsWith('_door') && blocks.some(b => key(b.position) === key(below) && b.name === expected.name)) {
      throw new ConditionWait('문 상단이 실제로 생성되지 않았습니다.', s.checkpoint);
    }
    const item = expected.name === 'wall_torch' ? 'torch' : expected.name;
    let face: Position | undefined;
    if (expected.name.endsWith('_door')) generated.add(key(offset(expected.position, 0, 1, 0)));
    if (expected.name.endsWith('_bed')) {
      const head = offset(expected.position, 1, 0, 0);
      if (!blocks.some(b => key(b.position) === key(head) && b.name === expected.name)) throw new ConditionWait('침대의 발판과 머리 배치가 필요합니다.', s.checkpoint);
      generated.add(key(head));
      const stand = [0, 1].map(height => offset(expected.position, -1, height, 0)).find(p =>
        at(s, offset(p, 0, -1, 0))?.boundingBox === 'block' && at(s, p)?.boundingBox === 'empty' && at(s, offset(p, 0, 1, 0))?.boundingBox === 'empty');
      if (!stand) throw new ConditionWait('침대의 발판 서쪽에 접근 가능한 빈 위치가 필요합니다.', s.checkpoint);
      await s.near(stand, 0);
      await s.bot.look(-Math.PI / 2, 0, true);
    }
    if (expected.name === 'wall_torch' || expected.name === 'ladder') {
      const faces: Position[] = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }];
      face = faces.find(direction => {
        const reference = at(s, offset(expected.position, -direction.x, 0, -direction.z));
        return reference && reference.boundingBox === 'block';
      });
      if (!face) throw new ConditionWait('사다리나 횃불을 붙일 지지 블록이 필요합니다.', s.checkpoint);
    } else {
      const faces: Position[] = expected.name.endsWith('_door') || expected.name.endsWith('_bed') ? [{ x: 0, y: 1, z: 0 }] :
        [{ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 0, y: -1, z: 0 }];
      face = faces.find(direction => at(s, offset(expected.position, -direction.x, -direction.y, -direction.z))?.boundingBox === 'block');
      if (!face) throw new ConditionWait('블록을 붙일 실제 지지 면이 필요합니다.', s.checkpoint);
    }
    await s.ensureItem(item, 1);
    await s.place(expected.position, item, expected.name, face);
    s.checkpoint.build = { checked: key(expected.position), placed: Number((s.checkpoint.build as JsonObject | undefined)?.placed ?? 0) + 1 };
    s.check();
    if (at(s, expected.position)?.name !== expected.name) throw new ConditionWait('설치 결과를 실제 월드에서 확인해야 합니다.', s.checkpoint);
    s.progress('build', `${expected.name} 설치를 확인했습니다.`);
  }
  if (access) for (let i = 0; i < access.columns.length; i++) {
    const pending = access.columns[i]!.filter(block => at(s, block.position)?.name !== block.name);
    if (!pending.length) continue;
    const stand = access.stands[i + 1] ?? access.exit;
    const support = at(s, offset(stand, 0, -1, 0));
    if (!support || !(support.name.endsWith('_planks') || ['cobblestone', 'stone', 'stone_bricks', 'bricks', 'dirt', 'grass_block'].includes(support.name)) ||
      at(s, stand)?.boundingBox !== 'empty' || at(s, offset(stand, 0, 1, 0))?.boundingBox !== 'empty')
      throw new ConditionWait('내려올 발판과 몸이 들어갈 빈 공간을 실제 관측으로 확인해야 합니다.', s.checkpoint);
    await s.near(offset(stand, 0.5, 0, 0.5), 0);
    const feet = s.bot.entity.position;
    if (Math.floor(feet.x) !== stand.x || Math.floor(feet.z) !== stand.z || Math.abs(feet.y - stand.y) > 0.1)
      throw new ConditionWait('다음 발판에 실제로 도착한 뒤 건축 접근로를 닫아야 합니다.', s.checkpoint);
    // Fill each column from the top while standing on the next lower step.
    for (const expected of pending) {
      s.check();
      const current = at(s, expected.position);
      if (!current || !AIR.has(current.name)) throw new ConditionWait('건축 접근로를 닫기 전에 실제 빈 부지를 확인해야 합니다.', s.checkpoint);
      await s.ensureItem(expected.name, 1);
      await s.place(expected.position, expected.name, expected.name);
      s.checkpoint.build = { checked: key(expected.position), placed: Number((s.checkpoint.build as JsonObject | undefined)?.placed ?? 0) + 1 };
      if (at(s, expected.position)?.name !== expected.name) throw new ConditionWait('접근로 설치 결과를 확인해야 합니다.', s.checkpoint);
      s.progress('build', '안전하게 내려오며 건축 접근로를 완성합니다.');
    }
  }
  const actual = observedBlocks(s, blocks);
  facts(s, task, actual);
  recordInventory(s);
  return result(s, actual.length === blocks.length && actual.every((b, i) => b.name === blocks[i]!.name) ? 'completed' : 'partial', '설계도의 전체 블록 배치를 실제로 확인했습니다.');
}

async function water(s: ActionServices, center: Position): Promise<void> {
  let block = at(s, center);
  if (!block) throw new ConditionWait('밭의 급수 위치를 관측해야 합니다.', s.checkpoint);
  if (block.name === 'water') return;
  if (!AIR.has(block.name) && !['dirt', 'grass_block'].includes(block.name)) throw new ConditionWait('급수 위치에 기존 시설이 있습니다. 위치를 변경해 주세요.', s.checkpoint);
  await s.ensureItem('water_bucket', 1);
  const bucket = s.bot.inventory.items().find(item => item.name === 'water_bucket');
  if (!bucket) throw new ConditionWait('급수할 물 양동이가 필요합니다.', s.checkpoint);
  await s.near(center, 3);
  if (!AIR.has(block.name)) { s.check(); await s.bot.dig(block); }
  const reference = at(s, offset(center, 0, -1, 0));
  if (!reference || reference.boundingBox !== 'block') throw new ConditionWait('물을 담을 바닥 블록이 필요합니다.', s.checkpoint);
  // Bucket use raycasts along the player's view. Stand in the empty irrigation
  // hole so surrounding soil cannot intercept that ray.
  await s.near(center, 0);
  await s.bot.equip(bucket, 'hand');
  await s.bot.lookAt(new Vec3(center.x + 0.5, center.y, center.z + 0.5), true);
  await s.pause(100);
  s.check();
  s.bot.activateItem();
  await s.pause(700);
  block = at(s, center);
  if (block?.name !== 'water') throw new ConditionWait('급수 결과를 확인해야 합니다.', s.checkpoint);
}
async function farm(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
  const completion = task.completion.kind === 'farm' ? task.completion : undefined;
  const cropName = String(task.params.crop ?? completion?.crop ?? 'wheat');
  const normalized = cropName === 'carrot' ? 'carrots' : cropName === 'potato' ? 'potatoes' : cropName === 'beetroot' ? 'beetroots' : cropName;
  if (!(normalized in CROPS)) throw new ConditionWait('지원하는 작물은 밀·당근·감자·비트입니다.');
  const crop = CROPS[normalized as keyof typeof CROPS];
  const requested = completion?.plots ?? Number(task.params.plots ?? 8);
  if (!Number.isInteger(requested) || requested < 1 || requested > 8) throw new ConditionWait('첫 밭 구획은 1~8개 경작지로 설정해 주세요.');
  const center = position(task.params.origin) ?? (s.rules.center ? { x: Math.floor(s.rules.center.x), y: Math.floor(s.rules.center.y) - 1, z: Math.floor(s.rules.center.z) } : undefined);
  if (!center) throw new ConditionWait('밭의 중심 좌표가 필요합니다.');
  const explicit = Array.isArray(task.params.positions) ? task.params.positions.map(position) : undefined;
  if (explicit?.some(p => !p)) throw new ConditionWait('경작지 좌표를 확인해 주세요.');
  const ring = [-1, 0, 1].flatMap(x => [-1, 0, 1].filter(z => x !== 0 || z !== 0).map(z => offset(center, x, 0, z)));
  const plots = (explicit as Position[] | undefined) ?? ring.slice(0, requested);
  if (plots.length !== requested || new Set(plots.map(key)).size !== plots.length || plots.some(p => p.y !== center.y || Math.max(Math.abs(p.x - center.x), Math.abs(p.z - center.z)) > 4 || key(p) === key(center))) throw new ConditionWait('경작지는 물과 같은 높이에서 4블록 안에 있어야 합니다.');
  if ((task as TaskSpec & { source?: string }).source !== 'user') requireBounds(s, [center, ...plots]);
  await s.near(center, 4);
  for (const p of plots) {
    const soil = at(s, p), plant = at(s, offset(p, 0, 1, 0));
    if (!soil || !plant) throw new ConditionWait('전체 경작지를 관측해야 합니다.', s.checkpoint);
    if (!['dirt', 'grass_block', 'farmland'].includes(soil.name) || (!AIR.has(plant.name) && plant.name !== normalized)) throw new ConditionWait('경작지에 기존 시설이나 다른 작물이 있습니다. 위치를 변경해 주세요.', s.checkpoint);
  }
  await water(s, center);
  const harvesting = task.params.mode === 'harvest' || completion?.mode === 'harvest';
  if (harvesting) s.checkpoint.harvestStart ??= 0;
  let harvested = Number((s.checkpoint.farm as JsonObject | undefined)?.harvested ?? 0);
  const needHoe = plots.some(p => at(s, p)?.name !== 'farmland');
  if (needHoe && !s.bot.inventory.items().some(item => item.name.endsWith('_hoe'))) await s.ensureItem('wooden_hoe', 1);
  let planted = 0;
  for (const p of plots) {
    s.check();
    const target = offset(p, 0, 1, 0);
    // Work from the edge rather than jumping or walking across planted farmland.
    const stands = [1, 0].flatMap(height => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => offset(p, x, height, z)))
      .filter(stand => !plots.some(soil => soil.x === stand.x && soil.z === stand.z) && (stand.x !== center.x || stand.z !== center.z) &&
        at(s, offset(stand, 0, -1, 0))?.boundingBox === 'block' && at(s, stand)?.boundingBox === 'empty' && at(s, offset(stand, 0, 1, 0))?.boundingBox === 'empty');
    const stand = stands.sort((a, b) => Math.hypot(a.x - s.bot.entity.position.x, a.y - s.bot.entity.position.y, a.z - s.bot.entity.position.z) - Math.hypot(b.x - s.bot.entity.position.x, b.y - s.bot.entity.position.y, b.z - s.bot.entity.position.z))[0];
    if (!stand) throw new ConditionWait('작물을 밟지 않고 작업할 바깥쪽 접근 위치가 필요합니다.', s.checkpoint);
    await s.near(stand, 0);
    let soil = at(s, p), plant = at(s, target);
    if (!soil || !plant) throw new ConditionWait('경작지 관측이 끊겼습니다.', s.checkpoint);
    if (soil.name !== 'farmland') {
      if (!['dirt', 'grass_block'].includes(soil.name)) throw new ConditionWait('경작지 상태가 바뀌었습니다.', s.checkpoint);
      const hoe = s.bot.inventory.items().find(item => item.name.endsWith('_hoe'));
      if (!hoe) throw new ConditionWait('경작할 괭이가 필요합니다.', s.checkpoint);
      await s.bot.equip(hoe, 'hand');
      await s.bot.activateBlock(soil, new Vec3(0, 1, 0));
      await s.pause(200);
      soil = at(s, p);
      if (soil?.name !== 'farmland') throw new ConditionWait('실제 경작 결과를 확인해야 합니다.', s.checkpoint);
    }
    if (harvesting && plant.name === normalized && Number(plant.getProperties().age ?? 0) >= crop.age) {
      const before = count(s, crop.produce);
      s.check(); await s.bot.dig(plant);
      await s.near(target, 1);
      await s.pause(600);
      harvested += Math.max(0, count(s, crop.produce) - before);
      s.checkpoint.farm = { harvested, crop: cropName };
      plant = at(s, target);
      if (!plant) throw new ConditionWait('수확 이후 경작지를 관측해야 합니다.', s.checkpoint);
    }
    if (AIR.has(plant.name)) {
      await s.ensureItem(crop.seed, 1);
      await s.place(target, crop.seed, normalized);
    } else if (plant.name !== normalized) throw new ConditionWait('경작지에 다른 블록이 생겼습니다.', s.checkpoint);
    if (at(s, target)?.name === normalized) planted += 1;
    s.progress('farm', `경작지 ${planted}/${plots.length} 확인 · 실제 수확 ${harvested}개`);
  }
  const watered = at(s, center)?.name === 'water' ? plots.filter(p => at(s, p)?.name === 'farmland').length : 0;
  const ripe = plots.filter(p => { const block = at(s, offset(p, 0, 1, 0)); return block?.name === normalized && Number(block.getProperties().age ?? 0) >= crop.age; }).length;
  s.observations.push({ id: randomUUID(), kind: 'farm', observedAt: Date.now(), world: s.rules.world, dimension: s.rules.dimension, data: { id: String(task.params.id ?? 'village'), crop: cropName, plots: plots.length, planted, watered, ripe, harvested } });
  recordInventory(s);
  const targetQuantity = completion?.quantity ?? Number(task.params.quantity ?? 1);
  const complete = harvesting ? harvested - (completion?.baseline ?? Number(s.checkpoint.harvestStart ?? 0)) >= targetQuantity : planted === requested && watered === requested;
  return result(s, complete ? 'completed' : 'condition-wait', complete ? '실제 경작·급수·작물 상태와 수확량을 확인했습니다.' : '작물이 자라거나 수확한 물자가 확보되기를 기다립니다.');
}

function baby(s: ActionServices, entity: Entity): boolean | undefined {
  const registered = s.bot.registry.entitiesByName[entity.name ?? ''] as unknown as { metadataKeys?: string[] } | undefined;
  const index = registered?.metadataKeys?.indexOf('baby') ?? -1;
  const value = index >= 0 ? (entity.metadata as unknown as Record<number, unknown>)[index] : undefined;
  // Vanilla sends only metadata values that differ from their defaults. For
  // registered ageable animals the omitted baby flag defaults to false.
  if (index >= 0 && value === undefined) return false;
  return typeof value === 'boolean' ? value : undefined;
}
function entityKey(entity: Entity): string { return String(entity.uuid ?? entity.id); }
async function breed(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
  if (!s.rules.center) throw new ConditionWait('보호할 가축이 있는 마을 구역을 설정해 주세요.');
  const animal = typeof task.params.animal === 'string' ? task.params.animal : 'cow';
  if (!(animal in FEED)) throw new ConditionWait('번식 가능한 가축은 소·양·돼지·닭입니다.');
  const pen = position(task.params.position) ?? s.rules.center;
  requireBounds(s, [pen]);
  const animals = () => Object.values(s.bot.entities).filter(entity => entity.name === animal && !entity.username && inVillage(entity.position, s.rules) && entity.position.distanceTo(new Vec3(pen.x, pen.y, pen.z)) <= 16);
  const limit = Number(task.params.limit ?? 24);
  const checkpoint = (s.checkpoint.breeding ?? { animal, birthIds: [], cooldowns: {} }) as JsonObject;
  s.checkpoint.breeding = checkpoint;
  const birthIds = Array.isArray(checkpoint.birthIds) ? checkpoint.birthIds.map(String) : [];
  checkpoint.birthIds = birthIds;
  const minimum = task.completion.kind === 'breeding' ? task.completion.minimum : Number(task.params.quantity ?? 1);
  const observeBirth = (newborn: Entity) => {
    s.observations.push({ id: randomUUID(), kind: 'breeding', observedAt: Date.now(), world: s.rules.world, dimension: s.rules.dimension, data: { animal, entityId: entityKey(newborn), position: { x: newborn.position.x, y: newborn.position.y, z: newborn.position.z } } });
  };
  for (const known of animals()) if (birthIds.includes(entityKey(known)) && baby(s, known) === true) observeBirth(known);
  if (birthIds.length >= minimum) return result(s, 'completed', '목표 수만큼 실제 새끼 생성을 확인했습니다.');
  const cooldowns = (checkpoint.cooldowns ?? {}) as JsonObject;
  checkpoint.cooldowns = cooldowns;
  const available = animals();
  if (!Number.isInteger(limit) || limit < 2 || available.length >= limit) throw new ConditionWait('가축 수가 설정한 한도에 도달했습니다.', s.checkpoint);
  const adults = available.filter(entity => baby(s, entity) === false && Number(cooldowns[entityKey(entity)] ?? 0) <= Date.now());
  const existingParents = Array.isArray(checkpoint.parentIds) ? checkpoint.parentIds.map(String) : [];
  const first = existingParents.length ? available.find(entity => entityKey(entity) === existingParents[0]) : adults[0];
  const second = existingParents.length ? available.find(entity => entityKey(entity) === existingParents[1]) : first && adults.slice(1).find(entity => entity.position.distanceTo(first.position) < 8);
  if (!first || !second) throw new ConditionWait('상태가 확인된 성체 두 마리가 같은 우리에 있어야 합니다.', s.checkpoint);
  const feed = typeof checkpoint.feed === 'string' ? checkpoint.feed : FEED[animal]!.find(item => count(s, item) >= 2) ?? FEED[animal]![0]!;
  checkpoint.feed = feed;
  if (!Array.isArray(checkpoint.priorBabyIds)) {
    checkpoint.priorBabyIds = available.filter(entity => baby(s, entity) === true).map(entityKey);
    checkpoint.parentIds = [entityKey(first), entityKey(second)];
    checkpoint.fedIds = [];
  }
  const fedIds = checkpoint.fedIds as string[];
  // A safe stop may occur after activation but before the inventory update was checked.
  if (typeof checkpoint.pendingFeedId === 'string' && count(s, feed) < Number(checkpoint.beforeFeed)) {
    if (!fedIds.includes(checkpoint.pendingFeedId)) fedIds.push(checkpoint.pendingFeedId);
    delete checkpoint.pendingFeedId;
    delete checkpoint.beforeFeed;
  }
  if (fedIds.length < 2) await s.ensureItem(feed, 2 - fedIds.length);
  for (const adult of [first, second]) {
    if (fedIds.includes(entityKey(adult))) continue;
    s.check();
    if (!s.bot.entities[adult.id] || baby(s, adult) !== false) throw new ConditionWait('번식 대상의 상태가 바뀌었습니다.', s.checkpoint);
    await s.near(adult.position, 2);
    const item = s.bot.inventory.items().find(item => item.name === feed);
    if (!item) throw new ConditionWait('가축 먹이가 부족합니다.', s.checkpoint);
    await s.bot.equip(item, 'hand');
    const before = count(s, feed);
    checkpoint.pendingFeedId = entityKey(adult);
    checkpoint.beforeFeed = before;
    await s.bot.activateEntity(adult);
    for (let i = 0; i < 15 && count(s, feed) >= before; i += 1) await s.pause(100);
    if (count(s, feed) >= before) throw new ConditionWait('서버의 먹이 소비를 확인하지 못했습니다.', s.checkpoint);
    fedIds.push(entityKey(adult));
    delete checkpoint.pendingFeedId;
    delete checkpoint.beforeFeed;
  }
  recordInventory(s);
  const beforeIds = checkpoint.priorBabyIds as string[];
  for (let i = 0; i < 30; i += 1) {
    s.check();
    const newborn = animals().find(entity => baby(s, entity) === true && !beforeIds.includes(entityKey(entity)) && !birthIds.includes(entityKey(entity)));
    if (newborn) {
      observeBirth(newborn);
      birthIds.push(entityKey(newborn));
      for (const parent of [first, second]) cooldowns[entityKey(parent)] = Date.now() + 300_000;
      delete checkpoint.priorBabyIds; delete checkpoint.parentIds; delete checkpoint.fedIds; delete checkpoint.feed;
      return result(s, birthIds.length >= minimum ? 'completed' : 'partial', `먹이 소비와 새끼 ${birthIds.length}/${minimum}마리의 실제 생성을 확인했습니다.`);
    }
    await s.pause(100);
  }
  return result(s, 'condition-wait', '먹이 소비는 확인했으며 새끼 생성 확인을 기다립니다.');
}

export async function executeVillageTask(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
  try {
    s.check();
    if (task.kind === 'build') return await build(task, s);
    if (task.kind === 'farm') return await farm(task, s);
    if (task.kind === 'breed') return await breed(task, s);
    throw new ActionFailure('마을 작업 실행기가 지원하지 않는 작업입니다.', 'UNSUPPORTED_ACTION', false, true);
  } catch (error) {
    if (error instanceof ConditionWait) {
      Object.assign(s.checkpoint, error.checkpoint);
      recordInventory(s);
      if (task.completion.kind === 'blocks') facts(s, task, observedBlocks(s, task.completion.blocks));
      if (task.completion.kind === 'blocks') {
        const missing = task.completion.blocks.filter(block => at(s, block.position)?.name !== block.name);
        s.checkpoint.buildRemaining = { count: missing.length, cells: missing.slice(0, 12).map(block => ({ position: block.position, expected: block.name, actual: at(s, block.position)?.name ?? 'unloaded' })) };
      }
      return result(s, 'condition-wait', error.message);
    }
    throw error;
  }
}
