import assert from 'node:assert/strict';
import test from 'node:test';
import type {Bot} from 'mineflayer';
import {Vec3} from 'vec3';
import {RulesSchema,type Position} from '../packages/contracts/src';
import {blueprint} from '../packages/contracts/src/blueprints';
import {warehouseShelter} from '../packages/core/src/warehouse-shelter';
import {restInWarehouse} from '../packages/minecraft/src/base-shelter';
import {openDoorClearance} from '../packages/minecraft/src/open-door';
import type {ActionServices} from '../packages/minecraft/src/services';

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
test('a registered real building opens and closes its door, waits for daylight and outside threat clearance, and resumes outside',async()=>{
 const f=fixture();assert.equal(await restInWarehouse(f.s,()=>true),true);assert.equal(f.toggles,4);assert.equal(f.opened,false);assert.equal(f.waits,2);assert.ok(f.bot.entity.position.distanceTo(new Vec3(3.5,64,-.5))<.15);assert.equal(f.s.checkpoint.nightBasePending,false);assert.equal((f.s.checkpoint.nightBase as any).phase,'done');
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
