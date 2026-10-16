import test from 'node:test';
import assert from 'node:assert/strict';
import type {Bot} from 'mineflayer';
import {Vec3} from 'vec3';
import {coveredEgressPoint,coveredEgressRouteValid,planCoveredEgress} from '../packages/minecraft/src/covered-egress';
import {observedGroundStand} from '../packages/minecraft/src/observed-ground-walk';
import {restInSoilShaft} from '../packages/minecraft/src/night-soil-shaft';
import {RulesSchema} from '../packages/contracts/src';
import {ConditionWait,type ActionServices} from '../packages/minecraft/src/services';

function fixture(){
 const threat={id:2,name:'pillager',height:1.8,position:new Vec3(4,61,.5)},cells=new Map<string,string>();let hit:Vec3|undefined=new Vec3(2,63,0),rays=0;
 const bot={entity:{id:1,position:new Vec3(.5,64,.5),onGround:true},entities:{2:threat},time:{isDay:true},
  blockAt(p:Vec3){const name=cells.get(`${p.x},${p.y},${p.z}`)??(p.y<64?'dirt':'air');return {name,position:p,boundingBox:name==='air'?'empty':'block',shapes:name==='air'?[]:[[0,0,0,1,1,1]]};},
  world:{raycast(){rays++;return hit?{position:hit}:null;}},
  pathfinder:{movements:{getNeighbors(p:any){return [[1,0],[-1,0],[0,1],[0,-1]].map(([x,z])=>({...p,x:p.x+x!,z:p.z+z!,cost:1,toBreak:[],toPlace:[],parkour:false}));}}},inventory:{items:()=>[]},
 } as unknown as Bot;
 return {bot,threat,cells,get rays(){return rays;},set hit(value:Vec3|undefined){hit=value;}};
}

test('covered egress separately proves feet, torso and jump head cover and never uses the cap being removed',()=>{
 const f=fixture(),origin=new Vec3(0,64,0),cap=origin.offset(0,-1,0);
 assert.equal(observedGroundStand(f.bot,origin),false,'ordinary threat limits remain unchanged');
 assert.equal(coveredEgressPoint(f.bot,origin,cap),true);assert.equal(f.rays,3);
 f.hit=cap;assert.equal(coveredEgressPoint(f.bot,origin,cap),false);
 f.hit=undefined;assert.equal(coveredEgressPoint(f.bot,origin,cap),false);
 f.hit=new Vec3(2,63,0);f.cells.set('2,63,0','air');assert.equal(coveredEgressPoint(f.bot,origin,cap),false);
 f.cells.delete('2,63,0');let rays=0;(f.bot.world as any).raycast=()=>++rays===3?null:{position:new Vec3(2,63,0)};
 assert.equal(coveredEgressPoint(f.bot,origin,cap),false,'head exposure cannot be hidden by lower body cover');
});

test('covered egress refuses close or melee enemies and preserves safe endpoints and real terrain checks',()=>{
 const f=fixture(),origin=new Vec3(0,64,0),cap=origin.offset(0,-1,0);
 f.threat.name='zombie';assert.equal(coveredEgressPoint(f.bot,origin,cap),false);
 f.threat.name='skeleton';assert.equal(coveredEgressPoint(f.bot,origin,cap),false,'close bow or potion trajectories do not inherit crossbow egress permission');
 f.threat.name='pillager';f.threat.position=new Vec3(1,64,0);assert.equal(planCoveredEgress(f.bot,origin),undefined);
 f.threat.position=new Vec3(4,61,.5);const path=planCoveredEgress(f.bot,origin);assert.ok(path?.length);assert.equal(coveredEgressRouteValid(f.bot,origin,path!),true);
 assert.equal(coveredEgressRouteValid(f.bot,origin,[{x:-1,y:64,z:0}]),false,'a covered step alone is not a safe endpoint');
 const cell=path![0]!;f.cells.set(`${cell.x},${cell.y-1},${cell.z}`,'air');assert.equal(coveredEgressRouteValid(f.bot,origin,path!),false);
});

test('a resumed covered escape preserves the original restored soil and finishes its saved walk without new digging or search budgets',async()=>{
 const f=fixture(),path=Array.from({length:9},(_,i)=>({x:-i-1,y:64,z:0}));let moved=0;
 const s={bot:f.bot,checkpoint:{nightSoilShaft:{outside:{x:0,y:64,z:0},phase:'escaping',dug:3,initialDirt:0,exitAttempts:3},nightSoilEgress:{path,walked:0},resourceRecovery:{sand:{destinationsUsed:5,elapsedMs:60000}}},rules:RulesSchema.parse({}),observations:[],check(){},pause:async()=>{},progress(){},observeInventory:()=>({}),walkVerified:async(points:any[],stand:(p:any)=>boolean)=>{for(const p of points){assert.equal(stand(p),true);f.bot.entity.position=new Vec3(p.x+.5,p.y,p.z+.5);moved++;}return true;}} as unknown as ActionServices;
 await restInSoilShaft(s,()=>false,()=>true,()=>true);
 assert.equal(moved,9);assert.equal((s.checkpoint.nightSoilShaft as any).phase,'done');assert.equal(s.checkpoint.nightBurrowPending,false);assert.deepEqual(s.checkpoint.resourceRecovery,{sand:{destinationsUsed:5,elapsedMs:60000}});
 for(const d of [1,2,3])assert.equal(f.bot.blockAt(new Vec3(0,64-d,0))?.name,'dirt');
 (s.checkpoint.nightSoilShaft as any).phase='escaping';(f.bot.time as any).isDay=false;
 await assert.rejects(restInSoilShaft(s,()=>false,()=>true,()=>true),ConditionWait);assert.equal(moved,9);
 (f.bot.time as any).isDay=true;
 (s.checkpoint.nightSoilShaft as any).phase='escaping';(s.checkpoint.nightSoilEgress as any).walked=0;f.bot.entity.position=new Vec3(.5,64,.5);f.cells.set('0,62,0','air');
 await assert.rejects(restInSoilShaft(s,()=>false,()=>true,()=>false),ConditionWait);
});
