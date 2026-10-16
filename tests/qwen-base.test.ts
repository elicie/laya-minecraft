import test from 'node:test';
import assert from 'node:assert/strict';
import {BASE_DECISION_QUESTION,LayaClient} from '../packages/models/src';
const candidates=[{id:'opaque-seed-task',description:'Seeds for the field',action:'seed_supply'},{id:'opaque-wood-task',description:'Tool materials',action:'wood_supply'}],state=JSON.stringify({health:20,food:20,warehouse:{items:[{name:'oak_log',count:1}]},targets:{seeds:8}});
function response(choice='seed_supply',confidence=.8){const probabilities=Object.fromEntries(Object.keys(BASE_DECISION_QUESTION.criteria).map(k=>[k,k===choice?confidence:(1-confidence)/11]));return{backend:'qwen',model:'mock-base-adapter',state_truncated:false,calibrated:true,answers:{base_action:{choice,probabilities}}};}
test('Qwen uses the fixed trained question and maps a canonical score only to a current executable task',async()=>{
 let called=false;const client=new LayaClient({qwenUrl:'http://model.invalid',fetchImpl:async(_url,init)=>{called=true;const request=JSON.parse(String(init!.body));assert.equal(request.task,'base_action');assert.deepEqual(request.questions,{base_action:BASE_DECISION_QUESTION});assert.ok(request.state.includes('available_actions=seed_supply,wood_supply'));assert.equal(request.questions.base_action.criteria['opaque-seed-task'],undefined);return new Response(JSON.stringify(response()));}});
 const choice=await client.choose({state,candidates});assert.equal(called,true);assert.equal(choice.id,'opaque-seed-task');assert.equal(choice.source,'laya');assert.equal(choice.model,'mock-base-adapter');assert.equal(choice.confidence,.8);
});
for(const defect of ['unavailable','low-confidence','missing-probability','wrong-total','not-argmax','truncated','wrong-backend','server-rejected'])test(`Qwen base guard falls back on ${defect}`,async()=>{
 const value=response(defect==='unavailable'?'farm_harvest':'seed_supply',defect==='low-confidence'?.4:.8);
 if(defect==='missing-probability')delete value.answers.base_action.probabilities.wait;
 if(defect==='wrong-total')value.answers.base_action.probabilities.wait=.8;
 if(defect==='not-argmax'){value.answers.base_action.probabilities.seed_supply=.6;value.answers.base_action.probabilities.wood_supply=.7;}
 if(defect==='truncated')value.state_truncated=true;if(defect==='wrong-backend')value.backend='generic';
 const client=new LayaClient({qwenUrl:'http://model.invalid',fetchImpl:async()=>new Response(JSON.stringify(value),{status:defect==='server-rejected'?400:200})});
 const choice=await client.choose({state,candidates});assert.equal(choice.id,'opaque-seed-task');assert.equal(choice.source,'code');
});
test('unknown actions and oversized observations never call the fixed-task model',async()=>{
 const client=new LayaClient({qwenUrl:'http://model.invalid',fetchImpl:async()=>{assert.fail('unsupported input must not call the model');}});
 assert.equal((await client.choose({state,candidates:[{id:'unknown',description:'unsupported'}]})).source,'code');
 assert.equal((await client.choose({state:JSON.stringify({observation:'x'.repeat(6000)}),candidates})).source,'code');
});
