import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import {alternateSafeWalk} from '../packages/minecraft/src/safe-walk';
import { observedGroundApproach, observedGroundRoute, observedGroundStand } from '../packages/minecraft/src/observed-ground-walk';

function fixture(){
  const cells=new Map<string,string>();let loaded=(p:Vec3)=>true;
  const route=Array.from({length:90},(_,i)=>({x:i+1,y:64,z:0,toBreak:[] as unknown[],toPlace:[] as unknown[],parkour:false}));
  const bot={entity:{position:new Vec3(.5,64,.5)},entities:{} as Record<string,{name:string;position:Vec3}>,blockAt(p:Vec3){if(!loaded(p))return null;const name=cells.get(p.toString())??(p.y<64?'stone':'air');return{name,position:p,shapes:[[0,0,0,1,1,1]],boundingBox:['air','water','lava','bush','firefly_bush','short_dry_grass','tall_dry_grass','sweet_berry_bush','dandelion'].includes(name)?'empty':'block'};},pathfinder:{movements:{canDig:false,allow1by1towers:false},getPathTo:()=>({status:'success',path:route})}};
  return{bot:bot as unknown as Bot,raw:bot,cells,route,set loaded(fn:typeof loaded){loaded=fn;}};
}

test('a loaded natural return can exceed the nearby search radius while a deep neighboring gap remains outside its verified steps',()=>{
  const f=fixture();for(let y=60;y<=63;y++)f.cells.set(new Vec3(30,y,1).toString(),'air');
  const route=observedGroundRoute(f.bot,{x:90,y:64,z:0});assert.equal(route?.length,90);
  assert.equal(observedGroundStand(f.bot,{x:30,y:64,z:0}),true);assert.equal(observedGroundStand(f.bot,{x:30,y:64,z:1}),false);
});

test('the entire return rejects unloaded ground, unstable support, hazards, threats and paths requiring world changes',()=>{
  for(const defect of ['unloaded','leaves','lava','threat','dig','place','parkour','large-drop','wrong-end']){
    const f=fixture(),p=new Vec3(45,63,0);
    if(defect==='unloaded')f.loaded=q=>!q.equals(p);
    if(defect==='leaves')f.cells.set(p.toString(),'oak_leaves');
    if(defect==='lava')f.cells.set(p.offset(0,1,0).toString(),'lava');
    if(defect==='threat')f.raw.entities.bad={name:'skeleton',position:new Vec3(45,64,3)};
    if(defect==='dig')f.route[44]!.toBreak=[{x:45,y:64,z:0}];
    if(defect==='place')f.route[44]!.toPlace=[{x:45,y:63,z:0}];
    if(defect==='parkour')f.route[44]!.parkour=true;
    if(defect==='large-drop')f.route[44]!.y=61;
    if(defect==='wrong-end')f.route.pop();
    assert.equal(observedGroundRoute(f.bot,{x:90,y:64,z:0}),undefined,defect);
  }
});

test('a solid nonfalling surface over an observed cave remains a walking support without granting permission to fill it',()=>{
  const f=fixture();for(let y=58;y<=62;y++)f.cells.set(new Vec3(45,y,0).toString(),'air');
  assert.equal(observedGroundStand(f.bot,{x:45,y:64,z:0}),true);
  assert.equal(observedGroundRoute(f.bot,{x:90,y:64,z:0})?.length,90);
});


test('new empty-collision shrubs are traversable while a berry bush remains a hazard',()=>{
  const f=fixture(),p=new Vec3(45,64,0);
  for(const name of ['bush','firefly_bush','short_dry_grass','tall_dry_grass']){f.cells.set(p.toString(),name);assert.equal(observedGroundRoute(f.bot,{x:90,y:64,z:0})?.length,90,name);}
  f.cells.set(p.toString(),'sweet_berry_bush');assert.equal(observedGroundRoute(f.bot,{x:90,y:64,z:0}),undefined);
});

test('a read-only return can walk across an intact full utility floor and flowers without authorizing their excavation',()=>{
  const f=fixture();f.cells.set(new Vec3(45,63,0).toString(),'crafting_table');f.cells.set(new Vec3(46,64,0).toString(),'dandelion');
  assert.equal(observedGroundRoute(f.bot,{x:90,y:64,z:0})?.length,90);
  assert.equal(f.cells.get(new Vec3(45,63,0).toString()),'crafting_table');assert.equal(f.cells.get(new Vec3(46,64,0).toString()),'dandelion');
});

test('an intact exposed ore cube is a walking support and is left unmined',()=>{
  const f=fixture();f.cells.set(new Vec3(45,63,0).toString(),'copper_ore');
  assert.equal(observedGroundRoute(f.bot,{x:90,y:64,z:0})?.length,90);assert.equal(f.cells.get(new Vec3(45,63,0).toString()),'copper_ore');
});

test('a nearby construction goal can use its actual raised floor without standing inside the occupied target',()=>{
  const f=fixture(),target={x:0,y:63,z:0};
  f.raw.pathfinder.getPathTo=()=>({status:'success',path:[]});
  assert.deepEqual(observedGroundApproach(f.bot,target,1),[]);
  assert.equal(observedGroundApproach(f.bot,target,0),undefined);
  f.cells.set(new Vec3(0,64,0).toString(),'lava');
  assert.equal(observedGroundApproach(f.bot,target,1),undefined);
});

test('the farm shore option permits neighboring irrigation but still rejects standing in water',()=>{
  const f=fixture();f.cells.set(new Vec3(45,63,1).toString(),'water');
  assert.equal(observedGroundStand(f.bot,{x:45,y:64,z:0}),false);
  assert.equal(observedGroundStand(f.bot,{x:45,y:64,z:0},undefined,true),true);
  f.cells.set(new Vec3(45,64,0).toString(),'water');
  assert.equal(observedGroundStand(f.bot,{x:45,y:64,z:0},undefined,true),false);
});

test('a scoped shoreline walk accepts a proved two-block landing while larger drops remain rejected',()=>{
 for(const drop of [2,3]){
  const f=fixture();for(let x=45;x<=90;x++){f.route[x-1]!.y=64-drop;for(let y=64-drop;y<=63;y++)f.cells.set(new Vec3(x,y,0).toString(),'air');}
  assert.equal(observedGroundRoute(f.bot,{x:90,y:64-drop,z:0}),undefined);
  const route=observedGroundRoute(f.bot,{x:90,y:64-drop,z:0},128,undefined,true);assert.equal(route?.length,drop===2?90:undefined);
 }
});

test('a planned crop footprint stays outside the dry-bank walking route before anything is planted',()=>{
 const f=fixture(),plot={x:45,y:64,z:0};assert.equal(observedGroundRoute(f.bot,{x:90,y:64,z:0},128,undefined,true,p=>p.x===plot.x&&p.y===plot.y&&p.z===plot.z),undefined);
 assert.equal(f.cells.size,0);assert.equal(observedGroundRoute(f.bot,{x:90,y:64,z:0})?.length,90);
});


test('one bounded search bypasses an unusable closer work point and reaches another without world edits',()=>{
 const f=fixture();Object.assign(f.raw.pathfinder.movements,{getNeighbors(n:{x:number;y:number;z:number}){
  const move=(x:number,z:number,toBreak:unknown[]=[])=>({x,y:64,z,remainingBlocks:0,cost:1,toBreak,toPlace:[],parkour:false,hash:`${x},64,${z}`});
  if(n.x===0&&n.z===0)return[move(1,0,[{x:1,y:64,z:0}]),move(0,1)];
  if(n.x===0&&n.z===1)return[move(0,2)];return[];
 }});
 const path=alternateSafeWalk(f.bot,[{x:1,y:64,z:0},{x:0,y:64,z:2}],{within:p=>Math.abs(p.x)<=3&&Math.abs(p.z)<=3,stand:p=>observedGroundStand(f.bot,p),maxNodes:20});
 assert.deepEqual(path,[{x:0,y:64,z:1},{x:0,y:64,z:2}]);assert.equal(f.cells.size,0);
});
