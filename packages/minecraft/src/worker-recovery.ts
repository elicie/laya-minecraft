import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ContainerRefSchema, ItemStackSchema, PositionSchema, type BuildWaitingFor, type JsonObject, type Position } from '../../contracts/src';
import { HOSTILES } from './combat-policy';
import { foodSearchObservationArea } from './resource-recovery';
import { duskOrNight } from './night-burrow';

export function watchedPositions(condition: BuildWaitingFor): Position[] {
  return condition.kind === 'blocks' ? condition.positions : condition.resourcePositions ?? [];
}

export function recoveryPositions(checkpoint: JsonObject): Position[] {
  const values: unknown[] = [];
  if (Array.isArray(checkpoint.resourcePositions)) values.push(...checkpoint.resourcePositions);
  const waiting = checkpoint.waitingFor;
  if (waiting && typeof waiting === 'object' && !Array.isArray(waiting) && Array.isArray(waiting.resourcePositions)) values.push(...waiting.resourcePositions);
  const recovery = checkpoint.resourceRecovery;
  if (recovery && typeof recovery === 'object' && !Array.isArray(recovery)) for (const state of Object.values(recovery)) {
    if (!state || typeof state !== 'object' || Array.isArray(state) || !Array.isArray(state.probes)) continue;
    for (const probe of state.probes) if (probe && typeof probe === 'object' && !Array.isArray(probe)) values.push(probe.position);
  }
  const unique = new Map<string, Position>();
  for (const value of values) {
    const parsed = PositionSchema.safeParse(value);
    if (parsed.success && Object.values(parsed.data).every(Number.isInteger)) unique.set(`${parsed.data.x},${parsed.data.y},${parsed.data.z}`, parsed.data);
    if (unique.size >= 64) break;
  }
  return [...unique.values()];
}

// This describes actual recovery inputs. Clock ticks and the bot's own search
// movement cannot manufacture a new budget; the executor keeps that budget.
export interface FoodRecoveryKnowledge {
  origin?: Position;
  blocks: Map<string, { position: Position; name: string; state: string }>;
}

export function foodRecoveryFingerprint(bot: Bot, checkpoint: JsonObject, retreatHealth: number, knowledge: FoodRecoveryKnowledge): string {
  const names = new Set<string>(Array.isArray(checkpoint.resourceNames) ? checkpoint.resourceNames.filter((name): name is string => typeof name === 'string') : []);
  const records = checkpoint.resourceRecovery;
  const searchArea = foodSearchObservationArea(checkpoint);
  if (!knowledge.origin && records && typeof records === 'object' && !Array.isArray(records)) for (const state of Object.values(records)) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    const parsed = PositionSchema.safeParse(state.origin);
    if (parsed.success) { knowledge.origin = parsed.data; break; }
  }
  knowledge.origin ??= { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) };
  const scanCenter = searchArea?.center ?? knowledge.origin, radius = searchArea?.radius ?? 48;
  const cells = new Map([...knowledge.blocks].map(([key, block]) => [key, block.position]));
  for (const p of recoveryPositions(checkpoint)) cells.set(`${p.x},${p.y},${p.z}`, p);
  if (names.size && bot.findBlocks) {
    for (const p of bot.findBlocks({ point: new Vec3(scanCenter.x, scanCenter.y, scanCenter.z), matching: block => names.has(block.name), maxDistance: radius, count: 64, useExtraInfo: true })) {
      cells.set(`${p.x},${p.y},${p.z}`, { x: p.x, y: p.y, z: p.z });
    }
  }
  for (const [key, p] of cells) {
    const block = bot.blockAt(new Vec3(p.x, p.y, p.z));
    // Unloaded cells preserve the last real observation. Disappearing chunks
    // are neither proof of air nor permission to restart an exhausted search.
    if (!block) continue;
    const age = typeof block.getProperties === 'function' ? block.getProperties().age : undefined;
    if (!knowledge.blocks.has(key) && knowledge.blocks.size >= 256) knowledge.blocks.delete(knowledge.blocks.keys().next().value!);
    knowledge.blocks.set(key, { position: p, name: block.name, state: age === undefined ? '' : `age:${age}` });
  }
  const blocks = [...knowledge.blocks].map(([key, block]) => [key, block.name, block.state]).sort((a, b) => a[0].localeCompare(b[0]));
  const threats = Object.values(bot.entities).filter(entity => HOSTILES.has(entity.name ?? ''));
  const threatened = [...knowledge.blocks].filter(([, block]) => threats.some(entity => Math.hypot(entity.position.x - block.position.x, entity.position.y - block.position.y, entity.position.z - block.position.z) < 20)).map(([key]) => key).sort();
  const anchor = scanCenter;
  const entities = Object.values(bot.entities).filter(entity => names.has(entity.name ?? '') && Math.hypot(entity.position.x - anchor.x, entity.position.z - anchor.z) <= radius && Math.abs(entity.position.y - anchor.y) <= 8).map(entity => [entity.id, entity.name, Math.floor(entity.position.x), Math.floor(entity.position.y), Math.floor(entity.position.z)]).sort((a, b) => Number(a[0]) - Number(b[0]));
  const items = new Map<string, number>();
  for (const item of bot.inventory.items()) items.set(item.name, (items.get(item.name) ?? 0) + item.count);
  const saved = checkpoint.foodWarehouse;
  const warehouse = saved && typeof saved === 'object' && !Array.isArray(saved) ? ContainerRefSchema.safeParse(saved.container) : undefined;
  const warehouseItems = saved && typeof saved === 'object' && !Array.isArray(saved) && Array.isArray(saved.items) ? ItemStackSchema.array().safeParse(saved.items) : undefined;
  const stock = new Map<string, number>();
  if (warehouseItems?.success) for (const item of warehouseItems.data) stock.set(item.name, (stock.get(item.name) ?? 0) + item.count);
  const burrow=checkpoint.nightBurrow,outside=burrow&&typeof burrow==='object'&&!Array.isArray(burrow)?PositionSchema.safeParse(burrow.outside):undefined;
  const displaced=outside?.success&&burrow&&typeof burrow==='object'&&!Array.isArray(burrow)&&burrow.phase==='digging'?bot.entity.position.distanceTo(new Vec3(outside.data.x,outside.data.y,outside.data.z))>6:false;
  return JSON.stringify({ items: [...items].sort(([a], [b]) => a.localeCompare(b)), food: bot.food, criticalHealth: bot.health <= retreatHealth, dimension: bot.game?.dimension, blocks, entities, threatened,
    ...(checkpoint.nightBurrowPending===true?{shelterWindow:duskOrNight(bot),shelterDisplaced:displaced}:{}),
    ...(warehouse?.success && warehouseItems?.success ? { warehouse: { container: warehouse.data, items: [...stock].sort(([a], [b]) => a.localeCompare(b)) } } : {}) });
}

export function copyBuildProtection(source: JsonObject, target: JsonObject): void {
  for (const field of ['protectedPositions', 'buildPreparationProtection', 'buildProtection']) {
    if (source[field] !== undefined) target[field] = structuredClone(source[field]);
  }
}
