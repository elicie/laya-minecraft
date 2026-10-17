import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RulesSchema,type Goal,type GoalInput,type Observation} from '../packages/contracts/src';
import {blueprint} from '../packages/contracts/src/blueprints';
import {FleetController,planGoal} from '../packages/core/src';
import {baseSupplyGoals} from '../packages/core/src/base-supply';
import {warehouseShelter} from '../packages/core/src/warehouse-shelter';
function fixture(){
 const now=100000,epoch='base-epoch',world='127.0.0.1:25566',warehouse={id:'base',world,dimension:'overworld',position:{x:1,y:65,z:1}},base=warehouseShelter(warehouse,blueprint('warehouse',{x:0,y:64,z:0}))!;
 const rules=RulesSchema.parse({world,center:{x:3,y:64,z:0},warehouse,baseShelter:base,baseAutonomy:{id:'shore',origin:{x:10,y:63,z:0},positions:[{x:11,y:63,z:0},{x:11,y:63,z:1}]}}),core=new FleetController({send(){},rules:{...rules,autonomyEnabled:false}});
 const goal=(input:GoalInput):Goal=>core.createGoal(input);
 const stock=(items:{name:string;count:number}[],extra={})=>({id:randomUUID(),kind:'container',observedAt:now,receivedAt:now,controllerEpoch:epoch,botId:'farmer',sessionId:'session',world,dimension:'overworld',data:{container:warehouse,items},...extra}) as Observation;
 const crop=(ripe:number)=>({id:randomUUID(),kind:'farm',observedAt:now,receivedAt:now,controllerEpoch:epoch,botId:'farmer',sessionId:'session',world,dimension:'overworld',data:{id:'shore',crop:'wheat',plots:rules.baseAutonomy!.positions.length,planted:2,watered:2,ripe,harvested:0,sampleOnly:true}}) as Observation;
 return{now,epoch,rules,goal,stock,crop,choose:(goals:Goal[]=[],obs:Observation[]=[])=>baseSupplyGoals(rules,goals,obs,now,epoch)};
}
test('base supply bootstraps bounded returning seed and wood stock, and requires fresh actual materials for planting',()=>{
 const f=fixture(),empty=f.choose();assert.deepEqual(empty.map(g=>g.item),['wheat_seeds','oak_log']);assert.ok(empty.every(g=>g.params?.batchSize===2&&g.params?.useBaseDoor===true));
 const items=[{name:'wheat_seeds',count:2},{name:'oak_log',count:1}];
 assert.equal(f.choose([], [f.stock(items,{observedAt:f.now-30001})]).length,2);
 assert.equal(f.choose([], [f.stock(items,{controllerEpoch:'old'})]).length,2);
 const setup=f.choose([], [f.stock(items)]).find(g=>g.kind==='farm')!;assert.equal(setup.params?.mode,'setup');assert.equal(setup.params?.prepareHoe,true);
 const plan=planGoal(f.goal(setup),f.rules,randomUUID);assert.deepEqual(plan.tasks.map(t=>t.kind),['home','take','take','craft','home','farm','home','home']);assert.equal(plan.tasks[0]!.params.basePassage,'inside');assert.equal(plan.tasks[4]!.params.basePassage,'outside');
 for(let i=1;i<plan.tasks.length;i++)assert.deepEqual(plan.tasks[i]!.dependencies,[plan.tasks[i-1]!.id]);
});

test('a configured food producer owns stock, planting, harvest and bread workflows',()=>{
 const f=fixture();f.rules.baseAutonomy!.botId='farmer';
 const bootstrap=f.choose([],[f.stock([{name:'wheat_seeds',count:2},{name:'oak_log',count:1}])]);
 const setup=f.goal({kind:'farm',source:'autonomous',params:{baseSupplyId:'shore',baseSupplyStep:'farm-setup'}});setup.state='completed';
 const production=f.choose([setup],[f.stock([{name:'wheat_seeds',count:2},{name:'wheat',count:3}]),f.crop(1)]);
 assert.ok(bootstrap.some(g=>g.params?.baseSupplyStep==='farm-setup'));
 assert.ok(production.some(g=>g.params?.baseSupplyStep==='farm-harvest'));
 assert.ok(production.some(g=>g.params?.baseSupplyStep==='bread-batch'));
 assert.ok([...bootstrap,...production].every(g=>g.requiredBotId==='farmer'&&g.preferredBotId==='farmer'));
 delete f.rules.baseAutonomy!.botId;
 assert.ok(f.choose().every(g=>g.requiredBotId===undefined),'an unconfigured producer retains shared-fleet scheduling');
});

test('an unavailable designated farmer does not leave seed delivery affined to a busy village guard',()=>{
 const f=fixture();f.rules.baseAutonomy!.botId='farmer';const sent:{type:string;botId:string}[]=[];
 const core=new FleetController({send:(_bot,message)=>sent.push(message),rules:f.rules,now:()=>f.now,controllerEpoch:f.epoch});
 core.addAgent({id:'farmer',name:'SupplyFarmer',enabled:false});const guard=core.addAgent({id:'guard',name:'SupplyGuard',role:'guard'});core.startSession(guard.id,'guard-session');
 const receive=(type:string,payload:unknown)=>core.receive({protocolVersion:1,messageId:randomUUID(),controllerEpoch:f.epoch,botId:guard.id,sessionId:'guard-session',sentAt:f.now,type,payload});
 receive('bot.ready',{ready:true,world:f.rules.world,dimension:'overworld',position:{x:3,y:64,z:-1},health:20,food:20,mode:'idle',action:'idle',reason:'ready',inventory:[],rulesVersion:f.rules.version,capabilities:['collect','farm','home','craft','take','store']});receive('rules.applied',{version:f.rules.version});core.tick();
 assert.equal(core.getSnapshot().goals.length,2);
 assert.ok(core.getSnapshot().goals.every(g=>g.input.requiredBotId==='farmer'));
 assert.equal(sent.some(message=>message.type==='task.assign'&&message.botId==='guard'),false,'guard work cannot capture an unfinished configured food pipeline');
});
test('only completed planting and actual wheat stock enable harvest and warehouse bread production without duplicate active batches',()=>{
 const f=fixture(),setup=f.goal({kind:'farm',source:'autonomous',params:{baseSupplyId:'shore',baseSupplyStep:'farm-setup'}});setup.state='completed';
 const obs=[f.stock([{name:'wheat',count:3},{name:'wheat_seeds',count:2}]),f.crop(1)],choices=f.choose([setup],obs),bread=choices.find(g=>g.item==='bread')!;
 assert.ok(choices.some(g=>g.params?.mode==='harvest'));assert.ok(bread);
 const plan=planGoal(f.goal(bread),f.rules,randomUUID);assert.deepEqual(plan.tasks.map(t=>t.kind),['home','take','craft','store','home']);assert.equal(plan.tasks[1]!.params.quantity,3);assert.equal(plan.tasks[2]!.params.item,'bread');assert.equal(plan.tasks[3]!.completion.kind,'transfer');
 const active=f.goal(bread);assert.equal(f.choose([setup,active],obs).some(g=>g.item==='bread'),false);
 assert.equal(f.choose([setup],[f.stock([{name:'wheat',count:3},{name:'bread',count:8}])]).some(g=>g.item==='bread'),false);
});
test('a configured supply base schedules its supply workflow without adding unrelated village buildings',()=>{
 const f=fixture(),core=new FleetController({send(){},rules:f.rules,now:()=>f.now,controllerEpoch:f.epoch}),a=core.addAgent({name:'BaseFarmer'});core.startSession(a.id,'session');
 core.receive({protocolVersion:1,messageId:randomUUID(),controllerEpoch:f.epoch,botId:a.id,sessionId:'session',sentAt:f.now,type:'bot.ready',payload:{ready:true,world:f.rules.world,dimension:'overworld',position:{x:3,y:64,z:-1},health:20,food:20,mode:'idle',action:'idle',reason:'ready',inventory:[],rulesVersion:f.rules.version,capabilities:['collect','farm','home','craft','take','store']}});
 core.tick();assert.equal(core.getSnapshot().goals.length,2);assert.ok(core.getSnapshot().goals.every(g=>g.input.params.baseSupplyId==='shore'));
});

test('planting starts with actual available seeds and expands only with a new observed supply',()=>{
 const f=fixture();f.rules.baseAutonomy!.positions.push({x:11,y:63,z:2},{x:11,y:63,z:3});
 const first=f.choose([],[f.stock([{name:'wheat_seeds',count:2},{name:'oak_log',count:1}])]).find(g=>g.params?.baseSupplyStep==='farm-setup')!;
 assert.equal(first.params!.plots,2);const setup=f.goal(first);setup.state='completed';
 const choices=f.choose([setup],[f.stock([{name:'wheat_seeds',count:2}])]),expansion=choices.find(g=>g.params?.baseSupplyStep==='farm-expand-4')!;
 assert.ok(expansion);assert.equal(expansion.params!.plots,4);assert.deepEqual(expansion.params!.warehouseInputs,[{item:'wheat_seeds',quantity:2}]);
 assert.equal(choices.some(g=>g.params?.baseSupplyStep==='farm-harvest'),false,'unobserved maturity does not cause a farm trip');
 const active=f.goal(expansion);assert.equal(f.choose([setup,active],[f.stock([{name:'wheat_seeds',count:2}])]).some(g=>String(g.params?.baseSupplyStep).startsWith('farm-expand')),false);
 active.state='completed';assert.equal(f.choose([setup,active],[f.stock([{name:'wheat_seeds',count:4}]),f.crop(1)]).find(g=>g.params?.baseSupplyStep==='farm-harvest')!.params!.plots,4);
});

test('a verified user bootstrap farm continues into the same autonomous supply workflow',()=>{
 const f=fixture(),setup=f.goal({kind:'farm',source:'user',params:{baseSupplyId:'shore',baseSupplyStep:'farm-setup',plots:2}});setup.state='completed';
 const choices=f.choose([setup],[f.stock([{name:'wheat_seeds',count:2}]),f.crop(1)]);assert.equal(choices.some(g=>g.params?.baseSupplyStep==='farm-setup'),false);assert.ok(choices.some(g=>g.params?.baseSupplyStep==='farm-harvest'));
});

test('a cancelled bootstrap does not prevent a fresh farm once actual supplies exist',()=>{
 const f=fixture(),cancelled=f.goal({kind:'farm',source:'user',params:{baseSupplyId:'shore',baseSupplyStep:'farm-setup',plots:2}});cancelled.state='cancelled';
 assert.ok(f.choose([cancelled],[f.stock([{name:'wheat_seeds',count:2},{name:'oak_log',count:1}])]).some(g=>g.params?.baseSupplyStep==='farm-setup'));
});

test('a partial ripe harvest needs only its actual replant seeds rather than the entire farm reserve',()=>{
 const f=fixture(),setup=f.goal({kind:'farm',source:'autonomous',params:{baseSupplyId:'shore',baseSupplyStep:'farm-setup'}});setup.state='completed';
 const harvest=f.choose([setup],[f.stock([{name:'wheat_seeds',count:1}]),f.crop(1)]).find(g=>g.params?.mode==='harvest');
 assert.ok(harvest);assert.deepEqual(harvest.params!.warehouseInputs,[{item:'wheat_seeds',quantity:1}]);
 assert.equal(f.choose([setup],[f.stock([]),f.crop(1)]).some(g=>g.params?.mode==='harvest'),false);
});
