import test from 'node:test';
import assert from 'node:assert/strict';
import type {Bot} from 'mineflayer';
import {RulesSchema,ObservationInputSchema,type Observation} from '../packages/contracts/src';
import {passiveFarmObservation} from '../packages/minecraft/src/farm-observation';
import {verifyCompletion} from '../packages/core/src';
test('passive farm samples observe actual maturity without completing work or moving the bot',()=>{
 const rules=RulesSchema.parse({baseAutonomy:{id:'field',origin:{x:0,y:63,z:0},positions:[{x:1,y:63,z:0},{x:1,y:63,z:1}]}});let age=6;
 const bot={blockAt(p:{x:number;y:number;z:number}){return{name:p.x===0?'water':p.y===63?'farmland':'wheat',getProperties:()=>({age})};}} as unknown as Bot;
 let sample=passiveFarmObservation(bot,rules,1000)!;ObservationInputSchema.parse(sample);assert.equal(sample.kind,'farm');if(sample.kind!=='farm')return;
 assert.equal(sample.data.ripe,0);age=7;sample=passiveFarmObservation(bot,rules,1000)!;assert.equal(sample.kind==='farm'&&sample.data.ripe,2);
 const observation={...sample,receivedAt:1000,controllerEpoch:'epoch',botId:'farmer',sessionId:'session'} as Observation;
 const verified=verifyCompletion({kind:'farm',mode:'setup',crop:'wheat',plots:2},{observations:[observation],now:1000,maxAgeMs:30000,world:rules.world,dimension:rules.dimension});
 assert.equal(verified.complete,false,'a background sample is planning evidence, not execution completion evidence');
});
