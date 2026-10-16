import assert from 'node:assert/strict';
import test from 'node:test';
import type {Bot} from 'mineflayer';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withWarehouseDoor} from '../packages/minecraft/src/warehouse-door-lease';
import {foodRecoveryFingerprint} from '../packages/minecraft/src/worker-recovery';
import {Vec3} from 'vec3';
import {RulesSchema,type Position} from '../packages/contracts/src';
import {blueprint} from '../packages/contracts/src/blueprints';
import {warehouseShelter} from '../packages/core/src/warehouse-shelter';
import {restInWarehouse} from '../packages/minecraft/src/base-shelter';
import {openDoorClearance} from '../packages/minecraft/src/open-door';
import {ConditionWait,type ActionServices} from '../packages/minecraft/src/services';

function fixture(){
 const world='127.0.0.1:25566',blocks=blueprint('warehouse',{x:0,y:64,z:0}),container={id:'verified-base',world,dimension:'overworld',position:{x:1,y:65,z:1}},base=warehouseShelter(container,blocks)!;
 const key=(p:Position)=>`${p.x},${p.y},${p.z}`,cells=new Map(blocks.map(b=>[key(b.position),b.name]));let opened=false,toggles=0,waits=0,action='';const states:string[]=[];
 let aim=new Vec3(3.5,64,-.5),controls:Record<string,boolean>={};
 const bot={entity:{position:new Vec3(3.5,64,-.5),onGround:true},time:{isDay:false,timeOfDay:13000,doDaylightCycle:true},entities:{} as Record<string,any>,health:20,food:20,inventory:{items:()=>[]},pathfinder:{setGoal(){}},clearControlStates(){controls={};},setControlState(name:string,value:boolean){controls[name]=value;},async lookAt(p:Vec3){aim=p.offset(0,-1.62,0);},
  blockAt(p:Position){const name=cells.get(key(p))??(p.y<64?'dirt':'air');return {name,position:new Vec3(p.x,p.y,p.z),boundingBox:name==='air'||name==='wall_torch'?'empty':'block',shapes:name==='air'?[]:name.endsWith('_door')?opened?[[0,0,0,.1875,1,1]]:[[0,0,.8125,1,1,1]]:[[0,0,0,1,1,1]],getProperties:()=>name.endsWith('_door')?{open:opened}:{}};},
  canSeeBlock:()=>true,async activateBlock(){opened=!opened;toggles++;},
 } as unknown as Bot;
 const s:ActionServices={bot,rules:RulesSchema.parse({world,warehouse:container,baseShelter:base}),signal:new AbortController().signal,checkpoint:{},observations:[],evidence:[],check(){},
  async near(p){if(p.y===65&&Math.floor(bot.entity.position.y)!==65)assert.equal(opened,true,'crossing into the room requires an actually opened door');bot.entity.position=new Vec3(p.x,p.y,p.z);},
  async pause(){if(controls.forward){const p=bot.entity.position,dx=aim.x-p.x,dz=aim.z-p.z,dist=Math.hypot(dx,dz),step=Math.min(.2,dist);bot.entity.position=new Vec3(p.x+dx/dist*step,controls.jump?aim.y:p.y,p.z+dz/dist*step);if(aim.y<p.y)bot.entity.position.y=aim.y;}if((s.checkpoint.nightBase as {phase?:string}|undefined)?.phase==='closed'){assert.equal(opened,false,'the night wait must keep its door closed');waits++;if(waits===1){bot.entities[9]={name:'zombie',position:new Vec3(3.5,64,-1.5)} as any;bot.time.isDay=true;bot.time.timeOfDay=0;}else delete bot.entities[9];}},
  progress(value){action=value;states.push(value);},async ensureItem(){assert.fail('shelter must not gather or craft');},async place(){assert.fail('shelter must not place blocks');},observeInventory(){return {id:'base-inventory',observedAt:0,world,dimension:'overworld',kind:'inventory',data:{items:[]}};},
 };
 return {s,bot,cells,base,key,states,get opened(){return opened;},get toggles(){return toggles;},get waits(){return waits;}};
}
test('warehouse approach uses the same twelve-block threat boundary as the worker report',async()=>{
 const f=fixture();f.bot.time.isDay=true;f.bot.time.timeOfDay=0;f.bot.entities[1]={name:'zombie',position:new Vec3(3.5,64,-14.5)} as any;
 assert.equal(await restInWarehouse(f.s,()=>true,undefined,'enter'),true);assert.equal(await restInWarehouse(f.s,()=>true,undefined,'exit'),true);assert.equal(f.opened,false);
 const blocked=fixture();blocked.bot.time.isDay=true;blocked.bot.entities[1]={name:'zombie',position:new Vec3(3.5,64,-11.5)} as any;assert.equal(await restInWarehouse(blocked.s,()=>true,undefined,'enter'),false);assert.equal(blocked.toggles,0);
});
test('a registered real building opens and closes its door, waits for daylight and outside threat clearance, and resumes outside',async()=>{
 const f=fixture();assert.equal(await restInWarehouse(f.s,()=>true),true);assert.equal(f.toggles,4);assert.equal(f.opened,false);assert.equal(f.waits,2);assert.ok(f.bot.entity.position.distanceTo(new Vec3(3.5,64,-.5))<.15);assert.equal(f.s.checkpoint.nightBasePending,false);assert.equal((f.s.checkpoint.nightBase as any).phase,'done');
});
test('failed distant night approach releases the pending base for a local shelter without spending or resetting resource budgets',async()=>{
 const f=fixture();f.bot.entity.position=new Vec3(3.5,64,-10.5);f.s.checkpoint.resourceRecovery={sand:{destinationsUsed:5}};
 f.s.near=async()=>{throw new ConditionWait('no observed route',f.s.checkpoint);};
 assert.equal(await restInWarehouse(f.s,()=>true),false);assert.equal(f.s.checkpoint.nightBasePending,false);assert.equal(f.toggles,0);
 assert.deepEqual(f.s.checkpoint.resourceRecovery,{sand:{destinationsUsed:5}});
 assert.equal((f.s.checkpoint.nightBaseApproachFailure as any).reason,'no observed route');
});
test('night approach failure beside a door retains the passage checkpoint',async()=>{
 const f=fixture();f.s.near=async()=>{throw new ConditionWait('threshold blocked',f.s.checkpoint);};
 await assert.rejects(restInWarehouse(f.s,()=>true),ConditionWait);assert.equal(f.s.checkpoint.nightBasePending,true);assert.equal(f.toggles,0);
});
test('an interrupted approach to a distant unloaded warehouse does not pin a new body outside',async()=>{
 const f=fixture();f.bot.entity.position=new Vec3(3.5,64,-100.5);f.s.checkpoint.nightBasePending=true;f.cells.set('3,68,2','air');
 assert.equal(await restInWarehouse(f.s,()=>true),false);assert.equal(f.s.checkpoint.nightBasePending,false);assert.equal(f.toggles,0);
 const closed=fixture();closed.s.checkpoint.nightBasePending=true;closed.s.checkpoint.nightBase={phase:'closed'};closed.cells.set('3,68,2','air');
 await assert.rejects(restInWarehouse(closed.s,()=>true),ConditionWait);assert.equal(closed.s.checkpoint.nightBasePending,true);
});
for(const defect of ['permission','roof','wrong-world','inside-threat'])test(`warehouse shelter refuses ${defect} without door or world changes`,async()=>{
 const f=fixture();if(defect==='roof')f.cells.set('3,68,2','air');if(defect==='wrong-world')f.s.rules.baseShelter!.world='other';if(defect==='inside-threat')f.bot.entities[5]={name:'zombie',position:new Vec3(3.5,65,2.5)} as any;
 assert.equal(await restInWarehouse(f.s,()=>defect!=='permission'),false);assert.equal(f.toggles,0);assert.equal(f.s.observations.length,0);
});
test('only the actual open, non-obstructing wooden door shape permits a centered walking body',()=>{
 const block=(open:boolean,name='oak_door',shapes=[[0,0,0,.1875,1,1]])=>({name,shapes,getProperties:()=>({open})}) as any;
 assert.equal(openDoorClearance(block(true)),true);assert.equal(openDoorClearance(block(false)),false);assert.equal(openDoorClearance(block(true,'iron_door')),false);assert.equal(openDoorClearance(block(true,'oak_door',[[0,0,0,1,1,1]])),false);
});

test('normal daytime base entry and exit close their door without creating a night wait',async()=>{
 const f=fixture();f.bot.time.isDay=true;f.bot.time.timeOfDay=0;
 assert.equal(await restInWarehouse(f.s,()=>true,undefined,'enter'),true);assert.equal(f.opened,false);assert.equal(Math.floor(f.bot.entity.position.y),65);assert.equal(f.s.checkpoint.nightBasePending,undefined);
 assert.equal(await restInWarehouse(f.s,()=>true,undefined,'exit'),true);assert.equal(f.opened,false);assert.equal(Math.floor(f.bot.entity.position.y),64);assert.equal(f.toggles,4);
});


test('daytime exit first approaches the doorway from a deeper closed room',async()=>{
 const f=fixture();f.bot.time.isDay=true;f.bot.time.timeOfDay=0;f.bot.entity.position=new Vec3(3.4047,65,2.3815);
 assert.equal(await restInWarehouse(f.s,()=>true,undefined,'exit'),true);assert.equal(f.opened,false);assert.equal(f.toggles,2);assert.equal(Math.round(f.bot.entity.position.y),64);
});

test('two workers serialize a full door passage and release the lease after cancellation',async()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'laya-door-')),events:string[]=[];
 f.s.pause=async()=>{await new Promise(r=>setTimeout(r,2));};
 let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{ready=r;});
 try{
  const first=withWarehouseDoor(f.s,async()=>{events.push('first-open');ready();await gate;events.push('first-close');},dir);
  await started;
  const second=withWarehouseDoor(f.s,async()=>{events.push('second-open');throw Error('cancelled passage');},dir);second.catch(()=>{});
  await new Promise(r=>setTimeout(r,10));assert.deepEqual(events,['first-open']);release();await first;await assert.rejects(second,/cancelled passage/);
  assert.deepEqual(events,['first-open','first-close','second-open']);assert.equal(readdirSync(dir).filter(p=>p.endsWith('.lock')).length,1,'stable lock inode is retained for queued workers');
  await withWarehouseDoor(f.s,async()=>events.push('third-open'),dir);assert.equal(events.at(-1),'third-open');
 }finally{release();rmSync(dir,{recursive:true,force:true});}
});

test('warehouse wait reacts to observed door/daylight changes without replenishing resource budgets',()=>{
 const f=fixture();f.bot.entity.position=new Vec3(f.base.inside.x+.5,f.base.inside.y,f.base.inside.z+.5);
 f.s.checkpoint.nightBasePending=true;f.s.checkpoint.nightBase={door:f.base.door,phase:'closed'};f.s.checkpoint.resourceRecovery={$food:{destinationsUsed:5}};
 const knowledge={blocks:new Map()};const initial=foodRecoveryFingerprint(f.bot,f.s.checkpoint,6,knowledge);
 f.bot.time.timeOfDay=14000;assert.equal(foodRecoveryFingerprint(f.bot,f.s.checkpoint,6,knowledge),initial);
 f.bot.time.timeOfDay=0;f.bot.time.isDay=true;assert.notEqual(foodRecoveryFingerprint(f.bot,f.s.checkpoint,6,knowledge),initial);
 f.bot.time.timeOfDay=13000;f.bot.time.isDay=false;
 void f.bot.activateBlock(f.bot.blockAt(new Vec3(f.base.door.x,f.base.door.y,f.base.door.z))!);
 assert.notEqual(foodRecoveryFingerprint(f.bot,f.s.checkpoint,6,knowledge),initial);
 assert.equal((f.s.checkpoint.resourceRecovery as any).$food.destinationsUsed,5);
});

test('a killed worker releases the shared door lock for the next worker',async()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'laya-door-crash-'));
 const code="const {withWarehouseDoor}=require('./packages/minecraft/src/warehouse-door-lease');const p=JSON.parse(process.argv[1]);const s={rules:{baseShelter:p.base},signal:new AbortController().signal,check(){},progress(){}};withWarehouseDoor(s,async()=>{process.stdout.write('held\\n');await new Promise(()=>{});},p.dir).catch(e=>{console.error(e);process.exit(1);});";
 const child=spawn(process.execPath,['--import','tsx','-e',code,JSON.stringify({base:f.base,dir})],{stdio:['ignore','pipe','pipe']});child.stderr.resume();
 try{
  await once(child.stdout,'data');const ended=once(child,'exit');child.kill('SIGKILL');await ended;
  let acquired=false;await withWarehouseDoor(f.s,async()=>{acquired=true;},dir);assert.equal(acquired,true);
 }finally{child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});
