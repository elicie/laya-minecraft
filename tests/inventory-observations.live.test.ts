import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { Vec3 } from 'vec3';
import { InventoryViewSchema } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src';
import { inventoryView } from '../packages/minecraft/src/observations';

if ((process.env.MC_HOST ?? '127.0.0.1') !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string): Promise<void> { const end = Date.now() + 10000; while (!check()) { if (Date.now() >= end) throw new Error(message); await sleep(100); } }

test('disposable Minecraft reports exact player slots, equipment, names, damage, enchants and open-container cursor', { timeout: 60000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
  rcon('forceload add 1600 1600'); rcon('fill 1599 79 1599 1608 79 1608 grass_block'); rcon('fill 1599 80 1599 1608 83 1608 air'); rcon('setblock 1604 80 1600 chest'); rcon('item replace block 1604 80 1600 container.0 with diamond 24');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaInvCheck', auth: 'offline' }); bot.on('error', error => console.error(error.message));
  try {
    await once(bot, 'spawn'); rcon('tp LayaInvCheck 1601.5 80 1600.5'); rcon('clear LayaInvCheck');
    rcon('item replace entity LayaInvCheck inventory.0 with dirt 64'); rcon('item replace entity LayaInvCheck inventory.1 with dirt 47');
    rcon('item replace entity LayaInvCheck armor.head with iron_helmet'); rcon('item replace entity LayaInvCheck armor.chest with iron_chestplate'); rcon('item replace entity LayaInvCheck armor.legs with iron_leggings'); rcon('item replace entity LayaInvCheck armor.feet with iron_boots'); rcon('item replace entity LayaInvCheck weapon.offhand with shield');
    rcon('item replace entity LayaInvCheck hotbar.3 with iron_pickaxe[damage=7,custom_name=\'{"text":"실제 도구"}\',enchantments={levels:{"minecraft:efficiency":2}}]');
    await until(() => inventoryView(bot)?.slots[39]?.name === 'iron_pickaxe' && inventoryView(bot)?.slots[10]?.count === 47, 'actual player items were not received');
    bot.setQuickBarSlot(3); const view = inventoryView(bot); assert.ok(view); InventoryViewSchema.parse(JSON.parse(JSON.stringify(view)));
    assert.equal(view.slots.length, 46); assert.equal(view.slots[9]?.count, 64); assert.equal(view.slots[10]?.count, 47); assert.equal(view.slots[5]?.name, 'iron_helmet'); assert.equal(view.slots[6]?.name, 'iron_chestplate'); assert.equal(view.slots[7]?.name, 'iron_leggings'); assert.equal(view.slots[8]?.name, 'iron_boots'); assert.equal(view.slots[45]?.name, 'shield'); assert.equal(view.selectedHotbarSlot, 3); assert.equal(view.slots[39]?.customName, '실제 도구'); assert.deepEqual(view.slots[39]?.durability, { remaining: 243, maximum: 250 }); assert.deepEqual(view.slots[39]?.enchants, [{ name: 'efficiency', level: 2 }]);
    await bot.clickWindow(9, 0, 0); await until(() => inventoryView(bot)?.cursor?.name === 'dirt', 'actual held cursor was not observed'); assert.equal(inventoryView(bot)?.slots[9], null); assert.equal(inventoryView(bot)?.cursor?.count, 64);
    await bot.clickWindow(1, 0, 0); assert.equal(inventoryView(bot)?.slots[1]?.name, 'dirt'); assert.equal(inventoryView(bot)?.slots[1]?.count, 64); await bot.clickWindow(1, 0, 0); await bot.clickWindow(9, 0, 0);
    await until(() => !!bot.blockAt(new Vec3(1604, 80, 1600)), 'validation chest chunk was not loaded');
    const chest = await bot.openChest(bot.blockAt(new Vec3(1604, 80, 1600))!); const window = bot.currentWindow; assert.ok(window); const mainSlot = window.inventoryStart;
    await bot.clickWindow(mainSlot, 0, 0); const opened = inventoryView(bot); assert.ok(opened); assert.equal(opened.slots[9], null); assert.equal(opened.cursor?.name, 'dirt'); assert.equal(opened.cursor?.count, 64); assert.equal(opened.slots.filter(item => item?.name === 'diamond').length, 0); assert.equal(opened.slots[10]?.count, 47); assert.equal(opened.slots[45]?.name, 'shield');
    await bot.clickWindow(mainSlot, 0, 0); chest.close(); await until(() => !bot.currentWindow && inventoryView(bot)?.slots[9]?.count === 64, 'closing the chest did not preserve actual player items'); assert.equal(inventoryView(bot)?.cursor, null);
  } finally { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); bot.quit('inventory observations validation complete'); rcon('forceload remove 1600 1600'); }
});
