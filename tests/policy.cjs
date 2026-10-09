const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {Vec3}=require('vec3')
const {createSurvivalPolicy,allowedActions,describeObservation,normalizeObservation,rewardFor,questions}=require('../survival-policy')
const {createFoodManager}=require('../food-manager'),{correctPolicy}=require('../policy-feedback')
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-policy-'))
const base={goal:'dragon',health:20,hunger:13,urgent:true,target:1,safe:0,raw:4,wheat:0,prey:0,ripe:0,growing:false,checkDue:true,farmReady:false,deaths:0,blocked:[]}
const response=(choice='cook',probability=.9,extra={})=>({ok:true,json:async()=>({model:'test-policy',answers:{food_action:{choice,probabilities:{[choice]:probability}}},...extra})})
function policy(fetchImpl){let sequence=0;const events=[];return {events,agent:createSurvivalPolicy({fetchImpl,log:event=>{const id='decision-'+(++sequence);events.push({...event,id});return id},experienceFile:path.join(temp,'experiences-'+Math.random()+'.jsonl')})}}
async function main(){
 try{
  const valid=policy(async(url,request)=>{const body=JSON.parse(request.body);assert.equal(body.state,describeObservation(base));assert.deepEqual(body.questions,questions);return response()})
  const decision=await valid.agent.decide(base);assert.equal(decision.source,'laya');assert.equal(decision.action,'cook');assert(decision.allowed.includes('cook'))
  valid.agent.outcome(decision,'cook',true,{...base,raw:0,safe:4})
  const outcome=valid.events.at(-1);assert.equal(outcome.type,'policy_outcome');assert(!outcome.trainingEligible);assert.equal(outcome.labelStatus,'unreviewed');assert(Number.isFinite(outcome.reward));assert.equal(outcome.rewardVersion,'food-v1-provisional');assert(!outcome.terminal)
  valid.agent.outcome(decision,'cook',false,{...base,health:0,deaths:1},'died');assert(valid.events.at(-1).terminal);assert(valid.events.at(-1).rewardParts.death<0)
  for(const fetchImpl of [async()=>{throw new Error('offline')},async()=>({ok:false,status:503}),async()=>response('eat'),async()=>response('cook',.4),async()=>response('cook',2),async()=>response('cook',.9,{state_truncated:true}),async()=>response('cook',.9,{usage:{truncated:true}}),async()=>({ok:true,json:async()=>({answers:{}})})]){
   const failed=await policy(fetchImpl).agent.decide(base);assert.equal(failed.source,'fallback');assert.equal(failed.action,'cook');assert(failed.error)
  }
  assert.deepEqual(allowedActions({...base,health:6}),['stop','cook']); assert(allowedActions({...base,health:1,safe:1}).includes('eat')); assert(allowedActions({...base,health:1,raw:0,ripe:3}).includes('farm'))
  assert(!allowedActions({...base,safe:0}).includes('eat'))
  assert(!allowedActions({...base,prey:1,health:9}).includes('hunt'))
  assert(!allowedActions({...base,blocked:['cook']}).includes('cook'))
  assert.deepEqual(normalizeObservation({...base,blocked:['cook','constructor','cook']}).blocked,['cook'])
  assert.equal(normalizeObservation({...base,health:Infinity,hunger:-1,target:500}).target,64)
  const recovery=rewardFor(base,{...base,hunger:19,safe:1},{ok:true,elapsed_ms:2000}),damage=rewardFor(base,{...base,health:15},{ok:false,elapsed_ms:2000});assert(recovery.value>0);assert(damage.value<0)
  await execution();feedback()
  console.log('PASS trained-policy request schema, unavailable/low-confidence/truncated/illegal answer fallback, safety guards, measured outcomes/rewards, execution/replanning/cancellation and human-only correction with evaluation isolation')
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
}
async function execution(){
 let inventory=[{name:'mutton',count:1}],generation=0,failCook=false;const calls=[],observations=[],outcomes=[]
 const bot={health:20,food:13,inventory:{items:()=>inventory.filter(i=>i.count)},entity:{position:new Vec3(0,64,0)},entities:{}}
 const check=token=>assert.equal(token,generation,'cancelled')
 const hooks={check,goal:()=> 'dragon',world:{farmStatus:()=>({farms:[]})},sleep:async()=>{},policy:{decide:async observation=>{observations.push(observation);return {action:observation.blocked.includes('cook')?'explore':observation.safe?'eat':'cook',source:'laya',observation}},outcome:(...args)=>outcomes.push(args)},skills:{cook:async()=>{calls.push('cook');if(failCook)throw new Error('No fuel route');inventory=[{name:'cooked_mutton',count:1}]},eat:async()=>{calls.push('eat');assert(inventory.some(i=>i.name==='cooked_mutton'));inventory=[];bot.food=20}},explore:async()=>{calls.push('explore')}}
 const manager=createFoodManager(bot,hooks);await manager.step(0,{target:1,urgent:true});const eaten=await manager.step(0,{target:1,urgent:true});assert.deepEqual(calls,['cook','eat']);assert(eaten.ready);assert(observations.every(o=>o.goal==='dragon'));assert.equal(outcomes[1][3].hunger,20)
  // Failed skills enter the next real observation, rather than consuming the goal.
 inventory=[{name:'mutton',count:1}];failCook=true;calls.length=0;outcomes.length=0
 await manager.step(0,{target:1,urgent:true});assert.deepEqual(calls,['cook','explore']);assert(observations.at(-1).blocked.includes('cook'));assert.equal(outcomes[0][2],false);assert.equal(outcomes[1][2],true)
 const outcomeCount=outcomes.length;const cancelled=createFoodManager(bot,{...hooks,skills:{cook:async()=>{generation++}},policy:{...hooks.policy,decide:async observation=>({action:'cook',source:'laya',observation})}})
 await assert.rejects(()=>cancelled.step(0,{target:1,urgent:true}),/cancelled/);assert.equal(outcomes.length,outcomeCount,'interruption must not become a failed food example')
 // The growth deadline is preserved, while new edible inventory remains visible.
 generation=0;inventory=[];const deadline=Date.now()+30000,waitingPolicy={decide:async observation=>{assert(!observation.checkDue);return {action:'wait',source:'laya',observation}},outcome:()=>{}}
 const waiting=createFoodManager(bot,{...hooks,policy:waitingPolicy,world:{farmStatus:()=>({farms:[{complete:true,ripe:0,crop:'wheat'}]}),farm:async()=>({waiting:true,nextCheck:deadline})}})
 waitingPolicy.decide=async observation=>({action:'farm',source:'laya',observation});await waiting.step(0,{target:1,urgent:true});waitingPolicy.decide=async observation=>{assert(!observation.checkDue);return {action:'wait',source:'laya',observation}}
 assert.equal((await waiting.step(0,{target:1,urgent:true})).nextCheck,deadline)
}
function feedback(){
 const root=path.join(temp,'feedback');fs.mkdirSync(path.join(root,'logs'),{recursive:true});fs.mkdirSync(path.join(root,'training/data/food'),{recursive:true})
 const event={type:'policy_decision',id:'fixture',state:describeObservation(base),observation:base,allowed:allowedActions(base),proposed:'cook'}
 fs.writeFileSync(path.join(root,'logs/events.jsonl'),JSON.stringify(event)+'\n');const events=[]
 assert.equal(correctPolicy('fixture','cook',{root,reviewer:'test-reviewer',logImpl:e=>events.push(e)}),'cook')
 const row=JSON.parse(fs.readFileSync(path.join(root,'training/data/food/corrections.jsonl'),'utf8'));assert.equal(row.source,'human_correction');assert.equal(row.expected.food_action,'cook');assert.equal(row.reviewer,'test-reviewer')
 assert.throws(()=>correctPolicy('fixture','eat',{root}),/실행할 수 없는/)
 assert.throws(()=>correctPolicy('fixture','constructor',{root}),/등록된/)
 assert.throws(()=>correctPolicy('missing','cook',{root}),/기록을 찾지/)
 fs.writeFileSync(path.join(root,'training/data/food/eval.jsonl'),JSON.stringify({state:event.state})+'\n')
 assert.throws(()=>correctPolicy('fixture','cook',{root}),/고정 평가/);assert.equal(events.length,1)
}
main().catch(error=>{console.error(error);process.exit(1)})
