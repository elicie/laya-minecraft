import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { RulesSchema } from '../packages/contracts/src';
import { settleStandingFootprint } from '../packages/minecraft/src/standing-footprint';
import type { ActionServices } from '../packages/minecraft/src/services';
function fixture(){
 const cells=new Map<string,string>();const bot={health:20,food:20,entity:{position:new Vec3(.5,65,.7001),width:.6,onGround:true},entities:{} as Record<string,{name:string;position:Vec3}>,blockAt(p:Vec3){const name=cells.get(p.toString())??(p.y<=63?'dirt':'air');return {name,position:p,boundingBox:name==='air'?'empty':'block',shapes:name==='air'?[]:[[0,0,0,1,1,1]]};},pathfinder:{movements:{canDig:false,allow1by1towers:false},getPathTo:()=>({status:'success',path:[{x:0,y:65,z:1,toBreak:[],toPlace:[],parkour:false}]})}};
 cells.set(new Vec3(0,64,1).toString(),'grass_block');let attempts=0,moved=0;
 const s={bot,rules:RulesSchema.parse({}),checkpoint:{},check(){},async pause(){},async near(p:{x:number;y:number;z:number}){moved++;bot.entity.position=new Vec3(p.x,p.y,p.z);}} as unknown as ActionServices;
 return {bot:bot as unknown as Bot,raw:bot,s,cells,attempt:()=>{attempts++;},get attempts(){return attempts;},get moved(){return moved;}};
}
test('a stable actual collision overlap permits just the already supporting adjacent cell',async()=>{const f=fixture();assert.equal(await settleStandingFootprint(f.bot,f.s,f.attempt),true);assert.equal(f.attempts,1);assert.equal(f.moved,1);assert.equal(f.cells.get(new Vec3(0,64,1).toString()),'grass_block');});
for(const defect of ['no-overlap','airborne','threat','blocked-body','unstable-support','world-edits'])test(`footprint settlement refuses ${defect}`,async()=>{
 const f=fixture();if(defect==='no-overlap')f.raw.entity.position.z=.69;if(defect==='airborne')f.raw.entity.onGround=false;if(defect==='threat')f.raw.entities.bad={name:'skeleton',position:new Vec3(2,65,0)};if(defect==='blocked-body')f.cells.set(new Vec3(0,65,0).toString(),'stone');if(defect==='unstable-support')f.cells.set(new Vec3(0,64,1).toString(),'sand');if(defect==='world-edits')f.raw.pathfinder.movements.canDig=true;
 assert.equal(await settleStandingFootprint(f.bot,f.s,f.attempt),false);assert.equal(f.attempts,0);assert.equal(f.moved,0);
});
