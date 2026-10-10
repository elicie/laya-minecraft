import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { PositionSchema, type BuildWaitingFor, type JsonObject, type Position } from '../../contracts/src';

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
  if (!knowledge.origin && records && typeof records === 'object' && !Array.isArray(records)) for (const state of Object.values(records)) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    const parsed = PositionSchema.safeParse(state.origin);
    if (parsed.success) { knowledge.origin = parsed.data; break; }
  }
  knowledge.origin ??= { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) };
  const cells = new Map([...knowledge.blocks].map(([key, block]) => [key, block.position]));
  for (const p of recoveryPositions(checkpoint)) cells.set(`${p.x},${p.y},${p.z}`, p);
  if (names.size && bot.findBlocks) {
    for (const p of bot.findBlocks({ point: new Vec3(knowledge.origin.x, knowledge.origin.y, knowledge.origin.z), matching: block => names.has(block.name), maxDistance: 48, count: 64, useExtraInfo: true })) {
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
  const anchor = knowledge.origin;
  const entities = Object.values(bot.entities).filter(entity => names.has(entity.name ?? '') && Math.hypot(entity.position.x - anchor.x, entity.position.z - anchor.z) <= 48 && Math.abs(entity.position.y - anchor.y) <= 8).map(entity => [entity.id, entity.name, Math.floor(entity.position.x), Math.floor(entity.position.y), Math.floor(entity.position.z)]).sort((a, b) => Number(a[0]) - Number(b[0]));
  const items = new Map<string, number>();
  for (const item of bot.inventory.items()) items.set(item.name, (items.get(item.name) ?? 0) + item.count);
  return JSON.stringify({ items: [...items].sort(([a], [b]) => a.localeCompare(b)), food: bot.food, criticalHealth: bot.health <= retreatHealth, dimension: bot.game?.dimension, blocks, entities });
}

export function copyBuildProtection(source: JsonObject, target: JsonObject): void {
  for (const field of ['protectedPositions', 'buildPreparationProtection', 'buildProtection']) {
    if (source[field] !== undefined) target[field] = structuredClone(source[field]);
  }
}
