import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Movements, pathfinder, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { BotInputSchema, RulesSchema } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { combatEquipment, assessCombat } from '../packages/minecraft/src/combat-policy';
import { safeCombatRoute, safeCombatStand } from '../packages/minecraft/src/combat-retreat';
import { safeResourceRoute, safeResourceStand } from '../packages/minecraft/src/resource-recovery';
import { ConditionWait } from '../packages/minecraft/src/services';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, seconds = 10) { const end = Date.now() + seconds * 1000; while (!predicate() && Date.now() < end) await delay(100); assert.ok(predicate(), 'Timed out waiting for actual validation observations.'); }

test('unarmed ranged defense leaves a stable cliff edge along actual higher ground into observed cover without terrain changes', { timeout: 100000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  assert.equal(rcon('list').includes('LayaCombatCheck'), false);
  rcon('forceload add 1888 1888 1952 1952');
  rcon('fill 1888 80 1888 1919 91 1952 air'); rcon('fill 1920 80 1888 1952 91 1952 air');
  rcon('fill 1888 77 1888 1952 79 1952 stone');
  rcon('fill 1888 80 1888 1915 80 1952 stone');
  rcon('fill 1916 80 1904 1916 84 1936 stone_bricks');
  rcon('setblock 1920 79 1919 air'); rcon('setblock 1920 78 1919 air');
  rcon('kill @e[type=!player,x=1888,y=77,z=1888,dx=64,dy=16,dz=64]');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaCombatCheck', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn');
    rcon('tp LayaCombatCheck 1920.5 80 1920.5'); rcon('clear LayaCombatCheck');
    rcon('effect give LayaCombatCheck minecraft:instant_health 1 10 true'); rcon('effect give LayaCombatCheck minecraft:saturation 1 10 true');
    await waitFor(() => bot.health === 20 && bot.food === 20 && bot.entity.position.distanceTo(new Vec3(1920.5, 80, 1920.5)) < 0.1 && !!bot.blockAt(new Vec3(1902, 80, 1920)));
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 2; movements.infiniteLiquidDropdownDistance = false;
    bot.pathfinder.setMovements(movements);
    rcon('summon skeleton 1922.5 80 1920.5 {NoAI:1b,Silent:1b,Invulnerable:1b,PersistenceRequired:1b}');
    await waitFor(() => Object.values(bot.entities).some(entity => entity.name === 'skeleton' && entity.position.distanceTo(bot.entity.position) < 4));
    const target = Object.values(bot.entities).find(entity => entity.name === 'skeleton' && entity.position.distanceTo(bot.entity.position) < 4)!;
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', autonomyEnabled: false }), { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaCombatCheck' });
    const equipment = combatEquipment(bot);
    assert.equal(equipment.weapon, false); assert.equal(equipment.shield, false);
    assert.equal(assessCombat({ role: 'builder', health: bot.health, food: bot.food, ...equipment, enemies: 1, allies: 0, attacked: true, threateningVillage: false, targetName: 'skeleton', distance: bot.entity.position.distanceTo(target.position) }, rules).response, 'retreat');
    const executor = new MineflayerExecutor(bot, { world: rules.world, dimension: () => 'overworld', config, rules });
    const services = executor.services(AbortSignal.timeout(60000)), start = bot.entity.position.clone();
    assert.equal(safeCombatStand(bot, start), false, 'a real adjacent drop must not prevent leaving stable current support');
    await assert.rejects(executor.fightEntity(target, services), error => error instanceof ConditionWait && /지원과 회복/.test(error.message));
    const actual = bot.entity.position, recovery = services.checkpoint.retreatRecovery as { status: string; attempts: number; elapsedMs: number; probes: { position: { x: number; y: number; z: number }; name: string }[] };
    assert.equal(recovery.status, 'safe', JSON.stringify(services.checkpoint)); assert.ok(recovery.attempts <= 6);
    assert.ok(actual.distanceTo(start) >= 6); assert.equal(Math.floor(actual.y), 81); assert.ok(actual.x < 1916);
    assert.ok(actual.distanceTo(target.position) >= 8); assert.equal(safeCombatStand(bot, actual), true);
    const eye = target.position.offset(0, 1.6, 0), delta = actual.offset(0, 1.5, 0).minus(eye);
    assert.ok(bot.world.raycast(eye, delta.scaled(1 / delta.norm()), delta.norm() - 0.3), 'actual solid cover must block the ranged line of sight');
    for (const p of [new Vec3(1916, 80, 1904), new Vec3(1916, 84, 1920), new Vec3(1902, 80, 1920), new Vec3(1920, 79, 1920)]) assert.ok(bot.blockAt(p)?.boundingBox === 'block');
    assert.equal(bot.inventory.items().length, 0);
    assert.equal(bot.blockAt(new Vec3(1920,79,1919))?.name, 'air', 'retreat walks without filling the original drop');
    console.log('Verified actual bounded combat retreat', JSON.stringify({ start, actual, threat: target.position, health: bot.health, food: bot.food, actualCover: true, status: recovery.status, attempts: recovery.attempts, elapsedMs: recovery.elapsedMs, probeCount: recovery.probes.length, probes: recovery.probes.slice(0, 3) }));
  } finally { bot.quit('combat validation complete'); await delay(200); rcon('kill @e[type=skeleton,x=1888,y=77,z=1888,dx=64,dy=16,dz=64]'); rcon('forceload remove 1888 1888 1952 1952'); }
});

test('actual walking detours around a hazardous shortest route without changing the pit or library methods', { timeout: 60000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  rcon('forceload add 7104 7104 7152 7136');
  rcon('fill 7104 80 7104 7152 86 7136 air'); rcon('fill 7104 76 7104 7152 79 7136 stone');
  rcon('fill 7125 77 7121 7125 79 7121 air');
  rcon('kill @e[type=!player,x=7104,y=76,z=7104,dx=48,dy=12,dz=32]');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaDetourCheck', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn'); rcon('tp LayaDetourCheck 7120.5 80 7120.5'); rcon('clear LayaDetourCheck');
    await waitFor(() => bot.entity.position.distanceTo(new Vec3(7120.5,80,7120.5)) < 0.1 && !!bot.blockAt(new Vec3(7130,80,7120)));
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 2; movements.infiniteLiquidDropdownDistance = false; movements.scafoldingBlocks = [];
    bot.pathfinder.setMovements(movements);
    const target = { x: 7130, y: 80, z: 7120 }, raw = bot.pathfinder.getPathTo(movements, new goals.GoalNear(target.x,target.y,target.z,0),200);
    assert.equal(raw.status, 'success'); assert.ok(raw.path.some(p => !safeCombatStand(bot,p)), 'the real shortest path must cross a cell beside the observed deep pit');
    const route = safeCombatRoute(bot,target);
    assert.equal(route.safe,true,route.reason); assert.ok(route.reason.includes('우회')); assert.ok(route.path.every(p => safeCombatStand(bot,p)));
    const resource = safeResourceRoute(bot,target);assert.ok(resource?.length);assert.ok(resource.every(p=>safeResourceStand(bot,p,()=>false)));
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', autonomyEnabled: false }), { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaDetourCheck' });
    const executor = new MineflayerExecutor(bot,{world:rules.world,dimension:()=> 'overworld',config,rules}), services=executor.services(AbortSignal.timeout(45000));
    services.checkpoint.safeDetourRequired=true;
    await services.near(new Vec3(target.x+0.5,target.y,target.z+0.5),0);
    assert.ok(bot.entity.position.distanceTo(new Vec3(7130.5,80,7120.5)) < 0.6); assert.equal(safeCombatStand(bot,bot.entity.position),true);
    assert.equal(bot.blockAt(new Vec3(7125,79,7121))?.name,'air'); assert.equal(bot.blockAt(new Vec3(7125,77,7121))?.name,'air'); assert.equal(bot.inventory.items().length,0);
    console.log('Verified actual safe detour',JSON.stringify({actual:bot.entity.position,steps:route.path.length,shortestSteps:raw.path.length,pitUnchanged:true}));
  } finally { bot.quit('detour validation complete'); await delay(200); rcon('forceload remove 7104 7104 7152 7136'); }
});

test('an unarmed bot escapes a real pursuing melee mob through a continuously verified corridor', { timeout: 60000 }, async () => {
  assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
  rcon('forceload add 7584 7584 7824 7824');
  for(let x=7584;x<=7824;x+=12){rcon(`fill ${x} 80 7584 ${Math.min(7824,x+11)} 88 7824 air`);rcon(`fill ${x} 77 7584 ${Math.min(7824,x+11)} 79 7824 stone`);}
  rcon('kill @e[type=!player,x=7584,y=77,z=7584,dx=240,dy=12,dz=240]');
  const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaPursuitCheck',auth:'offline'});bot.loadPlugin(pathfinder);
  const pursuitTag=`laya_pursuit_${process.pid}_${Date.now()}`;
  try{
    await once(bot,'spawn');rcon('gamemode survival LayaPursuitCheck');rcon('tp LayaPursuitCheck 7704.5 80 7704.5');rcon('clear LayaPursuitCheck');rcon('effect give LayaPursuitCheck minecraft:instant_health 1 10 true');rcon('effect give LayaPursuitCheck minecraft:saturation 1 10 true');
    await waitFor(()=>bot.entity.position.distanceTo(new Vec3(7704.5,80,7704.5))<.1&&bot.health===20&&bot.food===20);
    const original=new Movements(bot);original.canDig=false;original.allow1by1towers=false;original.allowParkour=false;original.maxDropDown=2;original.infiniteLiquidDropdownDistance=false;original.scafoldingBlocks=[];bot.pathfinder.setMovements(original);
    rcon(`summon husk 7708.5 80 7704.5 {Tags:["${pursuitTag}"],PersistenceRequired:1b,Invulnerable:1b,Silent:1b,IsBaby:0b}`);await waitFor(()=>Object.values(bot.entities).some(e=>e.name==='husk'&&Math.abs(e.position.y-80)<1&&e.position.distanceTo(bot.entity.position)<6));
    const threat=Object.values(bot.entities).find(e=>e.name==='husk'&&Math.abs(e.position.y-80)<1&&e.position.distanceTo(bot.entity.position)<6)!,before=threat.position.clone();
    await waitFor(()=>bot.health<20,10);
    const start=bot.entity.position.clone(),startHealth=bot.health;
    const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaPursuitCheck'}),executor=new MineflayerExecutor(bot,{world:rules.world,dimension:()=> 'overworld',config,rules});
    const services=executor.services(AbortSignal.timeout(45000),{buildProtection:{origin:{x:7680,y:80,z:7680},width:49,depth:49,height:4}});await executor.retreat(threat,services);
    const serverPosition=(name:string)=>{const raw=rcon(`data get entity ${name} Pos`),match=raw.match(/\[(-?\d+(?:\.\d+)?)[dD]?,\s*(-?\d+(?:\.\d+)?)[dD]?,\s*(-?\d+(?:\.\d+)?)[dD]?\]/);assert.ok(match,raw);return new Vec3(Number(match[1]),Number(match[2]),Number(match[3]));};
    const actual=serverPosition('LayaPursuitCheck'),actualThreat=serverPosition(`@e[type=husk,tag=${pursuitTag},limit=1]`);
    assert.equal((services.checkpoint.retreatRecovery as {status:string}).status,'safe');assert.ok(actual.distanceTo(actualThreat)>=32,'the actual pursuing mob must leave a useful work and recovery margin');assert.ok(actual.distanceTo(new Vec3(bot.entity.position.x,bot.entity.position.y,bot.entity.position.z))<1.5,'the server confirms the client arrival');assert.ok(startHealth<20,'the real survival player must actually be hit before escaping');assert.ok(bot.health>6);assert.equal(bot.inventory.items().length,0);assert.equal(bot.pathfinder.movements,original,'public movement configuration is restored');
    console.log('Verified real pursuit escape',JSON.stringify({start,actual,threatStart:before,threat:actualThreat,startHealth,health:bot.health,elapsedMs:(services.checkpoint.retreatRecovery as {elapsedMs:number}).elapsedMs}));
  }finally{bot.quit('pursuit validation complete');await delay(200);rcon('kill @e[type=husk,x=7584,y=77,z=7584,dx=240,dy=12,dz=240]');rcon('forceload remove 7584 7584 7824 7824');}
});
