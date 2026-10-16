import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { FleetController } from '../packages/core/src';
import { BotInputSchema, type BuildAccessPreparation, type CentralMessage, type ResultPayload } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { observeAccessPreparation, prepareBuildAccess } from '../packages/minecraft/src/build-access-recovery';
import { ConditionWait } from '../packages/minecraft/src/services';

if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});

test('a real completed approach with a delayed report renews actual proof at the door and resumes the preserved building', {timeout:95000},async()=>{
  assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
  rcon('forceload add 5796 5796 5812 5812'); rcon('fill 5796 80 5796 5812 86 5812 air');
  rcon('fill 5796 76 5796 5812 78 5812 dirt');rcon('fill 5796 79 5796 5812 79 5812 grass_block');rcon('setblock 5801 80 5800 dirt');
  const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaProofRenew',auth:'offline'});bot.loadPlugin(pathfinder);
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  try {
    await once(bot,'spawn');rcon('tp LayaProofRenew 5800.5 80 5800.5');rcon('clear LayaProofRenew');
    const end=Date.now()+10000;
    while((bot.entity.position.distanceTo(new Vec3(5800.5,80,5800.5))>1||!bot.blockAt(new Vec3(5801,80,5800)))&&Date.now()<end)await sleep(100);
    assert.equal(bot.blockAt(new Vec3(5801,80,5800))?.name,'dirt');
    const movements=new Movements(bot);movements.canDig=false;movements.allow1by1towers=false;movements.allowParkour=false;movements.maxDropDown=2;movements.infiniteLiquidDropdownDistance=false;movements.scafoldingBlocks=[];bot.pathfinder.setMovements(movements);
    const sent:CentralMessage[]=[],world='127.0.0.1:25566';
    const core=new FleetController({send:(_id,m)=>sent.push(m),rules:{world,autonomyEnabled:false}});
    const {id:_id,...config}=BotInputSchema.parse({name:'LayaProofRenew',allowedActions:['build','collect']});
    const executor=new MineflayerExecutor(bot,{config,rules:core.getRules(),world,dimension:()=> 'overworld'});
    const receive=(type:string,payload:unknown,assignment?:Extract<CentralMessage,{type:'task.assign'}>)=>core.receive({protocolVersion:1,messageId:randomUUID(),controllerEpoch:core.controllerEpoch,botId:'builder',sessionId:'live-proof',sentAt:Date.now(),type,payload,...(assignment?{taskId:assignment.taskId,attemptId:assignment.attemptId}:{})});
    const report=(currentAttemptId?:string)=>({ready:true,world,dimension:'overworld',position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},health:bot.health,food:bot.food,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),action:'build',reason:'actual live body',mode:'idle',capabilities:['build','collect'],rulesVersion:core.getRules().version,...(currentAttemptId?{currentAttemptId}:{})});
    const assignments=()=>sent.filter((m):m is Extract<CentralMessage,{type:'task.assign'}>=>m.type==='task.assign');
    core.addAgent({id:'builder',...config});core.startSession('builder','live-proof');receive('bot.ready',report());receive('rules.applied',{version:core.getRules().version});
    core.createGoal({kind:'build',params:{design:'warehouse',origin:{x:5803,y:80,z:5802}}});const parent=assignments()[0]!;assert.ok(parent);
    const target={x:5806,y:80,z:5801},plan:BuildAccessPreparation={start:{x:5800,y:80,z:5800},target,observedAt:Date.now(),path:[...[0,1,2,3,4,5,6].map(x=>({x:5800+x,y:80,z:5800})),target],edits:[{position:{x:5801,y:80,z:5800},before:'dirt',after:'air'}]};
    const proofServices=executor.services(AbortSignal.timeout(85000));
    assert.equal(receive('task.result',{outcome:'condition-wait',reason:'approved natural approach required',checkpoint:{placed:17,buildAccessPreparation:plan,waitingFor:{kind:'blocks',causeCode:'BUILD_ACCESS',positions:[target],watchPosition:true}},observations:[{id:randomUUID(),kind:'blocks',world,dimension:'overworld',observedAt:Date.now(),data:{blocks:observeAccessPreparation(proofServices,plan)}}],evidence:[]},parent),true);
    const execute=async(assignment:Extract<CentralMessage,{type:'task.assign'}>):Promise<ResultPayload>=>{
      const services=executor.services(AbortSignal.timeout(20000),assignment.payload.checkpoint);
      services.checkpoint.protectedPositions=Array.isArray(assignment.payload.task.params.protectedPositions)?assignment.payload.task.params.protectedPositions:[];
      try{return await prepareBuildAccess(assignment.payload.task,services);}
      catch(error){if(error instanceof ConditionWait)return{outcome:'condition-wait',reason:error.message,checkpoint:error.checkpoint,observations:services.observations,evidence:services.evidence};throw error;}
    };
    const child=assignments()[1]!;assert.ok(child);const first=structuredClone(await execute(child));
    assert.equal(first.outcome,'completed');assert.equal(bot.blockAt(new Vec3(5801,80,5800))?.name,'air');
    const before=bot.entity.position.clone();assert.ok(before.distanceTo(new Vec3(5806.5,80,5801.5))<1);
    const atDoorMoves:(typeof before)[]=[],recordDoor=()=>{atDoorMoves.push(bot.entity.position.clone());};bot.on('move',recordDoor);
    try{await execute({...child,payload:{...child.payload,checkpoint:structuredClone(first.checkpoint)}});}finally{bot.off('move',recordDoor);}
    assert.ok(atDoorMoves.every(p=>p.distanceTo(before)<.25),'at-door proof does not revisit the departure');
    rcon('tp LayaProofRenew 5806.5 80 5804.5');
    const moved=Date.now()+5000;while(bot.entity.position.distanceTo(new Vec3(5806.5,80,5804.5))>1&&Date.now()<moved)await sleep(50);
    assert.ok(bot.entity.position.distanceTo(new Vec3(5806.5,80,5804.5))<1,'actual displaced body');
    const readOnlyReturn=await execute({...child,payload:{...child.payload,checkpoint:structuredClone(first.checkpoint)}});
    assert.equal(readOnlyReturn.outcome,'completed');assert.ok(Number((readOnlyReturn.checkpoint.accessReturnRoute as {steps:number}).steps)>0);
    rcon('fill 5801 80 5802 5809 82 5802 dirt');rcon('fill 5801 80 5808 5809 82 5808 dirt');
    rcon('fill 5801 80 5802 5801 82 5808 dirt');rcon('fill 5809 80 5802 5809 82 5808 dirt');rcon('tp LayaProofRenew 5806.5 80 5804.5');
    const displacedAgain=Date.now()+5000;while(bot.entity.position.distanceTo(new Vec3(5806.5,80,5804.5))>1&&Date.now()<displacedAgain)await sleep(50);
    assert.ok(bot.entity.position.distanceTo(new Vec3(5806.5,80,5804.5))<1);
    heartbeat=setInterval(()=>receive('bot.status',report(child.attemptId)),1000);
    await sleep(34000);clearInterval(heartbeat);heartbeat=undefined;
    assert.equal(receive('task.result',first,child),true);
    const waiting=core.checkpoint().tasks.find(t=>t.id===child.taskId)!;
    assert.equal(waiting.state,'interrupted');assert.equal(waiting.accessProofRechecks,1);assert.equal(waiting.retryCount,0);
    assert.equal(assignments().length,2,'expired completion cannot resume the parent');
    receive('bot.status',report());const recheck=assignments()[2]!;assert.equal(recheck.taskId,child.taskId);
    const visited:(typeof before)[]=[];const record=()=>{visited.push(bot.entity.position.clone());};bot.on('move',record);
    let fresh:ResultPayload;
    try{fresh=await execute(recheck);}finally{bot.off('move',record);}
    assert.equal(fresh.outcome,'condition-wait','the wall requires a new centrally reserved plan');assert.equal(visited.length,0,'a proposal has no movement effects');
    assert.equal(bot.blockAt(new Vec3(5805,80,5802))?.name,'dirt','new terrain is unchanged before central approval');
    assert.equal(receive('task.result',fresh,recheck),true);
    const returnTask=assignments().at(-1)!;assert.notEqual(returnTask.taskId,child.taskId);assert.equal(returnTask.payload.task.params.parentTaskId,child.taskId);assert.equal(returnTask.payload.task.params.accessReturnDepth,1);
    const returned=await execute(returnTask);assert.equal(returned.outcome,'completed',returned.reason);assert.equal(receive('task.result',returned,returnTask),true);
    const originalAgain=assignments().at(-1)!;assert.equal(originalAgain.taskId,child.taskId);
    const verified=await execute(originalAgain);assert.equal(verified.outcome,'completed');assert.equal(receive('task.result',verified,originalAgain),true);
    assert.equal(bot.blockAt(new Vec3(5801,80,5800))?.name,'air');
    assert.equal(bot.blockAt(new Vec3(5805,80,5802))?.name,'dirt','reserved building cells cannot be excavated by a return subtask');
    assert.equal(core.checkpoint().tasks.find(t=>t.id===child.taskId)!.state,'completed');
    assert.equal(assignments().at(-1)!.taskId,parent.taskId);assert.equal(assignments().at(-1)!.payload.checkpoint.placed,17);
    console.log('Verified actual delayed proof recovery',JSON.stringify({delayMs:Date.now()-Number((first.checkpoint.accessPreparationComplete as {observedAt:number}).observedAt),rechecks:waiting.accessProofRechecks,retries:waiting.retryCount,originalEdit:'air',actualPosition:bot.entity.position,preservedPlaced:17,approvedReturnEdits:(returnTask.payload.task.params.preparation as unknown as BuildAccessPreparation).edits.length}));
  }finally{if(heartbeat)clearInterval(heartbeat);bot.quit('proof renewal validation finished');await sleep(250);rcon('forceload remove 5796 5796 5812 5812');}
});
