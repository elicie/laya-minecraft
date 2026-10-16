import test from 'node:test';
import assert from 'node:assert/strict';
import {idleResourceTaskCanYield} from '../packages/core/src/resource-affinity';
import type {Task,BotReport} from '../packages/contracts/src';
const task=()=>({kind:'collect',state:'condition-wait',params:{returnTo:{x:59,y:68,z:4}},checkpoint:{waitingFor:{kind:'blocks',causeCode:'BUILD_ACCESS'}}}) as unknown as Task;
const report=(x=59)=>({position:{x,y:69,z:4}}) as BotReport;
test('an idle returning collector at home yields to food work while retaining its exact resource checkpoint',()=>{
 const t=task(),before=structuredClone(t);assert.equal(idleResourceTaskCanYield(t,report(),false),true);assert.deepEqual(t,before);
 t.checkpoint.resourceTrip={phase:'complete',trail:[{x:59,y:68,z:4}],returns:2};assert.equal(idleResourceTaskCanYield(t,report(),false),true);
});
test('active, outbound, returning or displaced collectors keep actor ownership',()=>{
 const t=task();assert.equal(idleResourceTaskCanYield(t,report(),true),false);assert.equal(idleResourceTaskCanYield(t,report(100),false),false);
 for(const phase of ['outbound','returning']){t.checkpoint.resourceTrip={phase};assert.equal(idleResourceTaskCanYield(t,report(),false),false);}
 delete t.checkpoint.resourceTrip;delete t.checkpoint.waitingFor;assert.equal(idleResourceTaskCanYield(t,report(),false),false);
});
