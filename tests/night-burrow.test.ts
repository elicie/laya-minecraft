import test from 'node:test';
import assert from 'node:assert/strict';
import type {Bot} from 'mineflayer';
import {Vec3} from 'vec3';
import {duskOrNight,restInNightBurrow} from '../packages/minecraft/src/night-burrow';
import {ConditionWait,type ActionServices} from '../packages/minecraft/src/services';
import {RulesSchema} from '../packages/contracts/src';
function fixture(opened:boolean){
 const checkpoint:ActionServices['checkpoint']={nightBurrow:{outside:{x:0,y:64,z:0},direction:{x:1,y:0,z:0},phase:'digging'},nightBurrowPending:true,nightBurrowChecked:['0,0']};
 let moves=0;const bot={entity:{position:new Vec3(12.5,64,.5)},entities:{},time:{doDaylightCycle:true,isDay:true},blockAt(p:Vec3){const air=opened&&p.x===1&&p.y===65&&p.z===0;return{name:air?'air':'dirt',boundingBox:air?'empty':'block',shapes:air?[]:[[0,0,0,1,1,1]],position:p};}} as unknown as Bot;
 const s={bot,checkpoint,rules:RulesSchema.parse({}),observations:[],evidence:[],signal:new AbortController().signal,check(){},pause:async()=>{},near:async()=>{moves++;throw new ConditionWait('partial excavation remains pending');},progress(){}} as unknown as ActionServices;
 return {s,get moves(){return moves;}};
}
test('a physically displaced body discards an untouched night site while retaining its checked region',async()=>{
 const f=fixture(false);assert.equal(await restInNightBurrow(f.s,()=>false,()=>true),false);assert.equal(f.s.checkpoint.nightBurrow,undefined);assert.equal(f.s.checkpoint.nightBurrowPending,false);assert.equal((f.s.checkpoint.nightBurrowAbandoned as unknown[]).length,1);assert.deepEqual(f.s.checkpoint.nightBurrowChecked,['0,0']);assert.equal(f.moves,0);
});
test('a partly excavated shelter is preserved after displacement so its real world edits are not forgotten',async()=>{
 const f=fixture(true);await assert.rejects(restInNightBurrow(f.s,()=>false,()=>true),ConditionWait);assert.equal((f.s.checkpoint.nightBurrow as {phase:string}).phase,'digging');assert.equal(f.s.checkpoint.nightBurrowPending,true);assert.equal(f.s.checkpoint.nightBurrowAbandoned,undefined);assert.equal(f.moves,1);
});

test("shelter preparation starts before hostile night spawning and releases on actual dawn",()=>{
 for(const [time,isDay,expected] of [[0,true,false],[8999,true,false],[9000,true,true],[12500,true,true],[18000,false,true],[23000,true,false],[23999,true,false]] as const)assert.equal(duskOrNight({time:{timeOfDay:time,isDay}} as Pick<Bot,"time">),expected);
});
