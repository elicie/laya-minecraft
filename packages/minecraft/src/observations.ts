import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import type { ItemStack, ObservationInput, Position } from '../../contracts/src';

export function position(p: Position): Position { return { x: p.x, y: p.y, z: p.z }; }
export function worldOf(bot: Bot, host: string, port: number): { world: string; dimension: string } {
  return { world: `${host}:${port}`, dimension: String(bot.game?.dimension ?? 'overworld') };
}
export function inventory(bot: Bot): ItemStack[] {
  const counts = new Map<string, number>();
  for (const item of (bot.currentWindow ?? bot.inventory).items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return [...counts].map(([name, count]) => ({ name, count }));
}
export function observationBase(world: string, dimension: string) { return { id: randomUUID(), observedAt: Date.now(), world, dimension }; }
export function inventoryObservation(bot: Bot, world: string, dimension: string): ObservationInput {
  return { ...observationBase(world, dimension), kind: 'inventory', data: { items: inventory(bot), position: position(bot.entity.position) } };
}
export function nearbyBlocks(bot: Bot, world: string, dimension: string): ObservationInput {
  const blocks: { position: Position; name: string }[] = [];
  const origin = bot.entity.position.floored();
  for (let dx = -8; dx <= 8; dx += 2) for (let dz = -8; dz <= 8; dz += 2) for (let dy = -2; dy <= 2; dy++) {
    const p = origin.offset(dx, dy, dz);
    const block = bot.blockAt(p);
    if (block) blocks.push({ position: position(p), name: block.name });
  }
  return { ...observationBase(world, dimension), kind: 'blocks', data: { blocks } };
}
export function vector(p: Position): Vec3 { return new Vec3(p.x, p.y, p.z); }
