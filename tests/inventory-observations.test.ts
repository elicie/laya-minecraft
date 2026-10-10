import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import itemLoader from 'prismarine-item';
import { Vec3 } from 'vec3';
import { BotReportSchema, InventorySlotItemSchema, InventoryViewSchema, WorkerLaunchSchema, type WorkerMessage } from '../packages/contracts/src';
import { inventory, inventoryView } from '../packages/minecraft/src/observations';
import { MinecraftWorker } from '../packages/minecraft/src/worker';

const data = minecraftData('1.21.1'), Item = itemLoader('1.21.1');
function fixture() {
  const slots: ({ name: string; count: number } | null)[] = Array(46).fill(null);
  const player = { slots, inventoryStart: 9, inventoryEnd: 45, hotbarStart: 36, selectedItem: null as unknown, items: () => slots.slice(9, 45).filter(i => i !== null) };
  const emitter = new EventEmitter();
  const raw = Object.assign(emitter, { inventory: player, currentWindow: null as unknown, quickBarSlot: 0, registry: data, health: 20, food: 20, game: { dimension: 'overworld' }, entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {}, players: {}, blockAt: () => null, pathfinder: { setMovements() {}, setGoal() {} }, clearControlStates() {}, deactivateItem() {}, quit(reason: string) { emitter.emit('end', reason); } });
  return { bot: raw as unknown as Bot, raw, player, slots, emitter };
}

test('inventory contracts require exactly 46 actual slots and reject malformed optional metadata', () => {
  assert.equal(InventoryViewSchema.safeParse({ slots: Array(46).fill(null) }).success, true);
  for (const slots of [Array(45).fill(null), Array(47).fill(null), Array(46).fill(undefined)]) assert.equal(InventoryViewSchema.safeParse({ slots }).success, false);
  for (const item of [{ name: 'dirt', count: 0 }, { name: 'dirt', count: -1 }, { name: 'dirt', count: NaN }, { name: 'dirt', count: Infinity }, { name: 'dirt', count: 1.5 }, { name: 'dirt', count: 1, nbt: {} }, { name: 'iron_axe', count: 1, durability: { remaining: 251, maximum: 250 } }, { name: 'iron_axe', count: 1, durability: { remaining: -1, maximum: 250 } }, { name: 'dirt', count: 1, maxStackSize: 100 }, { name: 'dirt', count: 1, enchants: [{ name: 'efficiency', level: 0 }] }]) assert.equal(InventorySlotItemSchema.safeParse(item).success, false);
  for (const selectedHotbarSlot of [-1, 9, 1.5, NaN]) assert.equal(InventoryViewSchema.safeParse({ slots: Array(46).fill(null), selectedHotbarSlot }).success, false);
  assert.equal(InventorySlotItemSchema.safeParse({ name: 'iron_pickaxe', count: 1, durability: { remaining: 0, maximum: 250 } }).success, true);
  const report = { ready: false, world: '127.0.0.1:25566', dimension: 'overworld', health: 0, food: 0, inventory: [], action: 'connecting', reason: 'waiting', mode: 'idle', capabilities: [], rulesVersion: 0 };
  assert.equal(BotReportSchema.parse(report).inventoryView, undefined, 'legacy reports are unknown instead of empty slots');
});

test('actual split stacks, crafting output and equipment keep their exact window-0 slots', () => {
  const f = fixture(); f.slots[9] = { name: 'dirt', count: 64 }; f.slots[38] = { name: 'dirt', count: 47 }; f.slots[0] = { name: 'oak_planks', count: 4 }; f.slots[1] = { name: 'oak_log', count: 1 }; f.slots[5] = { name: 'iron_helmet', count: 1 }; f.slots[8] = { name: 'iron_boots', count: 1 }; f.slots[45] = { name: 'shield', count: 1 }; f.raw.quickBarSlot = 2;
  const view = inventoryView(f.bot); assert.ok(view); assert.equal(view.slots.length, 46); assert.deepEqual(view.slots[9], { name: 'dirt', count: 64, maxStackSize: 64 }); assert.equal(view.slots[38]?.count, 47); assert.equal(view.slots[0]?.name, 'oak_planks'); assert.equal(view.slots[1]?.name, 'oak_log'); assert.equal(view.slots[5]?.name, 'iron_helmet'); assert.equal(view.slots[8]?.name, 'iron_boots'); assert.equal(view.slots[45]?.name, 'shield'); assert.equal(view.selectedHotbarSlot, 2); assert.equal(view.cursor, null);
  assert.deepEqual(inventory(f.bot), [{ name: 'dirt', count: 111 }], 'planning aggregate remains separate from equipment/crafting display'); assert.equal(view.slots[10], null);
});

test('an open container overlays only its player range, including cleared slots and current cursor', () => {
  const f = fixture(); f.slots[9] = { name: 'dirt', count: 3 }; f.slots[10] = { name: 'diamond', count: 1 }; f.slots[5] = { name: 'iron_helmet', count: 1 }; f.slots[1] = { name: 'oak_log', count: 1 }; f.slots[45] = { name: 'shield', count: 1 }; f.player.selectedItem = { name: 'dirt', count: 10 };
  const slots = Array(63).fill(null); slots[0] = { name: 'diamond', count: 24 }; slots[27] = { name: 'dirt', count: 64 }; slots[61] = { name: 'dirt', count: 47 };
  f.raw.currentWindow = { id: 1, slots, inventoryStart: 27, inventoryEnd: 63, hotbarStart: 54, selectedItem: { name: 'cobblestone', count: 2 }, items: () => slots.slice(27).filter(Boolean) };
  const before = [...f.slots], view = inventoryView(f.bot); assert.ok(view); assert.equal(view.slots[9]?.count, 64); assert.equal(view.slots[43]?.count, 47); assert.equal(view.slots[10], null); assert.equal(view.slots[5]?.name, 'iron_helmet'); assert.equal(view.slots[1]?.name, 'oak_log'); assert.equal(view.slots[45]?.name, 'shield'); assert.equal(view.slots.filter(i => i?.name === 'diamond').length, 0); assert.equal(view.cursor?.name, 'cobblestone'); assert.deepEqual(f.slots, before, 'observing does not mutate Mineflayer slots'); assert.deepEqual(inventory(f.bot), [{ name: 'dirt', count: 111 }]);
});

test('incomplete player shapes or invalid container mappings stay unknown instead of inventing emptiness', () => {
  const f = fixture(); f.slots[9] = { name: 'dirt', count: 0 }; assert.equal(inventoryView(f.bot), undefined); f.slots[9] = null;
  for (const window of [{ inventoryStart: 27, inventoryEnd: 62, hotbarStart: 53, slots: Array(63).fill(null) }, { inventoryStart: 27, inventoryEnd: 63, hotbarStart: 54, slots: Array(62).fill(null) }, { inventoryStart: 27, inventoryEnd: 63, hotbarStart: 0, slots: Array(63).fill(null) }]) { f.raw.currentWindow = window; assert.equal(inventoryView(f.bot), undefined); }
  f.raw.currentWindow = null; f.slots.pop(); assert.equal(inventoryView(f.bot), undefined);
});

test('public item metadata becomes bounded plain names, durability and enchantments without raw NBT', () => {
  const f = fixture(), tool = new Item(data.itemsByName.iron_pickaxe.id, 1); tool.customName = JSON.stringify({ text: '§b작업 도구', extra: [{ text: ' II' }], clickEvent: { action: 'run_command', value: '/op name' } }); tool.durabilityUsed = 7; tool.enchants = [{ name: 'efficiency', lvl: 2 }]; f.slots[36] = tool;
  const item = inventoryView(f.bot)?.slots[36]; assert.ok(item); assert.equal(item.customName, '작업 도구 II'); assert.deepEqual(item.durability, { remaining: 243, maximum: 250 }); assert.deepEqual(item.enchants, [{ name: 'efficiency', level: 2 }]); assert.equal(item.maxStackSize, 1); assert.equal(Object.hasOwn(item, 'nbt'), false); assert.equal(JSON.stringify(item).includes('run_command'), false);
  tool.durabilityUsed = 250; assert.equal(inventoryView(f.bot)?.slots[36]?.durability?.remaining, 0);
});

test('modern component getters and unavailable metadata do not corrupt the inventory report', () => {
  const f = fixture();
  f.slots[36] = { name: 'iron_pickaxe', count: 1, get customName() { return { type: 'compound', value: { text: { type: 'string', value: '실제 도구' } } }; }, get enchants() { return { enchantments: [{ id: data.enchantmentsByName.efficiency.id, level: 3 }] }; }, get maxDurability() { return 250; }, get durabilityUsed() { throw new Error('unsupported item damage'); } } as typeof f.slots[number];
  const view = inventoryView(f.bot); assert.ok(view); assert.equal(view.slots[36]?.customName, '실제 도구'); assert.deepEqual(view.slots[36]?.enchants, [{ name: 'efficiency', level: 3 }]); assert.equal(view.slots[36]?.durability, undefined);
  f.slots[37] = { name: 'dirt', count: 1, get displayName() { throw new Error('getter unavailable'); }, get customName() { return 'x'.repeat(10000); } } as typeof f.slots[number]; assert.equal(inventoryView(f.bot)?.slots[37]?.customName?.length, 256);
});

test('worker readiness publishes the real view and omits it when inventory knowledge is unavailable', async () => {
  const f = fixture(), messages: WorkerMessage[] = [], launch = WorkerLaunchSchema.parse({ botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch', config: { name: 'InvUnit', connection: { host: '127.0.0.1', port: 25566 } }, rules: { autonomyEnabled: false } });
  f.slots[36] = { name: 'bread', count: 5 }; f.raw.quickBarSlot = 0;
  const worker = new MinecraftWorker(launch, f.bot, message => messages.push(message), { timers: false, movementsFactory: () => ({}) as Movements });
  try { f.emitter.emit('spawn'); f.emitter.emit('health'); const ready = messages.find(m => m.type === 'bot.ready'); assert.ok(ready?.type === 'bot.ready'); assert.equal(ready.payload.inventoryView?.slots[36]?.name, 'bread'); assert.equal(ready.payload.inventoryView?.selectedHotbarSlot, 0); }
  finally { await worker.shutdown(); }
  const unknown = fixture(); unknown.slots.pop(); const worker2 = new MinecraftWorker(launch, unknown.bot, message => messages.push(message), { timers: false, movementsFactory: () => ({}) as Movements });
  try { unknown.emitter.emit('spawn'); unknown.emitter.emit('health'); const ready = messages.filter(m => m.type === 'bot.ready').at(-1); assert.ok(ready?.type === 'bot.ready'); assert.equal(ready.payload.inventoryView, undefined); }
  finally { await worker2.shutdown(); }
});
