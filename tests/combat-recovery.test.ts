import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { Movements } from 'mineflayer-pathfinder';
import { WorkerLaunchSchema, WorkerMessageSchema, type TaskSpec, type Position } from '../packages/contracts/src';
import { assessCombat, combatEquipment, rangedThreat } from '../packages/minecraft/src/combat-policy';
import { recoveryThreatsClear, retreatFingerprint, safeCombatRoute, safeCombatStand } from '../packages/minecraft/src/combat-retreat';
import {recoverySafe} from '../packages/minecraft/src/death-recovery';
import { safeResourceRoute, safeResourceStand } from '../packages/minecraft/src/resource-recovery';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ActionFailure, ConditionWait } from '../packages/minecraft/src/services';

const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'CombatCheck' }, rules: {} });
function fixture(targetName = 'zombie') {
  const emitter = new EventEmitter(), changes = new Map<string, string>(), slots = Array.from({ length: 46 }, () => null) as ({ name: string; count: number } | null)[];
  let heights = (x: number, _z: number) => 64, forcePath: Vec3[] | undefined, interrupted = false;
  let attacks = 0, moves = 0, pending: (() => void) | undefined, delayMove = false;
  const target = { id: 2, uuid: 'threat-2', name: targetName, type: 'mob', position: new Vec3(2, 64, 0), height: 1.8 } as unknown as Entity;
  const bot = Object.assign(emitter, {
    health: 20, food: 20, entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, game: { dimension: 'overworld' },
    entities: { 2: target } as Record<number, Entity>, players: {}, inventory: { slots, items: () => slots.filter(item => !!item) },
    blockAt(p: Vec3) { const name = changes.get(p.floored().toString()) ?? (p.y < heights(p.x, p.z) ? 'stone' : 'air'); if (name === 'unknown') return null; return { name, stateId: name === 'air' ? 0 : 1, position: p.floored(), boundingBox: ['air', 'water', 'lava', 'fire'].includes(name) ? 'empty' : 'block' }; },
    world: { raycast: (_start: Vec3, _direction: Vec3, _length: number) => null as unknown },
    async equip() {}, async lookAt() {}, activateItem() {}, deactivateItem() {}, clearControlStates() {},
    attack(e: Entity) { attacks++; delete bot.entities[e.id]; emitter.emit('entityDead', e); },
    pathfinder: {
      movements: { canDig: false, allow1by1towers: false },
      getPathTo(_movements: unknown, goal: { x: number; y: number; z: number }) {
        if (forcePath) return { status: 'success', path: forcePath.map(p => ({ ...p, toBreak: [], toPlace: [], parkour: false })) };
        const start = bot.entity.position.floored(), destination = new Vec3(goal.x, goal.y, goal.z), path: Vec3[] = [];
        let p = start;
        for (let count = 0; !p.equals(destination) && count < 100; count++) { const dx = Math.sign(destination.x - p.x), dz = dx ? 0 : Math.sign(destination.z - p.z); const x = p.x + dx, z = p.z + dz; p = new Vec3(x, heights(x, z), z); path.push(p); }
        return { status: p.equals(destination) ? 'success' : 'noPath', path: path.map(p => ({ ...p, toBreak: [], toPlace: [], parkour: false })) };
      },
      async goto(goal: { x: number; y: number; z: number }) { moves++; if (delayMove) await new Promise<void>((_resolve, reject) => { pending = () => reject(new Error('GoalChanged')); }); else bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); },
      setGoal(_goal: unknown) { interrupted = true; pending?.(); },
    },
  });
  const executor = new MineflayerExecutor(bot as unknown as Bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => 'overworld' });
  const services = executor.services(new AbortController().signal); services.pause = async () => {}; services.near = async p => { moves++; bot.entity.position = new Vec3(p.x, p.y, p.z); };
  return { bot: bot as unknown as Bot, raw: bot, executor, services, slots, changes, target, get attacks() { return attacks; }, get moves() { return moves; }, get interrupted() { return interrupted; }, set heights(value: typeof heights) { heights = value; }, set forcePath(value: Vec3[]) { forcePath = value; }, set delayMove(value: boolean) { delayMove = value; } };
}
const assessment = { role: 'builder', health: 20, food: 20, weapon: false, shield: false, enemies: 1, allies: 0, attacked: true, threateningVillage: false, targetName: 'zombie', distance: 2 };

test('a guard holds its ground for an airborne phantom and strikes only an actual swoop in reach',async()=>{
 const f=fixture('phantom'),origin=f.bot.entity.position.clone();f.slots[36]={name:'wooden_sword',count:1};f.target.position=new Vec3(8,72,0);let waits=0;
 f.services.pause=async()=>{if(++waits===3)f.target.position=origin.offset(1,1,0);};
 await f.executor.fightEntity(f.target,f.services);
 assert.equal(f.moves,0);assert.equal(f.attacks,1);assert.ok(waits>=3);assert.ok(f.bot.entity.position.equals(origin));
});

test('stationary phantom defense still obeys target expiry and deteriorating survival conditions',async()=>{
 for(const kind of ['expiry','injury'] as const){
  const f=fixture('phantom');f.slots[36]={name:'wooden_sword',count:1};f.target.position=new Vec3(8,72,0);let valid=true,retreats=0;
  f.services.pause=async()=>{if(kind==='expiry')valid=false;else f.bot.health=5;};
  f.executor.retreat=async()=>{retreats++;throw new ConditionWait('actual cover route required');};
  await assert.rejects(f.executor.fightEntity(f.target,f.services,false,()=>valid),ConditionWait);
  assert.equal(f.moves,0);assert.equal(f.attacks,0);assert.equal(retreats,kind==='injury'?1:0);assert.equal(f.executor.fighting,false);
 }
});

test('recovery admits a distant pillager only behind real cover and immediately revokes it for an exposed or nearby threat',()=>{
 const f=fixture('pillager');f.target.position=new Vec3(15,64,0);
 assert.equal(recoverySafe(f.bot,6),false);f.changes.set(new Vec3(7,65,0).toString(),'stone');f.raw.world.raycast=()=>({position:new Vec3(7,65,0)});
 assert.equal(recoverySafe(f.bot,6),true);f.target.position=new Vec3(10,64,0);assert.equal(recoverySafe(f.bot,6),false);
 f.target.position=new Vec3(15,64,0);f.changes.set(new Vec3(7,65,0).toString(),'air');assert.equal(recoverySafe(f.bot,6),false,'an unverified raycast hit is not cover');
 f.changes.set(new Vec3(7,65,0).toString(),'stone');f.target.name='zombie';assert.equal(recoveryThreatsClear(f.bot,f.bot.entity.position),false);
});

test('ranged combat uses actual worn armor and offhand shield while an unsupported unarmed worker retreats', () => {
  const f = fixture(); f.slots[9] = { name: 'iron_chestplate', count: 1 }; f.slots[10] = { name: 'shield', count: 1 };
  assert.deepEqual(combatEquipment(f.bot), { weapon: false, shield: false, armorPoints: 0 });
  assert.equal(assessCombat(assessment, launch.rules).response, 'retreat');
  assert.equal(assessCombat({ ...assessment, role: 'guard', allies: 4, attacked: false, threateningVillage: true }, launch.rules).response, 'retreat');
  assert.equal(assessCombat({ ...assessment, targetName: 'skeleton' }, launch.rules).response, 'retreat');
  f.slots[36] = { name: 'iron_sword', count: 1 }; f.slots[45] = { name: 'shield', count: 1 };
  assert.equal(assessCombat({ ...assessment, targetName: 'skeleton', ...combatEquipment(f.bot) }, launch.rules).response, 'attack');
  f.slots[45] = null; f.slots[5] = { name: 'iron_helmet', count: 1 }; f.slots[6] = { name: 'iron_chestplate', count: 1 }; f.slots[7] = { name: 'iron_leggings', count: 1 };
  assert.equal(combatEquipment(f.bot).armorPoints, 13); assert.equal(rangedThreat('pillager'), true);
  assert.equal(assessCombat({ ...assessment, targetName: 'skeleton', ...combatEquipment(f.bot), health: 8 }, launch.rules).response, 'retreat');
  assert.equal(assessCombat({ ...assessment, attacked: false, targetName: 'skeleton' }, launch.rules).response, 'ignore');
});

test('a safe endpoint does not authorize routes over lava, unknown cells, gaps or protected construction cells', () => {
  const f = fixture(), destination = new Vec3(6, 64, 0);
  assert.equal(safeCombatRoute(f.bot, destination).safe, true);
  for (const name of ['lava', 'unknown', 'air']) {
    f.changes.set(new Vec3(3, 63, 0).toString(), name);
    assert.equal(safeCombatStand(f.bot, destination), true); assert.equal(safeCombatRoute(f.bot, destination).safe, false);
  }
  f.changes.clear(); assert.equal(safeCombatRoute(f.bot, destination, { protectedPosition: p => p.x === 3 && p.y === 64 }).safe, false);
  assert.equal(safeCombatRoute(f.bot, destination, { protectedPosition: p => p.y === 63 }).safe, true, 'walking over an existing floor never changes it');
});

test('leaving an unsafe edge permits a stable start while every travelled step and unknown or hazardous starting support stay guarded', () => {
  const f = fixture(), destination = new Vec3(2,64,0); delete f.bot.entities[2];
  f.changes.set(new Vec3(-1,63,0).toString(), 'air'); f.changes.set(new Vec3(-1,62,0).toString(), 'air');
  assert.equal(safeCombatRoute(f.bot, destination).safe, false);
  assert.equal(safeCombatRoute(f.bot, destination, { leaveUnsafeEdge: true }).safe, true);
  for (const support of ['unknown', 'lava', 'air', 'gravel']) {
    f.changes.set(new Vec3(0,63,0).toString(), support);
    assert.equal(safeCombatRoute(f.bot, destination, { leaveUnsafeEdge: true }).safe, false);
  }
});

test('public route verification accepts known one-block elevation changes and rejects unverified jumps', () => {
  const f = fixture(); f.heights = x => x >= 3 ? 65 : 64;
  assert.equal(safeCombatRoute(f.bot, { x: 6, y: 65, z: 0 }).safe, true);
  f.forcePath = [new Vec3(6, 65, 0)]; assert.equal(safeCombatRoute(f.bot, { x: 6, y: 65, z: 0 }).safe, false);
});

test('an unsafe shortest path uses real public movement neighbors to find a fully verified detour', () => {
  const registry = minecraftData('1.21.1'), changes = new Map<string, string>();
  const bot = {
    registry, entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {}, game: { minY: -64 },
    inventory: { items: () => [] },
    blockAt(raw: Vec3) {
      const p = raw.floored(); if (Math.abs(p.x) > 10 || Math.abs(p.z) > 10) return null;
      const name = changes.get(p.toString()) ?? (p.y < 64 ? 'stone' : 'air');
      if (name === 'unknown') return null;
      const boundingBox = ['air', 'lava'].includes(name) ? 'empty' : 'block';
      return { name, type: registry.blocksByName[name]!.id, position: p, boundingBox, shapes: boundingBox === 'block' ? [[0,0,0,1,1,1]] : [], getProperties: () => ({}) };
    },
    pathfinder: { movements: {} as Movements, getPathTo: () => ({ status: 'success', path: Array.from({ length: 6 }, (_, i) => ({ x: i + 1, y: 64, z: 0, toBreak: [], toPlace: [], parkour: false })) }) },
  } as unknown as Bot;
  const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 2; movements.infiniteLiquidDropdownDistance = false; movements.scafoldingBlocks = [];
  Object.assign(bot.pathfinder, { movements });
  for (const name of ['air', 'lava', 'unknown']) {
    changes.set(new Vec3(3,63,0).toString(), name); changes.set(new Vec3(3,62,0).toString(), name);
    const route = safeCombatRoute(bot, { x: 6, y: 64, z: 0 }, { radius: 8 });
    assert.equal(route.safe, true, route.reason); assert.ok(route.path.some(p => Math.abs(p.z) >= 2), JSON.stringify({ name, route }));
    assert.ok(route.path.every(p => safeCombatStand(bot, p)), 'every detour cell remains strictly observed and supported');
    const resource = safeResourceRoute(bot,{x:6,y:64,z:0});
    assert.ok(resource?.length);assert.ok(resource.every(p=>safeResourceStand(bot,p,()=>false)));
  }
  assert.equal(safeResourceRoute(bot,{x:6,y:64,z:0},{clear:p=>p.x<3}),undefined,'resource detours preserve the actual threat barrier');
  const blocked = safeCombatRoute(bot, { x: 6, y: 64, z: 0 }, { radius: 8, protectedPosition: p => p.x === 3 });
  assert.equal(blocked.safe, false, 'an alternative cannot cross a protected barrier or reset the bounded search');
});

test('retreat prioritizes real ranged cover and confirms the actual arrived position', async () => {
  const f = fixture('skeleton');
  f.changes.set(new Vec3(-3, 65, -2).toString(), 'stone');
  f.raw.world.raycast = (_start, direction) => direction.z < -0.1 ? { position: new Vec3(-3, 65, -2) } : null;
  await f.executor.retreat(f.target, f.services);
  assert.ok(f.bot.entity.position.z < -2); assert.ok(f.bot.entity.position.distanceTo(f.target.position) >= 8);
  assert.equal((f.services.checkpoint.retreatRecovery as { status: string }).status, 'safe');
  const untouched = fixture(); untouched.services.near = async () => {};
  await assert.rejects(untouched.executor.retreat(untouched.target, untouched.services), ConditionWait);
  const attempts=(untouched.services.checkpoint.retreatRecovery as { attempts: number }).attempts;assert.ok(attempts>0 && attempts<=6,'unsafe candidates may be rejected before using a movement attempt');
});

test('emergency retreat crosses the still-empty reserved building along fixed edge supports while preserving actual protected blocks',async()=>{
  const f=fixture();f.services.checkpoint.buildProtection={origin:{x:-20,y:64,z:-20},width:40,depth:40,height:4};
  for(let x=-10;x<=0;x++){f.changes.set(new Vec3(x,63,-1).toString(),'air');f.changes.set(new Vec3(x,64,1).toString(),'stone');f.changes.set(new Vec3(x,65,1).toString(),'stone');}
  await f.executor.retreat(f.target,f.services);assert.equal((f.services.checkpoint.retreatRecovery as {status:string}).status,'safe');assert.ok(f.bot.entity.position.distanceTo(f.target.position)>=8);assert.equal(f.attacks,0);
  assert.equal(f.changes.get(new Vec3(-5,63,-1).toString()),'air');assert.equal(f.changes.get(new Vec3(-5,64,1).toString()),'stone');
});

test('retreat reaches verified higher ground rather than repeatedly trying same-height endpoints', async () => {
  const f = fixture(); f.heights = x => x < -3 ? 65 : 64;
  await f.executor.retreat(f.target, f.services);
  assert.equal(f.bot.entity.position.y, 65); assert.ok(f.moves > 1);
  assert.equal((f.services.checkpoint.retreatRecovery as { status: string }).status, 'safe');
});

test('retreat checks other actual enemies instead of escaping one attacker into another', async () => {
  const f = fixture('pillager'), other = { id: 3, uuid: 'other-pillager', name: 'pillager', position: new Vec3(-18,64,0) } as unknown as Entity;
  f.bot.entities[3] = other;
  await f.executor.retreat(f.target,f.services);
  assert.ok(f.bot.entity.position.distanceTo(f.target.position) >= 16);
  assert.ok(f.bot.entity.position.distanceTo(other.position) >= 16);
  assert.equal((f.services.checkpoint.retreatRecovery as { status: string }).status,'safe');
});

test('a fresh attack after verified retreat starts from the new safe departure instead of trapping movement in the old radius',async()=>{
  const f=fixture();await f.executor.retreat(f.target,f.services);const first=f.bot.entity.position.floored();f.target.position=first.offset(2,0,0);
  await f.executor.retreat(f.target,f.services);
  const state=f.services.checkpoint.retreatRecovery as {anchor:Position;status:string};
  assert.deepEqual(state.anchor,{x:first.x,y:first.y,z:first.z});assert.equal(state.status,'safe');assert.ok(f.bot.entity.position.distanceTo(first)>8);
});

test('an unarmed retreat keeps the same spent allowance across real arrivals until a pursuing melee threat is outside the work margin',async()=>{
  const f=fixture(),near=f.services.near,start=f.bot.entity.position.floored();
  f.services.near=async(p,radius)=>{
    const before=f.bot.entity.position.clone();await near(p,radius);
    const delta=f.bot.entity.position.minus(f.target.position),travel=before.distanceTo(f.bot.entity.position)*.6;
    if(delta.norm()>travel)f.target.position=f.target.position.plus(delta.scaled(travel/delta.norm()));
  };
  await f.executor.retreat(f.target,f.services);
  const state=f.services.checkpoint.retreatRecovery as {status:string;attempts:number;elapsedMs:number;escapeOrigin:Position;escapeLegs:{from:Position;to:Position}[]};
  assert.equal(state.status,'safe');assert.ok(f.bot.entity.position.distanceTo(f.target.position)>=32);assert.ok(state.attempts>1&&state.attempts<=6);assert.ok(state.elapsedMs<=30000);assert.deepEqual(state.escapeOrigin,{x:start.x,y:start.y,z:start.z});assert.ok(state.escapeLegs.length>0);assert.equal(f.attacks,0);assert.equal(f.changes.size,0);
});

test('a held axe does not reduce an actual creeper escape to the old eight-block gap',async()=>{
  const f=fixture('creeper');f.slots[36]={name:'wooden_axe',count:1};await f.executor.retreat(f.target,f.services);
  assert.equal((f.services.checkpoint.retreatRecovery as {status:string}).status,'safe');assert.ok(f.bot.entity.position.distanceTo(f.target.position)>=32);assert.equal(f.attacks,0);
});

test('a hunt interrupted by a visible archer retreats from that actual hostile instead of the passive animal',async()=>{
  const f=fixture('cow'),enemy={id:3,uuid:'actual-archer',name:'skeleton',type:'mob',position:new Vec3(8,64,0)} as unknown as Entity;f.bot.entities[3]=enemy;
  let escaped:Entity|undefined;
  class Executor extends MineflayerExecutor{override async retreat(target:Entity){escaped=target;throw new ConditionWait('verified escape needs continued recovery');}}
  const executor=new Executor(f.bot,{config:launch.config,rules:launch.rules,world:launch.rules.world,dimension:()=> 'overworld'});
  await assert.rejects(executor.fightEntity(f.target,executor.services(new AbortController().signal),true),ConditionWait);
  assert.equal(escaped?.uuid,enemy.uuid);assert.equal(f.attacks,0);
});

test('a critically hurt armed worker can obtain passive food through a verified ground route without authorizing hostile combat',async()=>{
  const f=fixture('cow');f.raw.health=4;f.raw.food=17;f.target.position=new Vec3(8,64,0);f.slots[36]={name:'wooden_sword',count:1};
  Object.assign(f.raw,{registry:{itemsByName:{beef:{id:1}},items:{1:{name:'beef'}}},findBlock:()=>null,findBlocks:()=>[],recipesAll:()=>[]});
  const attack=f.raw.attack;f.raw.attack=e=>{attack(e);f.slots[37]={name:'beef',count:1};};
  await f.executor.ensureFood(f.services);assert.equal(f.attacks,1);assert.ok(f.moves>0);assert.equal(f.raw.health,4);assert.equal(f.executor.count('beef'),1);
});

test('a critical unarmed worker can harvest a safe passive food animal after losing its tools',async()=>{
  for(const name of ['cow','sheep']){
    const f=fixture(name),item=name==='cow'?'beef':'mutton';f.raw.health=4;f.raw.food=17;f.target.position=new Vec3(8,64,0);
    Object.assign(f.raw,{registry:{itemsByName:{[item]:{id:1}},items:{1:{name:item}}},findBlock:()=>null,findBlocks:()=>[],recipesAll:()=>[]});
    const attack=f.raw.attack;f.raw.attack=e=>{attack(e);f.slots[37]={name:item,count:1};};
    await f.executor.ensureFood(f.services);assert.equal(f.attacks,1);assert.ok(f.moves>0);assert.equal(f.executor.count(item),1);
  }
});

test('a critical unarmed worker recognizes a reachable shore fish as food without entering its water cell',async()=>{
  const f=fixture('cod');f.raw.health=4;f.raw.food=17;f.target.position=new Vec3(1.5,63.5,.5);f.target.height=.3;f.changes.set(new Vec3(1,63,0).toString(),'water');f.forcePath=[];
  Object.assign(f.raw,{registry:{itemsByName:{cod:{id:1}},items:{1:{name:'cod'}}},findBlock:()=>null,findBlocks:()=>[],recipesAll:()=>[]});const attack=f.raw.attack;f.raw.attack=e=>{attack(e);f.slots[37]={name:'cod',count:1};};
  await f.executor.ensureFood(f.services);assert.equal(f.attacks,1);assert.equal(f.moves,0);assert.equal(f.executor.count('cod'),1);assert.equal(f.raw.entity.position.y,64);
});

test('an offshore fish with no reachable dry shore cannot trigger swimming or an attack',async()=>{
  const f=fixture('cod');f.raw.health=4;f.target.position=new Vec3(8.5,63.5,.5);f.slots[36]={name:'wooden_sword',count:1};for(let x=5;x<=11;x++)for(let z=-3;z<=3;z++)f.changes.set(new Vec3(x,63,z).toString(),'water');
  await assert.rejects(f.executor.fightEntity(f.target,f.services,true),ConditionWait);assert.equal(f.attacks,0);assert.equal(f.moves,0);
});

test('a critical unarmed worker harvests a reachable chicken but refuses the same hunt near a hostile',async()=>{
  for(const hostile of [false,true]){
    const f=fixture('chicken');f.raw.health=4;f.raw.food=17;f.target.position=new Vec3(8,64,0);
    Object.assign(f.raw,{registry:{itemsByName:{chicken:{id:1}},items:{1:{name:'chicken'}}},findBlock:()=>null,findBlocks:()=>[],recipesAll:()=>[]});
    const attack=f.raw.attack;f.raw.attack=e=>{attack(e);f.slots[37]={name:'chicken',count:1};};
    if(hostile){f.raw.entities[3]={id:3,name:'zombie',type:'mob',position:new Vec3(9,64,0)} as unknown as Entity;await assert.rejects(f.executor.fightEntity(f.target,f.services,true),ConditionWait);assert.equal(f.attacks,0);}
    else{await f.executor.ensureFood(f.services);assert.equal(f.attacks,1);assert.ok(f.moves>0);assert.equal(f.executor.count('chicken'),1);}
  }
});

test('a critical armed passive hunt cannot cross an unverified dangerous route',async()=>{
  const f=fixture('cow');f.raw.health=4;f.target.position=new Vec3(8,64,0);f.slots[36]={name:'wooden_sword',count:1};f.changes.set(new Vec3(3,63,0).toString(),'lava');
  await assert.rejects(f.executor.fightEntity(f.target,f.services,true),ConditionWait);assert.equal(f.attacks,0);assert.equal(f.moves,0);
});

test('failed retreat preserves bounded probes; clock and own movement do not reopen an exhausted decision', async () => {
  const f = fixture(); f.services.near = async () => { throw new ConditionWait('blocked'); };
  await assert.rejects(f.executor.retreat(f.target, f.services), ConditionWait);
  const state = f.services.checkpoint.retreatRecovery as unknown as { attempts: number; elapsedMs: number; probes: { position: Vec3 }[] };
  assert.ok(state.attempts>0 && state.attempts<=6); assert.ok(state.probes.length <= 64);
  const fingerprint = retreatFingerprint(f.bot, f.services.checkpoint); f.raw.entity.position = new Vec3(1.5, 64, 0.5); state.elapsedMs += 5000;
  assert.equal(retreatFingerprint(f.bot, f.services.checkpoint), fingerprint);
  const before = f.moves; await assert.rejects(f.executor.retreat(f.target, f.services), ConditionWait); assert.equal(f.moves, before);
  const p = state.probes.at(-1)!.position; f.changes.set(new Vec3(p.x, p.y, p.z).toString(), 'water');
  assert.notEqual(retreatFingerprint(f.bot, f.services.checkpoint), fingerprint);
  const message = { protocolVersion: 1, messageId: 'message', sentAt: Date.now(), type: 'task.result', botId: 'b', sessionId: 's', controllerEpoch: 'e', taskId: 't', attemptId: 'a', payload: { outcome: 'condition-wait', observations: [], evidence: [], checkpoint: f.services.checkpoint } };
  // Checkpoint remains plain JSON, including finite budgets and actual probes.
  assert.equal(WorkerMessageSchema.safeParse(message).success, true);
});
test('an actual landing wakes a retreat refused in midair even when its retained probes are distant',()=>{
 const f=fixture(),checkpoint={retreatRecovery:{anchor:{x:0,y:64,z:0},threatId:'threat-2',threatName:'zombie',threatPosition:{x:2,y:64,z:0},attempts:0,elapsedMs:12,probes:[],failed:[],status:'waiting',reason:'unstable starting column'}};
 f.raw.entity.position=new Vec3(.5,65,.5);const airborne=retreatFingerprint(f.bot,checkpoint);
 f.raw.entity.position=new Vec3(.5,64,.5);assert.notEqual(retreatFingerprint(f.bot,checkpoint),airborne);
 const landed=retreatFingerprint(f.bot,checkpoint);f.raw.entity.position=new Vec3(1.5,64,.5);assert.equal(retreatFingerprint(f.bot,checkpoint),landed);
 assert.equal(checkpoint.retreatRecovery.attempts,0);assert.equal(checkpoint.retreatRecovery.elapsedMs,12);
});

test('urgent health changes cancel an in-progress approach before attacking and parent abort remains cancellation', async () => {
  const f = fixture(); f.slots[36] = { name: 'iron_sword', count: 1 }; f.target.position = new Vec3(12, 64, 0); f.delayMove = true;
  const fight = f.executor.fightEntity(f.target, f.services);
  await new Promise(resolve => setImmediate(resolve)); f.bot.health = 5; f.raw.emit('health');
  await assert.rejects(fight, ConditionWait); assert.equal(f.interrupted, true); assert.equal(f.attacks, 0);
  assert.equal(f.bot.listenerCount('health'), 0); assert.equal(f.bot.listenerCount('entityMoved'), 0);
  const aborted = fixture(); aborted.slots[36] = { name: 'iron_sword', count: 1 }; aborted.target.position = new Vec3(12, 64, 0); aborted.delayMove = true;
  const controller = new AbortController(), services = aborted.executor.services(controller.signal), promise = aborted.executor.fightEntity(aborted.target, services);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(promise, e => e instanceof ActionFailure && e.code === 'CANCELLED'); assert.equal(aborted.attacks, 0);
});

test('unknown retreat failures propagate instead of being converted into successful safety or retryable waits', async () => {
  const f = fixture(); f.services.near = async () => { throw new ActionFailure('effects unknown', 'UNCERTAIN', false, false); };
  await assert.rejects(f.executor.retreat(f.target, f.services), e => e instanceof ActionFailure && !e.effectsKnown);
});

test('support fights match exact observed entity and expiry, never another hostile of the same species', async () => {
  const f = fixture(); f.slots[36] = { name: 'iron_sword', count: 1 };
  const params = { supportRequestId: 'support', requesterBotId: 'other', requesterSessionId: 'other-session', targetEntityId: 'different-zombie', targetName: 'zombie', position: { x: 2, y: 64, z: 0 }, world: launch.rules.world, dimension: 'overworld', expiresAt: Date.now() + 10000 };
  const task = { kind: 'fight', params, completion: { kind: 'entity-death', minimum: 1, targetId: 'different-zombie' } } as unknown as TaskSpec;
  await assert.rejects(f.executor.execute(task, f.services), ConditionWait); assert.equal(f.attacks, 0);
  params.targetEntityId = f.target.uuid!; params.expiresAt = Date.now() - 1;
  await assert.rejects(f.executor.execute(task, f.services), ConditionWait); assert.equal(f.attacks, 0);
  params.expiresAt = Date.now() + 10000;
  await f.executor.execute(task, f.services); assert.equal(f.attacks, 1);
  assert.equal(f.services.observations.filter(o => o.kind === 'entity-death').length, 1);
});

test('reused numeric entity IDs cannot redirect a fight or confirm another entity death', async () => {
  const f = fixture(); f.slots[36] = { name: 'iron_sword', count: 1 };
  f.raw.lookAt = async () => { f.raw.entities[2] = { ...f.target, uuid: 'replacement-zombie' } as Entity; f.raw.emit('entityDead', f.raw.entities[2]); };
  await assert.rejects(f.executor.fightEntity(f.target, f.services), ConditionWait);
  assert.equal(f.attacks, 0); assert.equal(f.services.observations.some(o => o.kind === 'entity-death'), false);
});
