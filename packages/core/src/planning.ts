import { BuildSitePreparationSchema, PreparationVerificationSchema, buildSiteCells, preparationProofPositions, type ActionKind, type CompletionCondition, type ContainerRef, type ExpectedBlock, type Goal, type JsonObject, type Position, type Rules, type TaskSpec } from '../../contracts/src';
import { footprintInside, positionKey } from './verification';
import { BLUEPRINTS, blueprint, resolveBlueprint } from '../../contracts/src/blueprints';

export interface PlanResult { tasks: TaskSpec[]; waiting?: string; }
export function containerKey(container: ContainerRef): string { return `container:${container.world}:${container.dimension}:${positionKey(container.position)}`; }
export function roleFits(role: string, kind: ActionKind): boolean {
  const roleActions: Record<string, readonly ActionKind[]> = {
    guard: ['guard', 'fight'], hunter: ['hunt', 'fight', 'collect'], farmer: ['farm', 'collect'], rancher: ['breed', 'hunt'],
    builder: ['build', 'craft', 'smelt'], gatherer: ['collect', 'explore', 'store', 'take'], general: [],
  };
  return roleActions[role]?.includes(kind) ?? false;
}
export function jsonObject(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
export function goalTitle(goal: Goal['input']): string {
  if (goal.title) return goal.title;
  if (goal.item) return `${goal.item} ${goal.quantity}${goal.mode === 'maintain' ? ' 유지' : ' 확보'} · ${goal.kind}`;
  return goal.kind;
}
function asPosition(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  return ['x', 'y', 'z'].every(k => typeof p[k] === 'number' && Number.isFinite(p[k])) ? { x: p.x as number, y: p.y as number, z: p.z as number } : undefined;
}
function asBlocks(value: unknown): ExpectedBlock[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const result: ExpectedBlock[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return undefined;
    const row = candidate as Record<string, unknown>, position = asPosition(row.position);
    if (!position || typeof row.name !== 'string' || !row.name) return undefined;
    result.push({ position, name: row.name });
  }
  return result;
}
export function planGoal(goal: Goal, rules: Rules, newId: () => string, warehouseCount?: number, nearbyPosition?: Position): PlanResult {
  const input = goal.input, tasks: TaskSpec[] = [];
  const add = (kind: ActionKind, params: JsonObject, completion: CompletionCondition, dependencies: string[] = [], reservationKeys: string[] = []): TaskSpec => {
    const task: TaskSpec = { id: newId(), goalId: goal.id, kind, source: input.source, params, dependencies, completion, reservationKeys };
    tasks.push(task);
    return task;
  };
  const destination = input.destination ?? rules.warehouse ?? undefined;
  if (input.kind === 'collect' || (input.kind === 'hunt' && input.item)) {
    if (!destination) return { tasks, waiting: '공동 창고를 설정해야 합니다.' };
    if (warehouseCount === undefined || goal.targetQuantity === undefined) return { tasks, waiting: '공동 창고의 실제 재고를 관측해야 합니다.' };
    const missing = Math.max(0, goal.targetQuantity - warehouseCount);
    if (!missing) return { tasks };
    const quantity = Math.min(64, missing), item = input.item!;
    const collect = add(input.kind, { ...input.params, item, quantity, targetQuantity: quantity }, { kind: 'inventory', item, minimum: quantity }, [], [`goal:${goal.id}:stock`]);
    add('store', { item, quantity, destination: jsonObject(destination) }, { kind: 'transfer', container: destination, item, quantity, direction: 'store' }, [collect.id], [containerKey(destination)]);
    return { tasks };
  }
  if (input.kind === 'store' || input.kind === 'take') {
    if (!destination) return { tasks, waiting: '운반할 창고를 설정해야 합니다.' };
    if (input.kind === 'store') {
      const acquire = add('collect', { item: input.item!, quantity: input.quantity }, { kind: 'inventory', item: input.item!, minimum: input.quantity });
      add('store', { ...input.params, item: input.item!, quantity: input.quantity, destination: jsonObject(destination) }, { kind: 'transfer', container: destination, item: input.item!, quantity: input.quantity, direction: 'store' }, [acquire.id], [containerKey(destination)]);
    } else add('take', { ...input.params, item: input.item!, quantity: input.quantity, destination: jsonObject(destination) }, { kind: 'transfer', container: destination, item: input.item!, quantity: input.quantity, direction: 'take' }, [], [containerKey(destination)]);
    return { tasks };
  }
  if (input.kind === 'craft' || input.kind === 'smelt') {
    add(input.kind, { ...input.params, item: input.item!, quantity: input.quantity }, { kind: 'inventory', item: input.item!, minimum: input.quantity });
    return { tasks };
  }
  if (input.kind === 'build') {
    if (input.params.mode === 'prepare-site' && input.params.siteSelection !== 'preparing') return { tasks, waiting: '부지 정리는 실제 탐색 관측을 승인한 계획에서만 실행할 수 있습니다.' };
    if (input.params.siteSelection === 'preparing') {
      if (!PreparationVerificationSchema.safeParse(input.params.preparationVerification).success) return { tasks, waiting: '중앙에서 실제 탐색 관측으로 승인한 부지 정리 계획이 필요합니다.' };
      const parsed = BuildSitePreparationSchema.safeParse(input.params.sitePreparation);
      if (!parsed.success) return { tasks, waiting: '검증한 부지 정리 계획이 필요합니다.' };
      const preparation = parsed.data;
      let reserved: Position[];
      try { resolveBlueprint(preparation.design, preparation.blueprintDefinition); reserved = preparationProofPositions(preparation); }
      catch { return { tasks, waiting: '검증한 설계도 버전과 부지 정리 계획이 필요합니다.' }; }
      if (input.source === 'autonomous' && (!rules.center || !footprintInside(rules.center, rules.radius, reserved.map(position => ({ position }))))) return { tasks, waiting: '전체 정리 부지와 접근로가 마을 범위 안에 있어야 합니다.' };
      add('build', { mode: 'prepare-site', design: preparation.design, ...(preparation.blueprintDefinition ? { blueprintDefinition: jsonObject(preparation.blueprintDefinition) } : {}), near: jsonObject(preparation.near), preparation: jsonObject(preparation) }, { kind: 'exploration', resourceNames: [], minVisits: 1 }, [], reserved.map(position => `block:${rules.world}:${rules.dimension}:${positionKey(position)}`));
      return { tasks };
    }
    let blocks = asBlocks(input.params.requiredBlocks);
    const selectedDesign = String(input.params.design ?? input.params.blueprint ?? 'cabin');
    if (!Object.hasOwn(BLUEPRINTS, selectedDesign)) {
      try { resolveBlueprint(selectedDesign, input.params.blueprintDefinition); } catch { return { tasks, waiting: '등록한 설계도와 고정한 버전을 확인해야 합니다.' }; }
      blocks = undefined; // A catalog goal always generates its own immutable placement.
    }
    if (input.params.siteSelection === 'nearby' && !asPosition(input.params.origin) && !asPosition(input.params.position)) {
      const design = String(input.params.design ?? input.params.blueprint ?? 'cabin');
      if (blocks) return { tasks, waiting: '부지 탐색에는 지원하는 건축 설계도가 필요합니다.' };
      if (!nearbyPosition) return { tasks, waiting: '건축과 부지 탐색이 가능한 봇의 실제 위치를 기다립니다.' };
      let size: ReturnType<typeof resolveBlueprint>;
      let height: number;
      try { size = resolveBlueprint(design, input.params.blueprintDefinition); height = Math.max(size.height, ...blueprint(design, { x: 0, y: 0, z: 0 }, typeof input.params.wood === 'string' ? input.params.wood : 'oak', input.params.blueprintDefinition).map(b => b.position.y)); }
      catch { return { tasks, waiting: '지원하는 건축 설계와 재료를 선택해야 합니다.' }; }
      add('explore', { ...input.params, mode: 'build-site', design, allowPreparation: input.params.allowPreparation !== false, near: jsonObject(nearbyPosition), searchRadius: 32, siteWidth: size.width, siteDepth: size.depth, siteHeight: height }, { kind: 'exploration', resourceNames: [], minVisits: 1 }, [], [`build-site:${rules.world}:${rules.dimension}`]);
      return { tasks };
    }
    const origin = asPosition(input.params.origin) ?? asPosition(input.params.position) ?? rules.center ?? undefined;
    if (!blocks && origin) {
      try { blocks = blueprint(String(input.params.design ?? input.params.blueprint ?? 'cabin'), origin, typeof input.params.wood === 'string' ? input.params.wood : 'oak', input.params.blueprintDefinition); }
      catch { return { tasks, waiting: '지원하는 건축 설계를 선택해야 합니다.' }; }
    }
    if (!blocks) return { tasks, waiting: '건축 설계와 전체 블록 배치를 확인해야 합니다.' };
    if (input.source === 'autonomous' && (!rules.center || !footprintInside(rules.center, rules.radius, blocks))) return { tasks, waiting: '자율 건축의 전체 배치가 설정한 마을 범위 안에 있어야 합니다.' };
    let reserved: { position: Position }[] = blocks;
    const design = String(input.params.design ?? input.params.blueprint ?? 'cabin');
    if (origin && input.params.siteSelection === 'fixed' && input.params.siteVerification) {
      let size: ReturnType<typeof resolveBlueprint>;
      try { size = resolveBlueprint(design, input.params.blueprintDefinition); } catch { return { tasks, waiting: '고정한 건축 설계도를 확인해야 합니다.' }; }
      const height = Math.max(size.height, ...blocks.map(b => b.position.y - origin.y));
      if (![origin.x, origin.y, origin.z, height].every(Number.isInteger) || height < 0 || height > 32) return { tasks, waiting: '관측한 부지의 정수 좌표와 건축 범위를 확인해야 합니다.' };
      reserved = buildSiteCells(origin, size.width, size.depth, height);
    }
    add('build', { ...input.params, ...(origin ? { origin: jsonObject(origin) } : {}), requiredBlocks: blocks.map(b => jsonObject(b)) }, { kind: 'blocks', blocks }, [], reserved.map(b => `block:${rules.world}:${rules.dimension}:${positionKey(b.position)}`));
    return { tasks };
  }
  if (input.kind === 'farm') {
    const mode = input.params.mode === 'harvest' ? 'harvest' : 'setup';
    const plots = typeof input.params.plots === 'number' && input.params.plots > 0 ? Math.floor(input.params.plots) : 8;
    const crop = typeof input.params.crop === 'string' ? input.params.crop : 'wheat';
    if (mode === 'harvest' && !destination) return { tasks, waiting: '수확물을 입고할 공동 창고를 설정해야 합니다.' };
    const origin = asPosition(input.params.origin) ?? (rules.center ? { x: Math.floor(rules.center.x), y: Math.floor(rules.center.y) - 1, z: Math.floor(rules.center.z) } : undefined);
    if (!origin) return { tasks, waiting: '밭의 실제 경작 좌표가 필요합니다.' };
    const cells = Array.isArray(input.params.positions) ? input.params.positions.map(asPosition).filter((p): p is Position => !!p) : [-1, 0, 1].flatMap(x => [-1, 0, 1].filter(z => x !== 0 || z !== 0).map(z => ({ x: origin.x + x, y: origin.y, z: origin.z + z }))).slice(0, plots);
    if (cells.length !== plots) return { tasks, waiting: '경작할 전체 밭 배치를 확인해야 합니다.' };
    if (input.source === 'autonomous' && (!rules.center || !footprintInside(rules.center, rules.radius, [origin, ...cells].map(position => ({ position }))))) return { tasks, waiting: '전체 자율 농장 구획이 마을 반경 안에 있어야 합니다.' };
    const reservations = [`farm:${rules.world}:${rules.dimension}:${String(input.params.id ?? 'village')}`, ...[origin, ...cells, ...cells.map(p => ({ ...p, y: p.y + 1 }))].map(p => `block:${rules.world}:${rules.dimension}:${positionKey(p)}`)];
    const farm = add('farm', { ...input.params, crop, quantity: input.quantity, origin: jsonObject(origin), positions: cells.map(jsonObject) }, { kind: 'farm', mode, plots, crop, quantity: input.quantity, baseline: 0 }, [], reservations);
    if (mode === 'harvest') {
      const produce = ({ wheat: 'wheat', carrot: 'carrot', carrots: 'carrot', potato: 'potato', potatoes: 'potato', beetroot: 'beetroot', beetroots: 'beetroot' } as Record<string, string>)[crop];
      if (!produce) return { tasks: [], waiting: '지원하는 수확 작물을 선택해야 합니다.' };
      add('store', { item: produce, quantity: input.quantity, destination: jsonObject(destination!) }, { kind: 'transfer', container: destination!, item: produce, quantity: input.quantity, direction: 'store' }, [farm.id], [containerKey(destination!)]);
    }
    return { tasks };
  }
  if (input.kind === 'fight' || input.kind === 'hunt') {
    add(input.kind, { ...input.params, quantity: input.quantity }, { kind: 'entity-death', minimum: input.quantity, targetName: typeof input.params.targetName === 'string' ? input.params.targetName : undefined, ...(typeof input.params.targetEntityId === 'string' ? { targetId: input.params.targetEntityId } : {}) }, [], typeof input.params.supportRequestId === 'string' ? [`support:${rules.world}:${rules.dimension}:${String(input.params.targetEntityId)}`] : []);
    return { tasks };
  }
  if (input.kind === 'home' || input.kind === 'guard') {
    const position = asPosition(input.params.position) ?? (input.kind === 'guard' ? rules.center ?? undefined : undefined);
    if (!position) return { tasks, waiting: '실제로 이동할 좌표가 필요합니다.' };
    add(input.kind, { ...input.params, position: jsonObject(position) }, { kind: 'position', position, radius: typeof input.params.radius === 'number' ? input.params.radius : 2 });
    return { tasks };
  }
  if (input.kind === 'explore') {
    const resourceNames = Array.isArray(input.params.resourceNames) ? input.params.resourceNames.filter((v): v is string => typeof v === 'string') : [];
    add('explore', input.params, { kind: 'exploration', resourceNames, minVisits: 1 });
    return { tasks };
  }
  if (input.kind === 'breed') {
    const pen = asPosition(input.params.position) ?? rules.center;
    add('breed', input.params, { kind: 'breeding', minimum: input.quantity, animal: typeof input.params.animal === 'string' ? input.params.animal : undefined }, [], [`livestock:${rules.world}:${rules.dimension}:${String(input.params.animal ?? 'cow')}:${pen ? positionKey(pen) : 'village'}`]);
    return { tasks };
  }
  if (input.kind === 'sleep') { add('sleep', input.params, { kind: 'sleep' }); return { tasks }; }
  if (input.kind === 'follow' || input.kind === 'survive') { add(input.kind, input.params, { kind: 'continuous', action: input.kind }); return { tasks }; }
  return { tasks, waiting: '회수할 물자의 실제 목록과 위치를 확인해야 합니다.' };
}
