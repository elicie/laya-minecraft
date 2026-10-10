import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { InventoryViewSchema, type InventorySlotItem, type InventoryView, type ItemStack, type ObservationInput, type Position } from '../../contracts/src';

export function position(p: Position): Position { return { x: p.x, y: p.y, z: p.z }; }
export function worldOf(bot: Bot, host: string, port: number): { world: string; dimension: string } {
  return { world: `${host}:${port}`, dimension: String(bot.game?.dimension ?? 'overworld') };
}
export function inventory(bot: Bot): ItemStack[] {
  const counts = new Map<string, number>();
  for (const item of (bot.currentWindow ?? bot.inventory).items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return [...counts].map(([name, count]) => ({ name, count }));
}
function read(object: unknown, field: string): unknown {
  try { return object && typeof object === 'object' ? (object as Record<string, unknown>)[field] : undefined; } catch { return undefined; }
}
function integer(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max; }
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const clean = value.replace(/§[0-9a-fk-or]/gi, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 256);
  return clean || undefined;
}
// Public Item.customName may return a chat component in modern Minecraft.
// Extract only literal text; raw NBT, styles and commands never cross the wire.
function customText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (/^\s*[\[{\"]/.test(value)) { if (value.length > 8192) return; try { value = JSON.parse(value); } catch { return text(value); } }
    else return text(value);
  }
  let visited = 0;
  const fragments: string[] = [];
  const walk = (part: unknown, depth: number): void => {
    if (depth > 8 || ++visited > 64) return;
    if (typeof part === 'string') { fragments.push(part.slice(0, 256)); return; }
    if (Array.isArray(part)) { for (const entry of part.slice(0, 64)) walk(entry, depth + 1); return; }
    if (!part || typeof part !== 'object') return;
    const type = read(part, 'type'), wrapped = read(part, 'value');
    if (['string', 'compound', 'list'].includes(String(type)) && wrapped !== undefined) { walk(wrapped, depth + 1); return; }
    const literal = read(part, 'text'), extra = read(part, 'extra');
    if (literal !== undefined) walk(literal, depth + 1);
    if (extra !== undefined) walk(extra, depth + 1);
  };
  walk(value, 0);
  return text(fragments.join(''));
}
function slotItem(value: unknown, bot: Bot): InventorySlotItem | null | undefined {
  if (value === null) return null;
  const name = read(value, 'name'), count = read(value, 'count');
  if (typeof name !== 'string' || !/^[a-z0-9_.:-]{1,100}$/.test(name) || !integer(count, 1, 1000000)) return;
  const item: InventorySlotItem = { name, count }, registryItem = read(read(bot.registry, 'itemsByName'), name);
  const displayName = text(read(value, 'displayName')), customName = customText(read(value, 'customName'));
  if (displayName) item.displayName = displayName;
  if (customName) item.customName = customName;
  const stackSize = read(value, 'stackSize') ?? read(registryItem, 'stackSize');
  if (integer(stackSize, 1, 99)) item.maxStackSize = stackSize;
  const maximum = read(value, 'maxDurability') ?? read(registryItem, 'maxDurability'), used = read(value, 'durabilityUsed');
  if (integer(maximum, 1, 1000000) && integer(used, 0, maximum)) item.durability = { remaining: maximum - used, maximum };
  const rawEnchants = read(value, 'enchants'), enchants = Array.isArray(rawEnchants) ? rawEnchants : read(rawEnchants, 'enchantments');
  if (Array.isArray(enchants)) {
    item.enchants = [];
    for (const enchant of enchants.slice(0, 32)) {
      const id = read(enchant, 'id'), entryName = read(enchant, 'name') ?? (integer(id, 0, 1000000) ? read(read(read(bot.registry, 'enchantments'), String(id)), 'name') : typeof id === 'string' ? id : undefined), level = read(enchant, 'lvl') ?? read(enchant, 'level');
      if (typeof entryName === 'string' && /^[a-z0-9_.:-]{1,100}$/.test(entryName) && integer(level, 1, 255)) item.enchants.push({ name: entryName.replace(/^minecraft:/, ''), level });
    }
  }
  return item;
}
export function inventoryView(bot: Bot): InventoryView | undefined {
  const player = bot.inventory;
  if (!player || !Array.isArray(player.slots) || player.slots.length !== 46) return;
  const raw = player.slots.slice(), window = bot.currentWindow;
  if (window && window !== player) {
    // Mineflayer copies this section to window 0 on close. While it is open,
    // read the actual public player range instead of stale cached main slots.
    if (player.inventoryStart !== 9 || player.inventoryEnd !== 45 || !integer(window.inventoryStart, 0, 10000) || !integer(window.inventoryEnd, 36, 10000) || window.inventoryEnd - window.inventoryStart !== 36 || !Array.isArray(window.slots) || window.inventoryEnd > window.slots.length || window.hotbarStart !== window.inventoryEnd - 9) return;
    for (let i = 0; i < 36; i++) raw[9 + i] = window.slots[window.inventoryStart + i]!;
  }
  const slots = raw.map(item => slotItem(item, bot));
  if (slots.some(item => item === undefined)) return;
  const view: InventoryView = { slots: slots as (InventorySlotItem | null)[] };
  if (integer(bot.quickBarSlot, 0, 8)) view.selectedHotbarSlot = bot.quickBarSlot;
  const cursor = slotItem(read(window ?? player, 'selectedItem'), bot);
  if (cursor !== undefined) view.cursor = cursor;
  const parsed = InventoryViewSchema.safeParse(view);
  return parsed.success ? parsed.data : undefined;
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
