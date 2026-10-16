import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { BotInputSchema, RulesSchema } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ResourceRecovery, foodSearchCanExpand } from '../packages/minecraft/src/resource-recovery';

if ((process.env.MC_HOST ?? '127.0.0.1') !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, reason: string) {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() >= deadline) throw new Error(reason); await sleep(100); }
}

test('critical empty-inventory recovery expands after five actual walks and harvests and eats beyond 48 blocks', { timeout: 180000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
  const origin = new Vec3(1818.5, 80, 1818.5);
  rcon('forceload add 1812 1796 1950 1840');
  rcon('fill 1812 80 1796 1950 84 1840 air');
  rcon('fill 1812 76 1796 1950 78 1840 dirt');
  rcon('fill 1812 79 1796 1950 79 1840 grass_block');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaFoodExpand', auth: 'offline', viewDistance: 2 });
  bot.loadPlugin(pathfinder); bot.on('error', error => console.error(error.message));
  let revealTimer: NodeJS.Timeout | undefined;
  try {
    await once(bot, 'spawn'); rcon('gamemode survival LayaFoodExpand'); rcon('tp LayaFoodExpand 1818.5 80 1818.5'); rcon('clear LayaFoodExpand');
    await until(() => bot.entity.position.distanceTo(origin) < 1 && bot.inventory.items().length === 0 && bot.blockAt(origin.floored().offset(0, -1, 0))?.name === 'grass_block', 'initial observed empty-inventory fixture is missing');
    // The server grants fresh players a short invulnerability window.
    await sleep(3100);
    rcon('effect give LayaFoodExpand instant_health 1 10 true'); await until(() => bot.health >= 20, 'fixture health was not restored');
    await sleep(1100);
    // Exhaust the actual saturation first rather than assuming a one-second
    // hunger effect changes foodLevel. Clear the effect at the observed value.
    rcon('effect give LayaFoodExpand hunger 30 63 true');
    const hungerDeadline = Date.now() + 25000;
    while (bot.food >= 18 && Date.now() < hungerDeadline) await sleep(100);
    rcon('effect clear LayaFoodExpand hunger');
    assert.doesNotMatch(rcon('damage LayaFoodExpand 15 minecraft:generic'), /invulnerable|No entity was found/);
    await until(() => bot.health > 0 && bot.health <= 6 && bot.food < 18, 'actual low-health food state is missing');
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 1; bot.pathfinder.setMovements(movements);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', center: null, autonomyEnabled: false });
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaFoodExpand', allowedActions: ['collect', 'craft', 'explore'], connection: { host: '127.0.0.1', port: 25566, version: '1.21.1' } });
    const executor = new MineflayerExecutor(bot, { config, rules, world: rules.world, dimension: () => 'overworld', onProgress: (action, reason) => console.log(action, reason) });
    const services = executor.services(AbortSignal.timeout(150000));
    let source: Vec3 | undefined;
    // The source appears on the disposable server only after actual extended
    // walking. No library cache, navigation method or inventory is modified.
    revealTimer = setInterval(() => {
      if (source || Math.hypot(bot.entity.position.x - origin.x, bot.entity.position.z - origin.z) <= 50) return;
      const feet = bot.entity.position.floored(), revealed = new Vec3(feet.x + 3, feet.y, feet.z); source = revealed;
      rcon(`setblock ${revealed.x} 79 ${revealed.z} farmland[moisture=7]`);
      rcon(`setblock ${revealed.x} 80 ${revealed.z} potatoes[age=7]`);
    }, 100);
    await executor.ensureFood(services); clearInterval(revealTimer); revealTimer = undefined;
    assert.ok(source && Math.hypot(source.x - origin.x, source.z - origin.z) > 48);
    assert.ok(executor.count('potato') > 0); assert.equal(bot.blockAt(source)?.name, 'air');
    const search = (services.checkpoint.resourceRecovery as Record<string, { foodSearchExpanded?: boolean; origin: { x: number; y: number; z: number } }>).$food;
    assert.equal(search.foodSearchExpanded, true); assert.deepEqual(search.origin, { x: 1818, y: 80, z: 1818 });
    const explorations = services.observations.filter(o => o.kind === 'exploration');
    assert.ok(explorations.length >= 6); assert.ok(explorations.some(o => Math.hypot(o.data.position.x - origin.x, o.data.position.z - origin.z) > 48));
    const foodBefore = bot.food, potatoBefore = executor.count('potato'); assert.equal(await executor.eat(services), true);
    await until(() => bot.food > foodBefore && executor.count('potato') < potatoBefore, 'actual potato consumption was not confirmed');
    console.log('Verified expanded food search', JSON.stringify({ health: bot.health, foodBefore, foodAfter: bot.food, potatoBefore, potatoAfter: executor.count('potato'), source, walks: explorations.length, expanded: search.foodSearchExpanded }));
  } finally {
    clearInterval(revealTimer);
    const ended = once(bot, 'end'); bot.quit('disposable food expansion validation complete'); await Promise.race([ended, sleep(1000)]);
    rcon('forceload remove 1812 1796 1950 1840');
  }
});

test('food expedition loads real distant chunks, harvests a preexisting crop beyond 192 blocks and confirms consumption', { timeout: 220000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
  const origin = new Vec3(4206.5, 80, 4206.5), source = new Vec3(4406, 80, 4206);
  rcon('forceload add 4192 4186 4448 4226');
  for (const [low, high] of [[80, 81], [82, 83], [84, 84]]) rcon(`fill 4192 ${low} 4186 4448 ${high} 4226 air`);
  rcon('fill 4192 76 4186 4448 77 4226 dirt'); rcon('fill 4192 78 4186 4448 78 4226 dirt'); rcon('fill 4192 79 4186 4448 79 4226 grass_block');
  rcon('setblock 4406 79 4206 farmland[moisture=7]'); rcon('setblock 4406 80 4206 potatoes[age=7]');
  // The crop exists before the client connects. Its chunk must be loaded by
  // actual walking; the fixture never reveals or supplies food during travel.
  rcon('forceload remove 4192 4186 4448 4226');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaFoodJourney', auth: 'offline', viewDistance: 2 });
  bot.loadPlugin(pathfinder); bot.on('error', error => console.error(error.message));
  try {
    await once(bot, 'spawn'); rcon('gamemode survival LayaFoodJourney'); rcon('tp LayaFoodJourney 4206.5 80 4206.5'); rcon('clear LayaFoodJourney');
    await until(() => bot.entity.position.distanceTo(origin) < 1 && bot.inventory.items().length === 0 && bot.blockAt(origin.floored().offset(0, -1, 0))?.name === 'grass_block', 'initial food expedition ground is not observed');
    await sleep(3100); assert.equal(bot.blockAt(source), null, 'the preexisting distant crop must initially be in an unloaded client chunk');
    rcon('effect give LayaFoodJourney instant_health 1 10 true'); await until(() => bot.health >= 20, 'food expedition initial health is missing'); await sleep(1100);
    rcon('effect give LayaFoodJourney hunger 30 63 true'); const hungerDeadline = Date.now() + 25000;
    while (bot.food >= 18 && Date.now() < hungerDeadline) await sleep(100);
    rcon('effect clear LayaFoodJourney hunger'); assert.doesNotMatch(rcon('damage LayaFoodJourney 15 minecraft:generic'), /invulnerable|No entity was found/);
    await until(() => bot.health > 0 && bot.health <= 6 && bot.food < 18, 'food expedition actual critical state is missing');
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 1; bot.pathfinder.setMovements(movements);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', center: null, autonomyEnabled: false });
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaFoodJourney', allowedActions: ['collect', 'craft', 'explore'], connection: { host: '127.0.0.1', port: 25566, version: '1.21.1' } });
    const executor = new MineflayerExecutor(bot, { config, rules, world: rules.world, dimension: () => 'overworld', onProgress: (action, reason) => console.log(action, reason) });
    const services = executor.services(AbortSignal.timeout(190000));
    await executor.ensureFood(services);
    assert.ok(executor.count('potato') > 0); assert.equal(bot.blockAt(source)?.name, 'air');
    const search = (services.checkpoint.resourceRecovery as Record<string, { origin: { x: number; y: number; z: number }; foodJourney?: { moves: number; center: { x: number; y: number; z: number } } }>).$food;
    assert.ok(search.foodJourney && search.foodJourney.moves > 0); assert.deepEqual(search.origin, { x: 4206, y: 80, z: 4206 });
    assert.ok(Math.hypot(bot.entity.position.x - origin.x, bot.entity.position.z - origin.z) > 192);
    const beforeFood = bot.food, beforePotato = executor.count('potato'); assert.equal(await executor.eat(services), true);
    await until(() => bot.food > beforeFood && executor.count('potato') < beforePotato, 'food expedition actual crop consumption is missing');
    console.log('Verified distant food expedition', JSON.stringify({ distance: Math.hypot(bot.entity.position.x - origin.x, bot.entity.position.z - origin.z), sourceInitiallyUnloaded: true, journeyMoves: search.foodJourney.moves, beforeFood, afterFood: bot.food, beforePotato, afterPotato: executor.count('potato') }));
  } finally {
    const ended = once(bot, 'end'); bot.quit('disposable long-distance food expedition complete'); await Promise.race([ended, sleep(1000)]);
    rcon('forceload remove 4192 4186 4448 4226');
  }
});

test('a critically injured food seeker resumes after eighty blocks of actual displacement, eats and naturally heals to full health', { timeout: 240000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8', timeout: 10000 });
  const oldRegeneration = rcon('gamerule naturalRegeneration').match(/\b(true|false)\b/)?.[1]; assert.ok(oldRegeneration);
  const name = 'LayaFoodLanding', old = { x: 8284, y: 80, z: 8204 }, landing = new Vec3(8204.5,80,8204.5);
  assert.equal(rcon('list').includes(name), false);
  rcon('forceload add 8200 8200 8290 8214'); rcon('fill 8200 80 8200 8290 86 8214 air');
  rcon('fill 8200 76 8200 8290 78 8214 dirt'); rcon('fill 8200 79 8200 8290 79 8214 grass_block');
  rcon('fill 8208 79 8206 8211 79 8208 farmland[moisture=7]'); rcon('fill 8208 80 8206 8211 80 8208 carrots[age=7]');
  rcon('kill @e[type=!player,x=8200,y=-64,z=8200,dx=90,dy=152,dz=14]'); rcon('gamerule naturalRegeneration true');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: name, auth: 'offline' }); bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn'); rcon(`gamemode survival ${name}`); rcon(`tp ${name} 8284.5 80 8204.5`); rcon(`clear ${name}`);
    rcon(`effect give ${name} instant_health 1 10 true`); rcon(`effect give ${name} saturation 1 10 true`);
    await until(() => bot.health === 20 && bot.food === 20 && bot.entity.position.x === 8284.5 && !!bot.blockAt(landing), 'actual old search position is missing');
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 1; movements.scafoldingBlocks = []; bot.pathfinder.setMovements(movements);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', autonomyEnabled: false });
    const { id: _id, ...config } = BotInputSchema.parse({ name, allowedActions: ['collect','craft','explore'], connection: { host: '127.0.0.1', port: 25566, version: '1.21.1' } });
    const executor = new MineflayerExecutor(bot, { config, rules, world: rules.world, dimension: () => 'overworld' });
    const services = executor.services(AbortSignal.timeout(215000));
    const search = new ResourceRecovery(bot, services, '$food', ['carrots'], true, () => false);
    search.expandFoodSearch(); search.beginFoodJourney(); search.state.destinationsUsed = 5; search.state.elapsedMs = 180069;
    search.state.foodJourney!.moves = 61; search.state.foodJourney!.elapsedMs = 1539;
    services.checkpoint.safeDetourRequired = true;
    // Both relocations are actual public-API walks through verified ground.
    // The old food waypoint stays behind, as it does during a separate retreat.
    await services.near({ x: 8244.5, y: 80, z: 8204.5 },0); await services.near(landing,0);
    assert.ok(bot.entity.position.distanceTo(landing) < 1); assert.deepEqual(search.state.foodJourney!.center, old);
    console.log('Observed actual displaced body',JSON.stringify({old,actual:bot.entity.position}));
    assert.equal(await search.move(), false); search.wait('old food route disconnected');
    assert.equal(search.state.foodJourney!.status, 'blocked');
    await sleep(1100); rcon(`effect give ${name} hunger 45 63 true`);
    const hungerEnd = Date.now() + 40000;
    const actualFood = () => { const value = rcon(`data get entity ${name} foodLevel`).trim().match(/(-?\d+)\s*$/); assert.ok(value); return Number(value[1]); };
    while (actualFood() > 16 && Date.now() < hungerEnd) await sleep(100);
    rcon(`effect clear ${name} hunger`); assert.equal(actualFood(),16);
    assert.doesNotMatch(rcon(`damage ${name} 19 minecraft:generic`), /invulnerable|No entity was found/);
    await until(() => bot.health === 1 && bot.food === 16, 'actual one-health recovery state is missing');
    console.log('Observed actual one-health recovery start',JSON.stringify({health:bot.health,food:bot.food}));
    assert.equal(foodSearchCanExpand(services.checkpoint,bot),true);
    let consumed = 0; const healingEnd = Date.now() + 145000;
    while (bot.health < 20 && Date.now() < healingEnd) {
      if (bot.food < 18) {
        await executor.ensureFood(services); const before = executor.count('carrot'), beforeFood = bot.food;
        assert.ok(before > 0,JSON.stringify(bot.inventory.items().map(i=>({name:i.name,count:i.count}))));
        assert.equal(await executor.eat(services),true);
        await until(()=>executor.count('carrot') < before && bot.food > beforeFood,'actual carrot consumption update is missing');
        consumed += before - executor.count('carrot');
      }
      await sleep(250);
    }
    assert.equal(bot.health,20); assert.ok(bot.food >= 18); assert.ok(consumed > 0);
    const saved = new ResourceRecovery(bot,services,'$food',['carrots'],true,()=>false).state;
    assert.deepEqual(saved.origin,old); assert.equal(saved.foodJourney!.moves,61); assert.equal(saved.foodJourney!.displacementCount,1);
    assert.deepEqual(saved.foodJourney!.displacements,[{from:old,to:{x:8204,y:80,z:8204}}]);
    assert.ok([8208,8209,8210,8211].some(x => [8206,8207,8208].some(z => /Test passed/.test(rcon(`execute if block ${x} 80 ${z} air`)))));
    console.log('Verified actual displaced food recovery',JSON.stringify({old,landing,actual:bot.entity.position,displacement:80,initialHealth:1,initialFood:16,health:bot.health,food:bot.food,consumedCarrots:consumed,preservedJourneyMoves:saved.foodJourney!.moves,displacementCount:saved.foodJourney!.displacementCount,grantedFoodItems:0}));
  } finally {
    const ended = once(bot,'end'); bot.quit('displaced food recovery validation complete'); await Promise.race([ended,sleep(1000)]);
    rcon(`gamerule naturalRegeneration ${oldRegeneration}`); rcon('forceload remove 8200 8200 8290 8214');
  }
});
