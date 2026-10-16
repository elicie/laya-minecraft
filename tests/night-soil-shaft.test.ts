import test from 'node:test';
import assert from 'node:assert/strict';
import type {Bot} from 'mineflayer';
import {Vec3} from 'vec3';
import {RulesSchema} from '../packages/contracts/src';
import {restInSoilShaft} from '../packages/minecraft/src/night-soil-shaft';
import {ConditionWait,type ActionServices} from '../packages/minecraft/src/services';

function fixture(){
 const cells=new Map<string,string>();let edits=0;
 const bot={entity:{id:1,position:new Vec3(.5,64,.5),onGround:true},health:20,food:20,time:{doDaylightCycle:true},entities:{},inventory:{items:()=>[]},pathfinder:{setGoal(){}},clearControlStates(){},blockAt(p:Vec3){const name=cells.get(`${p.x},${p.y},${p.z}`)??(p.y>=64?'air':p.y>=61?'dirt':'stone');return{name,position:p,boundingBox:name==='air'?'empty':'block',shapes:name==='air'?[]:[[0,0,0,1,1,1]]};},async dig(){edits++;}} as unknown as Bot;
 const s={bot,checkpoint:{resourceRecovery:{sand:{destinationsUsed:5,elapsedMs:60000}}},rules:RulesSchema.parse({}),observations:[],check(){},pause:async()=>{},progress(){},observeInventory:()=>({}),place:async()=>{edits++;}} as unknown as ActionServices;
 return {bot,s,cells,get edits(){return edits;}};
}
for(const defect of ['permission','protected','short-soil','unknown-floor','side-cavity','falling-floor','wet-floor','near-player'] as const)test(`flat shelter refuses ${defect} before any digging or placement`,async()=>{
 const f=fixture();
 if(defect==='short-soil')f.cells.set('0,62,0','stone');
 if(defect==='unknown-floor')f.cells.set('0,60,0','air');
 if(defect==='side-cavity')f.cells.set('1,62,0','air');
 if(defect==='falling-floor')f.cells.set('0,60,0','sand');
 if(defect==='wet-floor')f.cells.set('0,60,0','water');
 if(defect==='near-player')f.bot.entities[2]={id:2,type:'player',username:'Neighbor',position:new Vec3(1.5,64,.5)} as any;
 assert.equal(await restInSoilShaft(f.s,()=>defect==='protected',()=>defect!=='permission',()=>true),false);assert.equal(f.edits,0);assert.equal(f.s.checkpoint.nightSoilShaft,undefined);
 assert.deepEqual(f.s.checkpoint.resourceRecovery,{sand:{destinationsUsed:5,elapsedMs:60000}});
});
test('a resumed closed shaft with a missing roof remains pending instead of reporting shelter or digging elsewhere',async()=>{
 const f=fixture();f.bot.entity.position=new Vec3(.5,61,.5);f.cells.set('0,61,0','air');f.cells.set('0,62,0','air');f.cells.set('0,63,0','air');
 f.s.checkpoint.nightSoilShaft={outside:{x:0,y:64,z:0},phase:'closed',dug:3,initialDirt:0,exitAttempts:0};
 await assert.rejects(restInSoilShaft(f.s,()=>false,()=>true,()=>true),ConditionWait);assert.equal(f.edits,0);assert.equal(f.s.checkpoint.nightBurrowPending,true);
});

test('a different new shelter archives the old escape route instead of reopening at dusk for a completed old trip',async()=>{
 const f=fixture();f.bot.entity.position=new Vec3(.5,61,.5);f.cells.set('0,61,0','air');f.cells.set('0,62,0','air');
 f.s.checkpoint.nightSoilShaft={outside:{x:0,y:64,z:0},phase:'closed',dug:3,initialDirt:0,exitAttempts:0};
 f.s.checkpoint.nightSoilEgress={origin:{x:20,y:64,z:0},path:[{x:19,y:64,z:0}],walked:1};
 f.s.check=()=>{throw new ConditionWait('fixture boundary');};
 await assert.rejects(restInSoilShaft(f.s,()=>false,()=>true,()=>true),ConditionWait);
 assert.equal(f.s.checkpoint.nightSoilEgress,undefined);assert.equal((f.s.checkpoint.nightSoilEgressHistory as any[]).length,1);assert.equal(f.edits,0);
});

test('a restored climbing checkpoint reseals its own open cap if night arrived before the first jump',async()=>{
 const f=fixture();f.bot.entity.position=new Vec3(.5,61,.5);for(const y of [61,62,63])f.cells.set(`0,${y},0`,'air');
 f.s.checkpoint.nightSoilShaft={outside:{x:0,y:64,z:0},phase:'climbing',dug:3,initialDirt:0,exitAttempts:0};
 let dirt=3;(f.bot.inventory as any).items=()=>[{name:'dirt',count:dirt}];
 f.s.place=async(p)=>{assert.deepEqual(p,{x:0,y:63,z:0});f.cells.set('0,63,0','dirt');dirt--;};
 f.s.check=()=>{throw new ConditionWait('fixture boundary');};
 await assert.rejects(restInSoilShaft(f.s,()=>false,()=>true,()=>true),ConditionWait);
 assert.equal(f.cells.get('0,63,0'),'dirt');assert.equal(dirt,2);assert.equal((f.s.checkpoint.nightSoilShaft as any).phase,'closed');assert.equal((f.s.checkpoint.nightSoilShaft as any).exitAttempts,0);
});

test('an unthreatened shelter at daylight dusk keeps its roof closed instead of inventing an evacuation',async()=>{
 const f=fixture();f.bot.entity.position=new Vec3(.5,61,.5);f.cells.set('0,61,0','air');f.cells.set('0,62,0','air');
 (f.bot.time as any).isDay=true;(f.bot as any).world={raycast:()=>null};
 (f.bot.pathfinder as any).movements={getNeighbors:(p:any)=>[[1,0],[-1,0],[0,1],[0,-1]].map(([x,z])=>({...p,x:p.x+x!,z:p.z+z!,cost:1,toBreak:[],toPlace:[],parkour:false}))};
 f.s.checkpoint.nightSoilShaft={outside:{x:0,y:64,z:0},phase:'closed',dug:3,initialDirt:0,exitAttempts:0};
 let checks=0;f.s.check=()=>{if(++checks>2)throw new ConditionWait('fixture boundary');};
 await assert.rejects(restInSoilShaft(f.s,()=>false,()=>true,()=>true),ConditionWait);
 assert.equal(f.s.checkpoint.nightSoilEgress,undefined);assert.equal((f.s.checkpoint.nightSoilShaft as any).phase,'closed');assert.equal(f.edits,0);
});
