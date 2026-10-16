import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Bot} from 'mineflayer';
import {GoalInputSchema,RulesSchema,MaterialAccessPlanSchema,type Goal,type TaskSpec} from '../packages/contracts/src';
import {FleetController,planGoal} from '../packages/core/src';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {prepareMaterialAccess} from '../packages/minecraft/src/material-access';
import {ConditionWait} from '../packages/minecraft/src/services';
const plan=MaterialAccessPlanSchema.parse(JSON.parse(readFileSync('tests/fixtures/material-quarry-plan.json','utf8')));
test('only an explicit user quarry plan becomes bounded real block requirements and reservations',()=>{
 const input=GoalInputSchema.parse({kind:'build',source:'user',params:{mode:'material-access',access:plan}}),goal:Goal={id:'quarry',input,title:'quarry',state:'queued',taskIds:[],createdAt:0,updatedAt:0,progress:{current:0,target:1},generation:0};
 const planned=planGoal(goal,RulesSchema.parse({world:'127.0.0.1:25566'}),()=> 'access');assert.equal(planned.tasks.length,1);assert.equal(planned.tasks[0]!.completion.kind,'blocks');assert.equal(planned.tasks[0]!.reservationKeys.length,11);assert.equal(planned.tasks[0]!.source,'user');
 for(const params of [{...goal,input:{...input,source:'autonomous' as const}},{...goal,input:{...input,params:{mode:'material-access',access:{...plan,edits:[{...plan.edits[0],before:'chest'}]}}}}])assert.equal(planGoal(params,RulesSchema.parse({}),()=> 'bad').tasks.length,0);
});
test('quarry access refuses protected blocks, withdrawn permission and changed non-soil terrain before any world mutation',async()=>{
 for(const mode of ['protected','denied','changed'] as const){
  let mutations=0;const bot={health:20,food:20,entities:{},inventory:{items:()=>[]},blockAt:()=>({name:'chest'}),entity:{position:{x:37,y:66,z:4}},dig:async()=>{mutations++;}} as unknown as Bot;
  const options={config:{},rules:RulesSchema.parse({world:'127.0.0.1:25566'}),world:'127.0.0.1:25566',dimension:()=> 'overworld'},executor=new MineflayerExecutor(bot,options as ConstructorParameters<typeof MineflayerExecutor>[1]),services=executor.services(new AbortController().signal);services.near=async()=>{mutations++;};
  const access={edits:[plan.edits[0]!],exit:plan.exit},task:TaskSpec={id:'guarded',goalId:'guarded',source:'user',kind:'build',params:{access},completion:{kind:'blocks',blocks:[]},dependencies:[],reservationKeys:[]};
  await assert.rejects(prepareMaterialAccess(task,services,()=>mode==='protected',()=>mode!=='denied'),ConditionWait);assert.equal(mutations,0);
 }
});
for(const footing of ['oak_planks','dirt','grass_block'] as const)test(`a verified quarry keeps stair supports and ${footing} footholds protected during later collection`,()=>{
 const materialPlan={...plan,edits:plan.edits.map(e=>({...e,after:e.after==='oak_planks'?(footing==='grass_block'?'dirt':footing):e.after}))};
 const sent: any[]=[],world='127.0.0.1:25566',now=100000,core=new FleetController({controllerEpoch:'access',now:()=>now,send:(_id,message)=>sent.push(message),rules:{world,autonomyEnabled:false}});
 core.addAgent({id:'quarry-bot',name:'QuarryBot',allowedActions:['build','collect']});core.startSession('quarry-bot','quarry-session');
 let sequence=0;const receive=(type:string,payload:unknown,assignment?:any)=>core.receive({protocolVersion:1,messageId:`access-${++sequence}`,controllerEpoch:'access',botId:'quarry-bot',sessionId:'quarry-session',sentAt:now,type,payload,...(assignment?{taskId:assignment.taskId,attemptId:assignment.attemptId}:{})});
 receive('bot.ready',{ready:true,world,dimension:'overworld',position:{x:37.5,y:66,z:4.5},health:20,food:20,inventory:[],action:'대기',reason:'ready',mode:'idle',capabilities:['build','collect'],rulesVersion:1});receive('rules.applied',{version:1});
 const goal=core.createGoal({kind:'build',source:'user',params:{mode:'material-access',access:materialPlan}}),assigned=sent.find(m=>m.type==='task.assign');assert.ok(assigned);
 receive('task.result',{outcome:'completed',checkpoint:{materialAccessCompleted:materialPlan.edits.length},evidence:[],observations:[{id:'actual-access',observedAt:now,world,dimension:'overworld',kind:'blocks',data:{blocks:materialPlan.edits.map(e=>({position:e.position,name:footing==='grass_block'&&e.after==='dirt'?'grass_block':e.after}))}}]},assigned);
 assert.equal(core.getSnapshot().goals.find(g=>g.id===goal.id)!.state,'completed');
 if(footing==='grass_block'){const saved=core.checkpoint(),t=saved.tasks.find(t=>t.goalId===goal.id)!;t.state='held';t.checkpoint.resourceRecovery={sand:{destinationsUsed:5}};saved.goals.find(g=>g.id===goal.id)!.state='held';saved.attempts.find(a=>a.id===t.attemptId)!.state='uncertain';const restored=new FleetController({checkpoint:saved,now:()=>now,send(){}}).checkpoint(),q=restored.tasks.find(q=>q.id===t.id)!;assert.equal(q.state,'interrupted');assert.equal(q.checkpoint.quarrySoilReobserveVersion,1);assert.deepEqual(q.checkpoint.resourceRecovery,{sand:{destinationsUsed:5}});assert.notEqual(restored.goals.find(g=>g.id===goal.id)!.state,'completed');q.state='held';restored.goals.find(g=>g.id===goal.id)!.state='held';assert.equal(new FleetController({checkpoint:restored,now:()=>now,send(){}}).checkpoint().tasks.find(q=>q.id===t.id)!.state,'held');}

 receive('bot.status',{ready:true,world,dimension:'overworld',position:{x:37.5,y:66,z:4.5},health:20,food:20,inventory:[],action:'대기',reason:'ready',mode:'idle',capabilities:['build','collect'],rulesVersion:1});
 core.createGoal({kind:'collect',item:'cobblestone',quantity:8});const collect=sent.filter(m=>m.type==='task.assign').at(-1);assert.equal(collect.payload.task.kind,'collect');
 const protectedCells=collect.payload.task.params.protectedPositions;assert.ok(protectedCells.some((p:any)=>p.x===36&&p.y===64&&p.z===4),'the descending stair support must not be quarried');assert.ok(protectedCells.some((p:any)=>p.x===36&&p.y===63&&p.z===5),'placed footing stays intact');assert.equal(protectedCells.some((p:any)=>p.x===36&&p.y===66&&p.z===4),false,'cleared air does not become a permanent protected block');
});
