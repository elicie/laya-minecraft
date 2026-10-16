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
