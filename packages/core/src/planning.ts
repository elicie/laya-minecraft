import { type ActionKind, type CompletionCondition, type ContainerRef, type ExpectedBlock, type Goal, type JsonObject, type Position, type Rules, type TaskSpec } from '../../contracts/src';
import { footprintInside, positionKey } from './verification';
import { blueprint } from '../../contracts/src/blueprints';

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
export function planGoal(goal: Goal, rules: Rules, newId: () => string, warehouseCount?: number): PlanResult {
  const input = goal.input, tasks: TaskSpec[] = [];
  const add = (kind: ActionKind, params: JsonObject, completion: CompletionCondition, dependencies: string[] = [], reservationKeys: string[] = []): TaskSpec => {
    const task: TaskSpec = { id: newId(), goalId: goal.id, kind, params, dependencies, completion, reservationKeys };
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
    let blocks = asBlocks(input.params.requiredBlocks);
    const origin = asPosition(input.params.origin) ?? asPosition(input.params.position) ?? rules.center ?? undefined;
    if (!blocks && origin) {
      try { blocks = blueprint(String(input.params.design ?? input.params.blueprint ?? 'cabin'), origin, typeof input.params.wood === 'string' ? input.params.wood : 'oak'); }
      catch { return { tasks, waiting: '지원하는 건축 설계를 선택해야 합니다.' }; }
    }
    if (!blocks) return { tasks, waiting: '건축 설계와 전체 블록 배치를 확인해야 합니다.' };
    if (input.source === 'autonomous' && (!rules.center || !footprintInside(rules.center, rules.radius, blocks))) return { tasks, waiting: '자율 건축의 전체 배치가 설정한 마을 범위 안에 있어야 합니다.' };
    add('build', { ...input.params, ...(origin ? { origin: jsonObject(origin) } : {}), requiredBlocks: blocks.map(b => jsonObject(b)) }, { kind: 'blocks', blocks }, [], blocks.map(b => `block:${rules.world}:${rules.dimension}:${positionKey(b.position)}`));
    return { tasks };
  }
  if (input.kind === 'farm') {
    const mode = input.params.mode === 'harvest' ? 'harvest' : 'setup';
    const plots = typeof input.params.plots === 'number' && input.params.plots > 0 ? Math.floor(input.params.plots) : 8;
    add('farm', input.params, { kind: 'farm', mode, plots, crop: typeof input.params.crop === 'string' ? input.params.crop : 'wheat', quantity: input.quantity, baseline: typeof input.params.baseline === 'number' ? input.params.baseline : 0 }, [], [`farm:${rules.world}:${rules.dimension}:${String(input.params.id ?? 'village')}`]);
    return { tasks };
  }
  if (input.kind === 'fight' || input.kind === 'hunt') {
    add(input.kind, { ...input.params, quantity: input.quantity }, { kind: 'entity-death', minimum: input.quantity, targetName: typeof input.params.targetName === 'string' ? input.params.targetName : undefined });
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
    add('breed', input.params, { kind: 'breeding', minimum: input.quantity, animal: typeof input.params.animal === 'string' ? input.params.animal : undefined });
    return { tasks };
  }
  if (input.kind === 'sleep') { add('sleep', input.params, { kind: 'sleep' }); return { tasks }; }
  if (input.kind === 'follow' || input.kind === 'survive') { add(input.kind, input.params, { kind: 'continuous', action: input.kind }); return { tasks }; }
  return { tasks, waiting: '회수할 물자의 실제 목록과 위치를 확인해야 합니다.' };
}
