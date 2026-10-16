import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { BotInputSchema, RulesSchema } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ResourceRecovery } from '../packages/minecraft/src/resource-recovery';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('actual mining reaches a previously rejected resource six blocks downhill and an empty utility search chooses actual available wood', { timeout: 120000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  rcon('forceload add 7400 7400 7440 7412'); rcon('fill 7400 79 7400 7440 92 7412 air');
  for (let x = 7400; x <= 7440; x++) {
    const feet = 86 - Math.max(0, Math.min(6, Math.floor((x - 7408) / 3)));
    rcon(`fill ${x} 75 7400 ${x} ${feet - 2} 7412 dirt`); rcon(`fill ${x} ${feet - 1} 7400 ${x} ${feet - 1} 7412 grass_block`);
  }
  rcon('setblock 7432 80 7406 stone');
  rcon('kill @e[type=item,x=7398,y=74,z=7398,dx=45,dy=20,dz=16]');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaSlopeSource', auth: 'offline' }); bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn'); rcon('tp LayaSlopeSource 7404.5 86 7406.5'); rcon('clear LayaSlopeSource'); rcon('give LayaSlopeSource wooden_pickaxe 1');
    const ready = Date.now() + 10000;
    while ((bot.entity.position.distanceTo(new Vec3(7404.5, 86, 7406.5)) > 1 || !bot.inventory.items().some(i => i.name === 'wooden_pickaxe') || !bot.blockAt(new Vec3(7432, 80, 7406))) && Date.now() < ready) await sleep(50);
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 2; movements.infiniteLiquidDropdownDistance = false; movements.scafoldingBlocks = []; bot.pathfinder.setMovements(movements);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', autonomyEnabled: false }), { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaSlopeSource' });
    const executor = new MineflayerExecutor(bot, { config, rules, world: rules.world, dimension: () => 'overworld' });
    const services = executor.services(AbortSignal.timeout(60000));
    const recovery = new ResourceRecovery(bot, services, 'cobblestone', ['stone', 'cobblestone'], true, () => false);
    recovery.state.failed = [{ position: { x: 7432, y: 80, z: 7406 }, name: 'stone', reason: 'Legacy three-block height refusal' }];
    await executor.ensureItem('cobblestone', 1, services);
    assert.equal(executor.count('cobblestone'), 1); assert.equal(bot.blockAt(new Vec3(7432, 80, 7406))?.name, 'air');
    assert.ok(Math.abs(bot.entity.position.y - 80) < .1);
    assert.ok((services.checkpoint.resourceApproachRechecks as { routeConfirmed: boolean }[]).some(r => r.routeConfirmed));
    assert.match(rcon('execute if block 7412 83 7406 dirt'), /Test passed/);
    console.log('Actual downhill collection verified', JSON.stringify({ start: { x: 7404, y: 86, z: 7406 }, actual: bot.entity.position, source: { x: 7432, y: 80, z: 7406 }, cobblestone: executor.count('cobblestone'), providedTool: 'wooden_pickaxe', constructionItemsGiven: false }));
    rcon('fill 7432 83 7406 7432 86 7406 oak_log'); rcon('setblock 7432 88 7406 oak_leaves[persistent=true]');
    rcon('clear LayaSlopeSource'); rcon('tp LayaSlopeSource 7404.5 86 7406.5');
    const emptyUntil=Date.now()+5000;while((bot.inventory.items().length||bot.entity.position.distanceTo(new Vec3(7404.5,86,7406.5))>1)&&Date.now()<emptyUntil)await sleep(50);
    assert.equal(bot.inventory.items().length,0);
    const wood=executor.services(AbortSignal.timeout(60000),{materialExpedition:true,resourceExpedition:true});
    await executor.ensureItem('crafting_table',1,wood);
    assert.equal(executor.count('crafting_table'),1);assert.equal([83,84,85,86].filter(y=>bot.blockAt(new Vec3(7432,y,7406))?.name==='air').length,1);
    const records=wood.checkpoint.resourceRecovery as Record<string,{status:string}>;
    assert.equal(records.$utility_wood!.status,'found');assert.equal(records.cherry_log,undefined);
    console.log('Actual empty utility wood search verified',JSON.stringify({actual:bot.entity.position,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),constructionItemsGiven:false,toolsGiven:false}));
    await executor.ensureItem('wooden_pickaxe',1,wood);
    assert.equal(executor.count('wooden_pickaxe'),1);assert.equal(executor.count('wooden_sword'),1);
    console.log('Actual natural tool and survival weapon verified',JSON.stringify({actual:bot.entity.position,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),weapon:wood.checkpoint.survivalWeapon,constructionItemsGiven:false,toolsGiven:false}));
    rcon('effect give LayaSlopeSource minecraft:hunger 30 100 true');
    const hungry=Date.now()+10000;while(bot.food>17&&Date.now()<hungry)await sleep(50);rcon('effect clear LayaSlopeSource minecraft:hunger');
    rcon('damage LayaSlopeSource 16 minecraft:generic');const hurt=Date.now()+5000;while(bot.health>6&&Date.now()<hurt)await sleep(50);
    assert.ok(bot.health>0&&bot.health<=6);assert.ok(bot.food<=17);const healthBefore=bot.health,foodBefore=bot.food;
    rcon('summon cow 7438.5 80 7409.5 {NoAI:1b,Silent:1b,Health:2.0f}');
    const seen=Date.now()+5000;while(!Object.values(bot.entities).some(e=>e.name==='cow')&&Date.now()<seen)await sleep(50);
    await executor.ensureFood(wood);assert.ok(executor.count('beef')>=1);await executor.eat(wood);assert.ok(bot.food>foodBefore);
    console.log('Actual critical passive food recovery verified',JSON.stringify({healthBefore,foodBefore,health:bot.health,food:bot.food,foodGiven:false,weaponNaturallyCrafted:true}));
  } finally { bot.quit('resource slope validation finished'); await sleep(250); rcon('forceload remove 7400 7400 7440 7412'); }
});
