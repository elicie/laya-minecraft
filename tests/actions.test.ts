import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, type TaskSpec } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ActionFailure, ConditionWait } from '../packages/minecraft/src/services';
import { preserveMaterialWait } from '../packages/minecraft/src/material-wait';
import {foodRecoveryFingerprint} from '../packages/minecraft/src/worker-recovery';

function options() {
  const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'ActionBot' }, rules: {} });
  return { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => 'overworld' };
}

test('an unarmored night food search holds when no shelter is usable and wakes on daylight without a new search budget',async()=>{
 const f=woodRecipeFixture(['oak']),clock={isDay:false,timeOfDay:13000,doDaylightCycle:true};Object.assign(f.bot,{health:20,food:17,time:clock});
 class NoShelter extends MineflayerExecutor{override async shelterAtNight(){return false;}}
 const e=new NoShelter(f.bot as unknown as Bot,options()),s=e.services(new AbortController().signal, {resourceRecovery:{$food:{destinationsUsed:5}}});
 await assert.rejects(e.ensureFood(s),ConditionWait);assert.equal(f.dug.length,0);assert.equal(s.checkpoint.nightShelterUnavailable,true);assert.deepEqual(s.checkpoint.resourceRecovery,{$food:{destinationsUsed:5}});
 const knowledge={blocks:new Map()},before=foodRecoveryFingerprint(f.bot as unknown as Bot,s.checkpoint,6,knowledge);clock.timeOfDay=14000;assert.equal(foodRecoveryFingerprint(f.bot as unknown as Bot,s.checkpoint,6,knowledge),before);clock.isDay=true;clock.timeOfDay=0;assert.notEqual(foodRecoveryFingerprint(f.bot as unknown as Bot,s.checkpoint,6,knowledge),before);
});

test('user construction defaults to bounded material trips and preserves saved search consumption',async()=>{
 for(const setting of [undefined,true,false]){
  const f=woodRecipeFixture([]),task:TaskSpec={id:'build',goalId:'build',source:'user',kind:'build',params:setting===undefined?{}:{materialExpedition:setting},completion:{kind:'blocks',blocks:[{position:{x:3,y:64,z:3},name:'cobblestone'}]},dependencies:[],reservationKeys:[]};
  const executor=new MineflayerExecutor(f.bot as unknown as Bot,{...options(),villageTask:async(_task,s)=>({outcome:'completed',observations:s.observations,evidence:s.evidence,checkpoint:s.checkpoint})});
  const s=executor.services(new AbortController().signal,{resourceRecovery:{sand:{destinationsUsed:5,elapsedMs:60000}}});await executor.execute(task,s);
  assert.equal(s.checkpoint.materialExpedition,setting===false?undefined:true);assert.deepEqual(s.checkpoint.resourceRecovery,{sand:{destinationsUsed:5,elapsedMs:60000}});
 }
});

function navigation(bot: object, sources: Vec3[] = []) {
  const b = bot as { entity: { position: Vec3 }; blockAt(p: Vec3): { name: string; boundingBox?: string }; };
  Object.assign(bot, { canSeeBlock: () => true, findBlocks: (request: { matching(block: unknown): boolean }) => sources.filter(p => request.matching(b.blockAt(p))), pathfinder: {
    movements: { canDig: false, allow1by1towers: false }, getPathTo(_movements: unknown, goal: { x: number; y: number; z: number }) {
      const start = b.entity.position.floored(), target = new Vec3(goal.x, goal.y, goal.z), queue = [start], previous = new Map<string, Vec3 | null>([[start.toString(), null]]);
      let found: Vec3 | undefined;
      for (let index = 0; index < queue.length && index < 10000; index++) {
        const current = queue[index]; if (current.equals(target)) { found = current; break; }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = current.offset(dx!, 0, dz!);
          if (previous.has(next.toString()) || Math.abs(next.x - start.x) > 50 || Math.abs(next.z - start.z) > 50 || b.blockAt(next).boundingBox !== 'empty' || b.blockAt(next.offset(0, 1, 0)).boundingBox !== 'empty' || b.blockAt(next.offset(0, -1, 0)).boundingBox !== 'block') continue;
          previous.set(next.toString(), current); queue.push(next);
        }
      }
      const path = [];
      while (found && !found.equals(start)) { path.unshift({ x: found.x, y: found.y, z: found.z, toBreak: [], toPlace: [], parkour: false }); found = previous.get(found.toString())!; }
      return { status: previous.has(target.toString()) ? 'success' : 'noPath', path };
    },
  } });
}

function woodRecipeFixture(observed: string[], initial: Record<string, number> = {}) {
  const woods = ['cherry', 'oak', 'birch'], names = [...woods.flatMap(wood => [`${wood}_log`, `${wood}_planks`]), 'stick', 'crafting_table', 'wooden_pickaxe', 'furnace', 'sand', 'glass', 'coal', 'charcoal','wooden_sword','stone_sword','cobblestone'];
  const ids = Object.fromEntries(names.map((name, index) => [name, index + 1]));
  const stock = new Map(Object.entries(initial)), cells = new Map<string, string>(), locations: Vec3[] = [];
  const crafted: string[] = [], dug: string[] = [];
  let held = '', blockedWood = '', failCraft = false, queries = 0;
  const recipe = (output: string, count: number, ingredients: Record<string, number>, requiresTable = false) => ({ requiresTable, result: { id: ids[output], count }, delta: [...Object.entries(ingredients).map(([item, quantity]) => ({ id: ids[item], count: -quantity })), { id: ids[output], count }] });
  const recipes = new Map<number, ReturnType<typeof recipe>[]>();
  for (const wood of woods) recipes.set(ids[`${wood}_planks`], [recipe(`${wood}_planks`, 4, { [`${wood}_log`]: 1 })]);
  recipes.set(ids.stick, woods.map(wood => recipe('stick', 4, { [`${wood}_planks`]: 2 })));
  recipes.set(ids.crafting_table, woods.map(wood => recipe('crafting_table', 1, { [`${wood}_planks`]: 4 })));
  recipes.set(ids.wooden_pickaxe, woods.map(wood => recipe('wooden_pickaxe', 1, { [`${wood}_planks`]: 3, stick: 2 }, true)));
  recipes.set(ids.wooden_sword,woods.map(wood=>recipe('wooden_sword',1,{[`${wood}_planks`]:2,stick:1},true)));
  recipes.set(ids.stone_sword,[recipe('stone_sword',1,{cobblestone:2,stick:1},true)]);
  for (const wood of observed) for (let i = 0; i < 8; i++) {
    const p = new Vec3(10 + i, 64, woods.indexOf(wood) * 6);
    cells.set(p.toString(), `${wood}_log`); cells.set(p.offset(0, 1, 0).toString(), `${wood}_leaves`); locations.push(p);
  }
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, world: { raycast: () => null },
    inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: ids[name] })), emptySlotCount: () => 36 },
    registry: { itemsByName: Object.fromEntries(names.map(name => [name, { id: ids[name] }])), items: Object.fromEntries(names.map(name => [ids[name], { name }])) },
    blockAt(p: Vec3) { const name = cells.get(p.toString()) ?? (p.y === 63 ? 'dirt' : 'air'); return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true, getProperties: () => ({}) }; },
    findBlock(request: { matching: (block: unknown) => boolean; useExtraInfo?: (block: unknown) => boolean }) {
      queries++;
      for (const p of [...locations].sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position))) { const block = bot.blockAt(p); if (request.matching(block) && (!request.useExtraInfo || request.useExtraInfo(block))) return block; }
      return null;
    },
    recipesAll(id: number) { return recipes.get(id) ?? []; },
    recipesFor(id: number, _metadata: unknown, _count: number, table: unknown) { return this.recipesAll(id).filter(r => (!r.requiresTable || table) && r.delta.filter(i => i.count < 0).every(i => (stock.get(names[i.id - 1]) ?? 0) >= -i.count)); },
    async equip(item: { name: string }) { held = item.name; },
    async placeBlock(reference: { position: Vec3 }, face: Vec3) { const p = reference.position.plus(face); locations.push(p); cells.set(p.toString(), held); stock.set(held, (stock.get(held) ?? 0) - 1); },
    async dig(block: { name: string; position: Vec3 }) { dug.push(block.name); cells.set(block.position.toString(), 'air'); stock.set(block.name, (stock.get(block.name) ?? 0) + 1); },
    async craft(r: ReturnType<typeof recipe>) {
      if (failCraft) throw new ActionFailure('제작 응답이 확인되지 않았습니다.', 'CRAFT_UNCERTAIN', false, false);
      assert.ok(r.delta.filter(i => i.count < 0).every(i => (stock.get(names[i.id - 1]) ?? 0) >= -i.count));
      for (const delta of r.delta) stock.set(names[delta.id - 1], (stock.get(names[delta.id - 1]) ?? 0) + delta.count);
      crafted.push(names[r.result.id - 1]);
    },
  };
  navigation(bot, locations);
  const executor = new MineflayerExecutor(bot as unknown as Bot, options()), services = executor.services(new AbortController().signal);
  services.pause = async () => {};
  services.near = async p => { if (blockedWood && locations.some(q => bot.blockAt(q).name === `${blockedWood}_log` && q.distanceTo(new Vec3(p.x, p.y, p.z)) < 4)) throw new ConditionWait('NoPath'); bot.entity.position = new Vec3(p.x, p.y, p.z); };
  return { executor, services, bot, stock, cells, locations, crafted, dug, get queries() { return queries; }, set blockedWood(value: string) { blockedWood = value; }, set failCraft(value: boolean) { failCraft = value; } };
}

test('inventory recipes ignore an observed worktable and mixed held wood funds the whole pickaxe without a species expedition',async()=>{
  const f=woodRecipeFixture([],{birch_planks:4,oak_log:1});f.services.checkpoint.materialExpedition=true;const p=new Vec3(-2,64,0);f.cells.set(p.toString(),'crafting_table');f.locations.push(p);
  await f.executor.ensureItem('wooden_pickaxe',1,f.services);assert.equal(f.stock.get('wooden_pickaxe'),1);assert.equal(f.stock.get('wooden_sword'),1);assert.equal(f.dug.length,0);assert.ok(f.crafted.indexOf('stick')<f.crafted.indexOf('wooden_pickaxe'));
  const inventory=woodRecipeFixture([],{oak_log:2});inventory.cells.set(p.toString(),'crafting_table');inventory.locations.push(p);inventory.services.near=async()=>{assert.fail('planks use the public inventory crafting grid');};
  const craft=inventory.bot.craft.bind(inventory.bot);inventory.bot.craft=async(r,_count?:number,table?:unknown)=>{assert.equal(table,undefined);await craft(r);};await inventory.executor.ensureItem('oak_planks',8,inventory.services);assert.equal(inventory.stock.get('oak_planks'),8);
});

test('an unprotected night material expedition waits without spending its search, then actual daylight permits the held goal',async()=>{
  const f=woodRecipeFixture(['oak']);Object.assign(f.bot,{time:{isDay:false,doDaylightCycle:true}});f.services.checkpoint.materialExpedition=true;f.services.checkpoint.confirmedRecoveryDeathId='actual-death';
  const budget={destinationsUsed:5,elapsedMs:60000};f.services.checkpoint.resourceRecovery={cobblestone:budget};
  await assert.rejects(f.services.ensureItem('oak_planks',8),error=>{assert.ok(error instanceof ConditionWait);assert.equal((preserveMaterialWait(f.services,'oak_planks',error).checkpoint.waitingFor as {watchDaylight:boolean}).watchDaylight,true);return true;});
  assert.equal(f.dug.length,0);assert.equal(f.crafted.length,0);assert.deepEqual((f.services.checkpoint.resourceRecovery as Record<string,unknown>).cobblestone,budget);
  Object.assign(f.bot,{time:{isDay:true,doDaylightCycle:true}});await f.services.ensureItem('oak_planks',8);assert.equal(f.stock.get('oak_planks'),8);assert.equal(f.dug.length,2);assert.deepEqual((f.services.checkpoint.resourceRecovery as Record<string,unknown>).cobblestone,budget);
});

test('night material policy still crafts and returns actually held raw stock without another resource expedition',async()=>{
  const f=woodRecipeFixture([],{oak_log:2});Object.assign(f.bot,{time:{isDay:false,doDaylightCycle:true}});f.services.checkpoint.materialExpedition=true;f.services.checkpoint.confirmedRecoveryDeathId='actual-death';
  await f.services.ensureItem('oak_planks',8);assert.equal(f.stock.get('oak_planks'),8);assert.equal(f.dug.length,0);
});

test('a new unarmored collector reserves daylight for the actual long return before dusk',async()=>{
  const f=woodRecipeFixture(['oak']);Object.assign(f.bot,{time:{isDay:true,timeOfDay:7000,doDaylightCycle:true}});f.services.checkpoint.materialExpedition=true;
  f.services.checkpoint.resourceTrip={item:'oak_planks',minimum:8,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0},{x:500,y:64,z:0}],phase:'outbound',returns:0};
  await assert.rejects(f.executor.ensureItem('oak_planks',8,f.services),ConditionWait);
  assert.equal(f.dug.length,0);assert.equal((f.services.checkpoint.resourceReturnDeadline as {threshold:number}).threshold,6000);
});

test('a blocked physical utility return cannot start a different wood expedition as a recipe fallback',async()=>{
  const f=woodRecipeFixture([],{oak_log:2});f.services.checkpoint.materialExpedition=true;
  const p=new Vec3(-2,64,0);f.cells.set(p.toString(),'crafting_table');f.locations.push(p);
  const wait=new ConditionWait('actual return blocked');let visits=0;
  f.services.near=async()=>{visits++;f.services.checkpoint.resourceTrip={item:'cobblestone',minimum:8,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0}],phase:'returning',returns:0};throw wait;};
  await assert.rejects(f.executor.ensureItem('wooden_pickaxe',1,f.services),error=>error===wait);assert.equal(visits,1);assert.equal(f.dug.length,0);assert.ok(!f.crafted.includes('wooden_pickaxe'));
});

test('a physical utility return reselects the nearby worktable instead of walking back to the forest table',async()=>{
  const f=woodRecipeFixture([],{oak_planks:3,stick:2});f.services.checkpoint.materialExpedition=true;
  for(const p of [new Vec3(20,64,1),new Vec3(-2,64,0)]){f.cells.set(p.toString(),'crafting_table');f.locations.push(p);}
  f.bot.entity.position=new Vec3(20.5,64,.5);
  f.services.checkpoint.resourceTrip={item:'cobblestone',minimum:8,home:{x:0,y:64,z:0},trail:[{x:0,y:64,z:0},{x:10,y:64,z:0},{x:20,y:64,z:0}],phase:'outbound',returns:0};
  const near=f.services.near;f.services.near=async(p,r)=>{if(f.services.checkpoint.resourceTrip&&typeof f.services.checkpoint.resourceTrip==='object'&&!Array.isArray(f.services.checkpoint.resourceTrip)&&f.services.checkpoint.resourceTrip.returns===1)assert.ok(p.x<=0,'after the real home arrival, crafting must use its nearer table');await near(p,r);};
  await f.executor.ensureItem('wooden_pickaxe',1,f.services);assert.equal(f.stock.get('wooden_pickaxe'),1);assert.equal(f.dug.length,0);
});

test('empty inventory builds a crafting table and pickaxe from observed oak or birch despite a cherry-first recipe order', async () => {
  for (const wood of ['oak', 'birch']) {
    const f = woodRecipeFixture([wood]);
    f.services.checkpoint.missingResource = 'cherry_log'; f.services.checkpoint.resourceNames = ['cherry_log'];
    await f.executor.ensureItem('wooden_pickaxe', 1, f.services);
    assert.equal(f.stock.get('wooden_pickaxe'), 1); assert.ok(f.crafted.includes('crafting_table'));
    assert.ok(f.dug.length > 0); assert.ok(f.dug.every(name => name === `${wood}_log`));
    assert.equal(f.services.checkpoint.missingResource, undefined); assert.equal(f.services.checkpoint.resourceNames, undefined);
    assert.ok(f.queries < 100, 'the shared read-only source cache must bound repeated wood probes');
  }
});

test('material expedition utility crafting scouts actual available wood before selecting a speculative tree species',async()=>{
  const f=woodRecipeFixture(['oak']);f.services.checkpoint.materialExpedition=true;f.services.checkpoint.resourceExpedition=true;
  await f.executor.ensureItem('crafting_table',1,f.services);
  assert.equal(f.stock.get('crafting_table'),1);assert.deepEqual(f.dug,['oak_log']);
  const records=f.services.checkpoint.resourceRecovery as Record<string,{status:string}>;
  assert.equal(records.$utility_wood!.status,'found');assert.equal(records.cherry_log,undefined);
});

test('an empty material tool bootstrap gathers the shared table, head and stick wood before the first crafting call',async()=>{
  const f=woodRecipeFixture(['oak']);f.services.checkpoint.materialExpedition=true;f.services.checkpoint.resourceExpedition=true;
  const craft=f.bot.craft;let first=true;f.bot.craft=async r=>{if(first){first=false;assert.equal(f.stock.get('oak_log'),3,'one log cannot simultaneously fund table, head and sticks');}await craft(r);};
  await f.executor.ensureItem('wooden_pickaxe',1,f.services);
  assert.equal(f.stock.get('wooden_pickaxe'),1);assert.equal(f.stock.get('wooden_sword'),1);assert.equal(f.dug.length,3);
});

test('a material pickaxe uses reachable wood before choosing a species even with an existing table',async()=>{
  const f=woodRecipeFixture(['cherry','oak']);f.services.checkpoint.materialExpedition=true;f.services.checkpoint.resourceExpedition=true;
  for(const p of [...f.locations])if(f.cells.get(p.toString())==='cherry_log'){
    f.cells.set(p.toString(),'air');f.cells.set(p.offset(0,1,0).toString(),'air');
    const high=p.offset(0,8,0);f.cells.set(high.toString(),'cherry_log');f.cells.set(high.offset(0,1,0).toString(),'cherry_leaves');f.locations.push(high);
  }
  const table=new Vec3(-2,64,0);f.cells.set(table.toString(),'crafting_table');f.locations.push(table);
  await f.executor.ensureItem('wooden_pickaxe',1,f.services);
  assert.equal(f.stock.get('wooden_pickaxe'),1);assert.ok(f.dug.length>0);assert.ok(f.dug.every(name=>name==='oak_log'));assert.ok(!f.crafted.includes('crafting_table'));
  const records=f.services.checkpoint.resourceRecovery as Record<string,unknown>;assert.equal(records.cherry_log,undefined);
});

test('wood picked up during a scouting move immediately ends utility exploration and is crafted',async()=>{
  const f=woodRecipeFixture([]);f.services.checkpoint.materialExpedition=true;f.services.checkpoint.resourceExpedition=true;
  const near=f.services.near;let moves=0;f.services.near=async(p,r)=>{assert.ok(++moves<=1,'actual sufficient stock must end exploration');await near(p,r);f.stock.set('oak_log',1);};
  await f.executor.ensureItem('crafting_table',1,f.services);
  assert.equal(moves,1);assert.equal(f.stock.get('crafting_table'),1);assert.equal(f.dug.length,0);
});

for(const stone of [false,true])test(`material tool preparation crafts a ${stone?'stone':'wooden'} sword only from already held spare ingredients`,async()=>{
  const f=woodRecipeFixture([],{oak_planks:5,stick:3,...(stone?{cobblestone:2}:{})});f.services.checkpoint.materialExpedition=true;
  const table=new Vec3(-2,64,0);f.cells.set(table.toString(),'crafting_table');f.locations.push(table);
  await f.executor.ensureItem('wooden_pickaxe',1,f.services);
  assert.equal(f.stock.get('wooden_pickaxe'),1);assert.equal(f.stock.get(stone?'stone_sword':'wooden_sword'),1);assert.equal(f.dug.length,0);assert.equal(f.crafted.length,2);
});

test('missing spare ingredients and missing fight permission do not start weapon gathering',async()=>{
  for(const permitted of [false,true]){
    const f=woodRecipeFixture([],{oak_planks:permitted?3:5,stick:permitted?2:3});f.services.checkpoint.materialExpedition=true;
    if(!permitted)f.executor.options.config.allowedActions=f.executor.options.config.allowedActions.filter(action=>action!=='fight');
    const table=new Vec3(-2,64,0);f.cells.set(table.toString(),'crafting_table');f.locations.push(table);
    await f.executor.ensureItem('wooden_pickaxe',1,f.services);assert.equal(f.stock.get('wooden_pickaxe'),1);assert.equal(f.stock.get('wooden_sword'),undefined);assert.deepEqual(f.crafted,['wooden_pickaxe']);assert.equal(f.dug.length,0);
  }
});

test('a few planks of a missing species cannot outrank a complete nearby recipe using held logs',async()=>{
  const f=woodRecipeFixture([],{birch_planks:2,oak_log:2,stick:4});f.services.checkpoint.materialExpedition=true;f.services.checkpoint.resourceExpedition=true;
  const table=new Vec3(-2,64,0);f.cells.set(table.toString(),'crafting_table');f.locations.push(table);
  const near=f.services.near;f.services.near=async(p,r)=>{assert.equal(p.x,table.x,'the held wood must not trigger a new tree expedition');await near(p,r);};
  await f.executor.ensureItem('wooden_pickaxe',1,f.services);
  assert.equal(f.stock.get('wooden_pickaxe'),1);assert.ok(f.crafted.includes('oak_planks'));assert.ok(!f.crafted.includes('birch_planks'));assert.equal(f.dug.length,0);
});

test('recipe selection uses inventory first and known preparation failures can choose another observed wood', async () => {
  const stocked = woodRecipeFixture(['oak'], { birch_planks: 16 });
  await stocked.executor.ensureItem('wooden_pickaxe', 1, stocked.services);
  assert.equal(stocked.stock.get('wooden_pickaxe'), 1); assert.deepEqual(stocked.dug, []);
  const blocked = woodRecipeFixture(['oak', 'birch']); blocked.blockedWood = 'oak';
  await blocked.executor.ensureItem('wooden_pickaxe', 1, blocked.services);
  assert.equal(blocked.stock.get('wooden_pickaxe'), 1); assert.ok(blocked.dug.every(name => name === 'birch_log'));
});

test('glass smelting uses actual stocked or naturally obtainable birch fuel without requiring oak', async () => {
  for (const initialPlanks of [2, 0]) {
    const f = woodRecipeFixture(initialPlanks ? [] : ['birch'], { sand: 2, furnace: 1, birch_planks: initialPlanks });
    let output = 0, opened = 0, closed = 0;
    Object.assign(f.bot, { async openFurnace(block: { name: string }) {
      assert.equal(block.name, 'furnace'); opened++;
      return { inputItem: () => null, outputItem: () => output ? { name: 'glass', count: output } : null,
        async putInput(type: number, _metadata: unknown, count: number) { assert.equal(type, f.bot.registry.itemsByName.sand.id); assert.equal(count, 2); f.stock.set('sand', f.stock.get('sand')! - count); },
        async putFuel(type: number, _metadata: unknown, count: number) { assert.equal(type, f.bot.registry.itemsByName.birch_planks.id); assert.equal(count, 2); assert.ok(f.stock.get('birch_planks')! >= count); f.stock.set('birch_planks', f.stock.get('birch_planks')! - count); output = 2; },
        async takeOutput() { f.stock.set('glass', (f.stock.get('glass') ?? 0) + output); output = 0; },
        async close() { closed++; },
      };
    } });
    await f.executor.ensureItem('glass', 2, f.services);
    assert.equal(f.stock.get('glass'), 2); assert.equal(opened, 1); assert.equal(closed, 1);
    assert.ok(f.dug.every(name => name === 'birch_log')); assert.equal(f.stock.get('oak_log'), undefined);
    assert.ok(f.services.observations.some(o => o.kind === 'inventory' && o.data.items.some(i => i.name === 'glass' && i.count === 2)));
  }
});

test('crafting clears only the observed natural grass at its own utility cell and preserves protected vegetation', async () => {
  const f = woodRecipeFixture([], { oak_planks: 16 });
  const blockAt = f.bot.blockAt, dig = f.bot.dig;
  f.bot.blockAt = p => {
    const actual = blockAt(p);
    if (actual.name === 'air' && p.y === 64 && !f.cells.has(p.toString())) return { ...actual, name: 'short_grass', boundingBox: 'empty' };
    return actual;
  };
  f.bot.dig = async b => { if (b.name === 'short_grass') { f.dug.push(b.name); f.cells.set(b.position.toString(), 'air'); } else await dig(b); };
  f.services.checkpoint.protectedPositions = [{ x: 2, y: 64, z: 0 }];
  await f.executor.ensureItem('wooden_pickaxe', 1, f.services);
  assert.equal(f.stock.get('wooden_pickaxe'), 1); assert.deepEqual(f.dug, ['short_grass']);
  assert.equal(f.bot.blockAt(new Vec3(2, 64, 0)).name, 'short_grass');
  assert.equal(f.bot.blockAt(new Vec3(-2, 64, 0)).name, 'crafting_table');
});

test('unavailable wood recipes watch all raw alternatives and never mine constructed planks or protected logs', async () => {
  const f = woodRecipeFixture(['cherry']);
  const placed = new Vec3(30, 64, 0); f.locations.push(placed); f.cells.set(placed.toString(), 'oak_planks');
  f.services.checkpoint.buildProtection = { origin: { x: 10, y: 64, z: 0 }, width: 8, depth: 1, height: 4 };
  f.services.checkpoint.missingResource = 'cherry_log';
  await assert.rejects(f.executor.ensureItem('wooden_pickaxe', 1, f.services), (error: unknown) => {
    assert.ok(error instanceof ConditionWait);
    assert.equal(error.checkpoint.missingResource, undefined); assert.equal(error.checkpoint.missingItem, 'wooden_pickaxe');
    assert.ok(['oak_log', 'birch_log', 'cherry_log'].every(name => (error.checkpoint.resourceNames as string[]).includes(name)));
    return true;
  });
  assert.equal(f.services.checkpoint.missingResource, undefined);
  assert.deepEqual(f.dug, []); assert.deepEqual(f.crafted, []); assert.equal(f.cells.get(placed.toString()), 'oak_planks');
});

test('unknown crafting results and collect restrictions do not cause alternative world actions', async () => {
  const uncertain = woodRecipeFixture(['oak', 'birch']); uncertain.failCraft = true;
  await assert.rejects(uncertain.executor.ensureItem('wooden_pickaxe', 1, uncertain.services), (error: unknown) => error instanceof ActionFailure && error.code === 'CRAFT_UNCERTAIN');
  assert.ok(uncertain.dug.every(name => name === 'oak_log')); assert.deepEqual(uncertain.crafted, []);
  const restricted = woodRecipeFixture(['oak']); restricted.executor.options.config.allowedActions = ['craft'];
  await assert.rejects(restricted.executor.ensureItem('wooden_pickaxe', 1, restricted.services), ConditionWait);
  assert.deepEqual(restricted.dug, []); assert.deepEqual(restricted.crafted, []);
});

test('food preparation uses actual mature potatoes or beetroots and verifies their consumption', async () => {
  for (const [crop, item, age] of [['potatoes', 'potato', 7], ['beetroots', 'beetroot', 3]] as const) {
    let count = 0, held = '', digCount = 0;
    const cropBlock = { name: crop, position: new Vec3(2, 64, 0), boundingBox: 'empty', canHarvest: () => true, getProperties: () => ({ age }) };
    const bot = {
      health: 5, food: 17, entity: { position: new Vec3(0, 64, 0) }, entities: {},
      inventory: { items: () => count ? [{ name: item, count }] : [], emptySlotCount: () => 36 },
      registry: { itemsByName: { carrot: { id: 1 }, potato: { id: 2 }, beetroot: { id: 3 } }, items: {} },
      findBlock(request: { matching: (b: unknown) => boolean; useExtraInfo?: (b: unknown) => boolean }) { return !digCount && request.matching(cropBlock) && (!request.useExtraInfo || request.useExtraInfo(cropBlock)) ? cropBlock : null; },
      blockAt(p: Vec3) { return p.equals(cropBlock.position) && !digCount ? cropBlock : { name: p.y === 63 ? 'dirt' : 'air', position: p, boundingBox: p.y === 63 ? 'block' : 'empty' }; },
      recipesAll: () => [], async dig() { digCount++; count++; },
      async equip(i: { name: string }) { held = i.name; }, async consume() { assert.equal(held, item); count--; bot.food++; },
    };
    navigation(bot, [cropBlock.position]);
    const executor = new MineflayerExecutor(bot as unknown as Bot, options()), services = executor.services(new AbortController().signal);
    services.near = async () => {}; services.pause = async () => {};
    await executor.ensureFood(services); assert.equal(digCount, 1); assert.equal(count, 1);
    assert.equal(await executor.eat(services), true); assert.equal(bot.food, 18); assert.equal(count, 0);
  }
});

test('food availability probes do not hunt near a hostile at critical health or swallow unknown preparation effects', async () => {
  const f = woodRecipeFixture([]); f.bot.registry.itemsByName.potato = { id: 100 }; f.bot.registry.itemsByName.beef = { id: 101 };
  Object.assign(f.bot, { entities: { 2: { name: 'cow', position: new Vec3(30, 64, 0) },3:{name:'zombie',position:new Vec3(10,64,0)} } });
  const foodBot = f.bot as typeof f.bot & { health: number; food: number };
  foodBot.health = 5; foodBot.food = 17;
  // This probe tests hunting/preparation effects, with travel disabled. A food
  // expedition on the mock's infinite empty plane intentionally keeps walking.
  f.executor.options.config.allowedActions = f.executor.options.config.allowedActions.filter(action => action !== 'explore');
  await assert.rejects(f.executor.ensureFood(f.services), (error: unknown) => error instanceof ConditionWait && error.checkpoint.missingFood === true && /확보하지 못했습니다/.test(error.message));
  assert.deepEqual(f.dug, []);
  const raw = { name: 'potatoes', position: new Vec3(2, 64, 0), boundingBox: 'empty', canHarvest: () => true, getProperties: () => ({ age: 7 }) };
  f.bot.findBlock = request => request.matching(raw) ? raw : null;
  f.executor.ensureItem = async () => { throw new ActionFailure('효과 미확인', 'UNKNOWN', false, false); };
  await assert.rejects(f.executor.ensureFood(f.services), (error: unknown) => error instanceof ActionFailure && error.code === 'UNKNOWN');
});

test('resource matching handles palette blocks without positions and checks protection on full blocks', async () => {
  let stock = 0;
  let positionChecks = 0;
  const log = { name: 'oak_log', position: new Vec3(2, 64, 0), boundingBox: 'block', canHarvest: () => true, getProperties: () => ({}) };
  const bot = {
    inventory: { items: () => stock ? [{ name: 'oak_log', count: stock }] : [], emptySlotCount: () => 36 },
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, players: {}, registry: { itemsByName: { oak_log: { id: 1 } } },
    findBlock(request: { matching: (value: unknown) => boolean; useExtraInfo: (value: unknown) => boolean }) {
      assert.equal(request.matching({ name: 'oak_log', position: null }), true);
      assert.equal(request.useExtraInfo(log), true); positionChecks += 1; return log;
    },
    blockAt(p: Vec3) { return p.equals(log.position.offset(0, 1, 0)) ? { name: 'oak_leaves', boundingBox: 'block' } : p.equals(log.position) ? log : { name: p.y === 63 ? 'dirt' : 'air', position: p, boundingBox: p.y === 63 ? 'block' : 'empty' }; },
    async dig() { stock += 1; }, async equip() {},
  } as unknown as Bot;
  navigation(bot, [log.position]);
  const executor = new MineflayerExecutor(bot, options());
  const services = executor.services(new AbortController().signal); services.pause = async () => {}; services.near = async () => {};
  const task: TaskSpec = { id: 'task', goalId: 'goal', kind: 'collect', params: { item: 'oak_log' }, dependencies: [], reservationKeys: [], completion: { kind: 'inventory', item: 'oak_log', minimum: 1 } };
  const result = await executor.execute(task, services);
  assert.equal(result.outcome, 'completed'); assert.equal(stock, 1); assert.equal(positionChecks, 1);
});

test('collection reobserves falling upper-log drops before navigating and confirms inventory instead of mining another tree', async () => {
  let stock = 0, broken = false, falling = false, descent = 0, pickups = 0;
  const source = new Vec3(2, 66, 0), drop = { name: 'item', position: source.offset(0.5, 0.2, 0.5) };
  const blockAt = (p: Vec3) => {
    const name = p.equals(source) && !broken ? 'oak_log' : p.equals(source.offset(0, 1, 0)) ? 'oak_leaves' : p.y === 63 ? 'dirt' : 'air';
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: () => true, getProperties: () => ({}) };
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, entities: {} as Record<number, typeof drop>, blockAt,
    inventory: { items: () => stock ? [{ name: 'oak_log', count: stock }] : [], emptySlotCount: () => 36 },
    registry: { itemsByName: { oak_log: { id: 1 } } },
    findBlock: () => broken ? null : blockAt(source),
    async dig() { broken = true; falling = true; bot.entities[2] = drop; },
  };
  navigation(bot, [source]);
  const executor = new MineflayerExecutor(bot as unknown as Bot, options()), services = executor.services(new AbortController().signal);
  services.pause = async () => { if (falling) { descent++; if (descent >= 4) drop.position.y = 64.15; } };
  services.near = async (_p, radius) => {
    if (radius === 0 && broken) { assert.equal(Math.floor(drop.position.y), 64, 'a floating item must never be used as a stand target'); pickups++; stock++; delete bot.entities[2]; }
  };
  await executor.ensureItem('oak_log', 1, services);
  assert.equal(stock, 1); assert.equal(pickups, 1); assert.ok(descent >= 4);
});

test('recursive construction gathering preserves the selected foundation and exit ground', async () => {
  let stock = 0;
  const block = (x: number) => ({ name: 'stone', boundingBox: 'block', position: new Vec3(x, 63, 0), canHarvest: () => true, getProperties: () => ({}) });
  const protectedStone = block(0), outsideStone = block(4);
  const bot = {
    inventory: { items: () => stock ? [{ name: 'cobblestone', count: stock }] : [], emptySlotCount: () => 36 },
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, registry: { itemsByName: { cobblestone: { id: 1 } } },
    findBlock(request: { useExtraInfo: (b: unknown) => boolean }) { assert.equal(request.useExtraInfo(protectedStone), false); assert.equal(request.useExtraInfo(outsideStone), true); return outsideStone; },
    blockAt(p: Vec3) { return p.equals(outsideStone.position) ? outsideStone : { name: p.y === 63 ? 'dirt' : 'air', position: p, boundingBox: p.y === 63 ? 'block' : 'empty' }; },
    async equip() {}, async dig(b: unknown) { assert.equal(b, outsideStone); stock++; },
  } as unknown as Bot;
  navigation(bot, [outsideStone.position]);
  const executor = new MineflayerExecutor(bot, options());
  const services = executor.services(new AbortController().signal, { buildProtection: { origin: { x: 0, y: 64, z: 0 }, width: 2, depth: 2, height: 4 } });
  services.near = async p => { bot.entity.position = new Vec3(p.x, p.y, p.z); }; services.pause = async () => {};
  await executor.ensureItem('cobblestone', 1, services);
  assert.equal(stock, 1);
});

test('recursive crafting places its utility outside the selected building and approach ring', async () => {
  const stock = new Map([['crafting_table', 1], ['oak_planks', 3], ['stick', 2]]), cells = new Map<string, string>();
  const recipe = { requiresTable: true, result: { id: 4, count: 1 }, delta: [{ id: 2, count: -3 }, { id: 3, count: -2 }, { id: 4, count: 1 }] };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, world: { raycast: () => null },
    inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) },
    registry: { itemsByName: { wooden_pickaxe: { id: 4 } }, items: { 2: { name: 'oak_planks' }, 3: { name: 'stick' }, 4: { name: 'wooden_pickaxe' } } },
    findBlock: () => null, recipesAll: () => [recipe], recipesFor: () => [recipe],
    blockAt(p: Vec3) { const name = cells.get(p.toString()) ?? (p.y === 63 ? 'stone' : 'air'); return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }; },
    async equip() {},
    async placeBlock(reference: { position: Vec3 }, face: Vec3) {
      const p = reference.position.plus(face);
      assert.ok(p.x < -4 || p.x > 4 || p.z < -3 || p.z > 3, `utility must preserve construction space: ${p}`);
      cells.set(p.toString(), 'crafting_table'); stock.set('crafting_table', 0);
    },
    async craft(_recipe: unknown, _count: number, table: { position: Vec3 }) { assert.equal(cells.get(table.position.toString()), 'crafting_table'); stock.set('wooden_pickaxe', 1); },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, options());
  const services = executor.services(new AbortController().signal, { buildProtection: { origin: { x: -3, y: 64, z: -2 }, width: 7, depth: 5, height: 4 } });
  services.near = async p => { bot.entity.position = new Vec3(p.x, p.y, p.z); };
  await executor.ensureItem('wooden_pickaxe', 1, services);
  assert.equal(stock.get('wooden_pickaxe'), 1); assert.equal(cells.size, 1);
});

test('collection returns to a fresh resource after recursively gathering and crafting its missing tool', async () => {
  for (const lavaAfterCraft of [false, true]) {
    const stock = new Map<string, number>(), cells = new Map<string, string>();
    const resource = new Vec3(2, 64, 0), logs = [20, 22, 24].map(x => new Vec3(x, 64, 0)), utilities: Vec3[] = [];
    let lava = false;
    let heldType: number | null = null;
    const ids = { cobblestone: 1, oak_log: 2, oak_planks: 3, stick: 4, crafting_table: 5, wooden_pickaxe: 6 };
    const recipes = {
      3: { requiresTable: false, result: { id: 3, count: 4 }, delta: [{ id: 2, count: -1 }, { id: 3, count: 4 }] },
      4: { requiresTable: false, result: { id: 4, count: 4 }, delta: [{ id: 3, count: -2 }, { id: 4, count: 4 }] },
      5: { requiresTable: false, result: { id: 5, count: 1 }, delta: [{ id: 3, count: -4 }, { id: 5, count: 1 }] },
      6: { requiresTable: true, result: { id: 6, count: 1 }, delta: [{ id: 3, count: -3 }, { id: 4, count: -2 }, { id: 6, count: 1 }] },
    };
    const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
    const bot = {
      entity: { position: new Vec3(0, 64, 0) }, entities: {}, world: { raycast: () => null },
      inventory: { items: () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: ids[name as keyof typeof ids] })), emptySlotCount: () => 36 },
      get heldItem() { return heldType === null ? null : { type: heldType }; },
      registry: { itemsByName: Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, { id }])), items: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { name }])) },
      blockAt(p: Vec3) {
        const name = cells.get(p.toString()) ?? (lava && p.equals(resource.offset(0, 1, 0)) ? 'lava' : p.equals(resource) ? 'stone' : logs.some(log => p.equals(log)) ? 'oak_log' : logs.some(log => p.equals(log.offset(0, 1, 0))) ? 'oak_leaves' : p.y === 63 ? 'dirt' : 'air');
        return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', canHarvest: (type: number | null) => name !== 'stone' || type === ids.wooden_pickaxe, getProperties: () => ({}) };
      },
      findBlock(request: { matching: (b: unknown) => boolean; useExtraInfo?: (b: unknown) => boolean }) {
        for (const p of [resource, ...logs, ...utilities]) {
          const b = bot.blockAt(p); if (request.matching(b) && (!request.useExtraInfo || request.useExtraInfo(b))) return b;
        }
        return null;
      },
      recipesAll(id: number) { return id in recipes ? [recipes[id as keyof typeof recipes]] : []; },
      recipesFor(id: number) { return this.recipesAll(id); },
      async equip(item: { type: number }) { heldType = item.type; },
      async placeBlock(reference: { position: Vec3 }, face: Vec3) { const p = reference.position.plus(face); cells.set(p.toString(), 'crafting_table'); utilities.push(p); stock.set('crafting_table', (stock.get('crafting_table') ?? 0) - 1); },
      async craft(recipe: typeof recipes[3]) {
        for (const delta of recipe.delta) stock.set(names[delta.id], (stock.get(names[delta.id]) ?? 0) + delta.count);
        if (recipe.result.id === ids.wooden_pickaxe && lavaAfterCraft) lava = true;
      },
      async dig(b: { name: string; position: Vec3 }) {
        assert.ok(bot.entity.position.distanceTo(b.position) <= 4.5, 'missing tool acquisition must return to an actually reachable resource');
        if (b.name === 'stone') { assert.equal(lava, false, 'a hazard appearing during tool preparation must prevent mining'); assert.equal(heldType, ids.wooden_pickaxe); stock.set('cobblestone', 1); cells.set(resource.toString(), 'air'); }
        else { stock.set('oak_log', (stock.get('oak_log') ?? 0) + 1); cells.set(b.position.toString(), 'air'); }
      },
    };
    navigation(bot, [resource, ...logs]);
    const executor = new MineflayerExecutor(bot as unknown as Bot, options());
    const services = executor.services(new AbortController().signal);
    services.near = async p => { bot.entity.position = new Vec3(p.x, p.y, p.z); }; services.pause = async () => {};
    if (lavaAfterCraft) await assert.rejects(executor.ensureItem('cobblestone', 1, services), (error: unknown) => error instanceof ConditionWait && error.checkpoint.missingResource === 'cobblestone');
    else await executor.ensureItem('cobblestone', 1, services);
    assert.equal(stock.get('cobblestone') ?? 0, lavaAfterCraft ? 0 : 1); assert.equal(stock.get('wooden_pickaxe'), 1);
  }
});

test('placement selects a visible support face and known refusal waits instead of claiming unknown effects', async () => {
  const target = new Vec3(0, 64, 0);
  let name = 'air';
  let refuse = false;
  let stock = 3;
  const calls: Vec3[] = [];
  const stone = (p: Vec3) => ({ name: 'stone', position: p, boundingBox: 'block' });
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 2) }, inventory: { items: () => [{ name: 'oak_planks', count: stock }] },
    world: { raycast(_start: Vec3, direction: Vec3) { return direction.x > 0.1 ? { position: new Vec3(1, 64, 1), face: 0 } : null; } },
    blockAt(p: Vec3) { return p.equals(target) ? { name, position: target, boundingBox: name === 'air' ? 'empty' : 'block' } : p.equals(target.offset(0, -1, 0)) || p.equals(target.offset(-1, 0, 0)) ? stone(p) : { name: 'air', position: p, boundingBox: 'empty' }; },
    async equip() {},
    async placeBlock(_reference: unknown, face: Vec3) { calls.push(face); if (refuse) throw new Error('Server refused block placement'); name = 'oak_planks'; stock -= 1; },
  }) as unknown as Bot;
  const executor = new MineflayerExecutor(bot, options());
  const services = executor.services(new AbortController().signal); services.near = async () => {};
  await executor.place(target, 'oak_planks', 'oak_planks', services, { x: 0, y: 1, z: 0 });
  assert.ok(calls[0]?.equals(new Vec3(1, 0, 0)));
  assert.equal(name, 'oak_planks');
  name = 'air'; refuse = true;
  await assert.rejects(executor.place(target, 'oak_planks', 'oak_planks', services), (error: unknown) => error instanceof ConditionWait && /설치.*거부/.test(error.message));
});

test('placement moves outside its own body and tries another observed face after a known refusal', async () => {
  const target = new Vec3(0, 64, 0);
  let name = 'air', moves = 0, attempts = 0, stock = 3;
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8 },
    inventory: { items: () => [{ name: 'oak_planks', count: stock }] },
    world: { raycast: () => null },
    blockAt(p: Vec3) {
      if (p.equals(target)) return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' };
      const solid = p.y === 63 || p.equals(target.offset(-1, 0, 0));
      return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty' };
    },
    async equip() {},
    async placeBlock() {
      assert.ok(Math.abs(bot.entity.position.x - 0.5) > 0.8 || Math.abs(bot.entity.position.z - 0.5) > 0.8);
      attempts += 1;
      if (attempts === 1) throw new Error('Server refused block placement');
      name = 'oak_planks'; stock -= 1;
    },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, options());
  const services = executor.services(new AbortController().signal);
  services.near = async p => { bot.entity.position = new Vec3(p.x, p.y, p.z); moves += 1; };
  // Keep the initial reach check from moving onto the block being installed.
  const near = services.near;
  services.near = async (p, radius) => { if (radius === 0) await near(p, radius); };
  await executor.place(target, 'oak_planks', 'oak_planks', services);
  assert.ok(moves > 0); assert.equal(attempts, 2); assert.equal(name, 'oak_planks');
});

test('craft waits for the final public inventory update after the crafting promise resolves', async () => {
  let planks = 0, craftCalls = 0;
  const recipe = { requiresTable: false, result: { id: 2, count: 4 }, delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }] };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'oak_log', count: 2 }, ...(planks ? [{ name: 'oak_planks', count: planks }] : [])] },
    registry: { itemsByName: { oak_log: { id: 1 }, oak_planks: { id: 2 } }, items: { 1: { name: 'oak_log' }, 2: { name: 'oak_planks' } } },
    findBlock: () => null, recipesAll: () => [recipe], recipesFor: () => [recipe],
    async craft(_recipe: unknown, count: number) { craftCalls += 1; assert.equal(count, 1); setTimeout(() => { planks += 4; }, 175); },
  } as unknown as Bot;
  const executor = new MineflayerExecutor(bot, options());
  const services = executor.services(new AbortController().signal);
  await executor.ensureItem('oak_planks', 8, services);
  assert.equal(planks, 8); assert.equal(craftCalls, 2);
  assert.ok(services.observations.some(observation => observation.kind === 'inventory'));
});

test('placement confirms late slot consumption before switching from an exhausted stack', async () => {
  const stacks = [1, 2], blocks = new Map<string, string>(), selected: number[] = [];
  let held = 0;
  const bot = {
    entity: { position: new Vec3(0.5, 64, 2.5) },
    inventory: { items: () => stacks.flatMap((count, slot) => count > 0 ? [{ name: 'oak_planks', count, slot }] : []) },
    world: { raycast: () => null },
    blockAt(p: Vec3) { const name = blocks.get(p.toString()) ?? (p.y === 63 ? 'stone' : 'air'); return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }; },
    async equip(item: { slot: number }) { held = item.slot; },
    async placeBlock(reference: { position: Vec3 }, face: Vec3) {
      assert.ok(stacks[held] > 0, 'an exhausted stack must not be reused');
      selected.push(held); blocks.set(reference.position.plus(face).toString(), 'oak_planks');
      const slot = held; setTimeout(() => { stacks[slot] -= 1; }, 175);
    },
  };
  const executor = new MineflayerExecutor(bot as unknown as Bot, options());
  const services = executor.services(new AbortController().signal); services.near = async () => {};
  await executor.place(new Vec3(0, 64, 0), 'oak_planks', 'oak_planks', services);
  await executor.place(new Vec3(1, 64, 0), 'oak_planks', 'oak_planks', services);
  assert.deepEqual(selected, [0, 1]); assert.deepEqual(stacks, [0, 1]);
});

test('missing placement acknowledgements and unexplained material loss never retry blindly', async () => {
  for (const consumed of [false, true]) {
    let stock = 3, calls = 0;
    const bot = {
      entity: { position: new Vec3(0.5, 64, 2.5) }, inventory: { items: () => [{ name: 'oak_planks', count: stock }] },
      world: { raycast: () => null },
      blockAt(p: Vec3) { return { name: p.y === 63 ? 'stone' : 'air', position: p, boundingBox: p.y === 63 ? 'block' : 'empty' }; },
      async equip() {},
      async placeBlock() { calls += 1; if (consumed) stock -= 1; throw new Error(consumed ? 'Server refused to place block' : 'Server did not answer the placement'); },
    };
    const executor = new MineflayerExecutor(bot as unknown as Bot, options());
    const services = executor.services(new AbortController().signal); services.near = async () => {};
    await assert.rejects(executor.place(new Vec3(0, 64, 0), 'oak_planks', 'oak_planks', services), (error: unknown) => error instanceof ActionFailure && error.code === 'PLACE_UNCERTAIN' && !error.effectsKnown && error.message.includes('inventoryDelta'));
    assert.equal(calls, 1);
  }
});

test('food gathering with an empty private checkpoint preserves the registered farm and collects outside ripe wheat',async()=>{
 let stock=0;const plant=(x:number)=>({name:'wheat',boundingBox:'empty',position:new Vec3(x,64,0),canHarvest:()=>true,getProperties:()=>({age:7})}),own=plant(0),outside=plant(4);
 const bot={entity:{position:new Vec3(0,64,-3)},entities:{},inventory:{items:()=>stock?[{name:'wheat',count:stock}]:[],emptySlotCount:()=>36},registry:{itemsByName:{wheat:{id:1}}},findBlock(request:{useExtraInfo:(b:unknown)=>boolean}){assert.equal(request.useExtraInfo(own),false);assert.equal(request.useExtraInfo(outside),true);return outside;},blockAt(p:Vec3){if(p.equals(own.position))return own;if(p.equals(outside.position))return outside;return{name:p.y===63?'dirt':'air',position:p,boundingBox:p.y===63?'block':'empty'};},async equip(){},async dig(b:unknown){assert.equal(b,outside);stock++;}} as unknown as Bot;
 navigation(bot,[outside.position]);const opts=options();opts.rules.baseAutonomy={id:'owned-farm',origin:{x:0,y:63,z:1},positions:[{x:0,y:63,z:0}],breadTarget:8,woodTarget:1};const executor=new MineflayerExecutor(bot,opts),s=executor.services(new AbortController().signal);s.near=async p=>{bot.entity.position=new Vec3(p.x,p.y,p.z);};s.pause=async()=>{};
 await executor.ensureItem('wheat',1,s);assert.equal(stock,1);
});
