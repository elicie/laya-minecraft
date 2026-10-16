import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BotInputSchema,RulesSchema,MaterialAccessPlanSchema,type TaskSpec} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {observedGroundRoute} from '../packages/minecraft/src/observed-ground-walk';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('a real dry quarry access resumes after an actual sand cut and recovers six sand while preserving water and supporting terrain',{timeout:120000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const source=MaterialAccessPlanSchema.parse(JSON.parse(readFileSync('tests/fixtures/material-quarry-plan.json','utf8'))),shift=(p:{x:number;y:number;z:number})=>({x:p.x+9000,y:p.y+20,z:p.z+9000});
 const plan={edits:source.edits.map(e=>({...e,stand:shift(e.stand),position:shift(e.position)})),exit:shift(source.exit)};
 rcon('forceload add 9032 9000 9042 9012');rcon('fill 9032 80 9000 9042 89 9012 air');rcon('fill 9034 80 9002 9040 83 9010 stone');rcon('fill 9036 84 9002 9040 84 9004 stone');rcon('fill 9036 85 9002 9040 85 9004 grass_block');rcon('setblock 9036 85 9004 dirt');rcon('setblock 9036 86 9004 grass_block');rcon('setblock 9037 85 9005 grass_block');rcon('fill 9038 84 9005 9038 84 9006 sand');rcon('fill 9038 85 9005 9038 85 9006 grass_block');
 for(const e of plan.edits)rcon(`setblock ${e.position.x} ${e.position.y} ${e.position.z} ${e.before}`);
 rcon('setblock 9035 82 9005 water');rcon('kill @e[type=!player,x=9032,y=80,z=9000,dx=10,dy=10,dz=12]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaQuarryAccess',auth:'offline'});bot.loadPlugin(pathfinder);const controller=new AbortController();let interrupted=false;
 try{
  await once(bot,'spawn');rcon('tp LayaQuarryAccess 9037.5 86 9004.5');rcon('clear LayaQuarryAccess');rcon('give LayaQuarryAccess oak_planks 4');const until=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(9037.5,86,9004.5))>.1||!bot.inventory.items().some(i=>i.name==='oak_planks'&&i.count===4))&&Date.now()<until)await sleep(50);
  const movement=new Movements(bot);movement.canDig=false;movement.allow1by1towers=false;movement.allowParkour=false;movement.maxDropDown=2;movement.infiniteLiquidDropdownDistance=false;movement.scafoldingBlocks=[];bot.pathfinder.setMovements(movement);
  assert.equal(observedGroundRoute(bot,shift({x:36,y:64,z:5})),undefined,'the real two-block bank needs access preparation');
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaQuarryAccess'}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld',onProgress(action,reason){console.log(action,reason);if(!interrupted&&reason.includes('(3/11)')){interrupted=true;setTimeout(()=>controller.abort(),50);}}});
  const task:TaskSpec={id:'quarry-access',goalId:'quarry-plan',source:'user',kind:'build',params:{mode:'material-access',access:plan},completion:{kind:'blocks',blocks:plan.edits.map(e=>({position:e.position,name:e.after}))},dependencies:[],reservationKeys:[]},first=executor.services(controller.signal);
  await assert.rejects(executor.execute(task,first),error=>{console.log('Actual partial access stop',error instanceof Error?error.message:String(error),JSON.stringify({position:bot.entity.position,pending:first.checkpoint.materialAccessPending}));return true;});assert.equal(interrupted,true);assert.equal((first.checkpoint.materialAccessPending as {cleared:boolean}).cleared,true);assert.equal(bot.blockAt(new Vec3(9036,83,9005))?.name,'air');executor.stopControls();
  const resumed=executor.services(AbortSignal.timeout(90000),first.checkpoint),result=await executor.execute(task,resumed);assert.equal(result.outcome,'completed');assert.equal(executor.count('sand'),6);assert.equal(executor.count('oak_planks'),0);assert.ok(bot.entity.position.distanceTo(new Vec3(9037.5,86,9004.5))<1);assert.equal(bot.blockAt(new Vec3(9035,82,9005))?.name,'water');assert.equal(bot.blockAt(new Vec3(9036,84,9004))?.name,'stone');
  rcon('give LayaQuarryAccess wooden_pickaxe 1');rcon('setblock 9038 86 9004 stone');rcon('setblock 9039 84 9006 stone');await sleep(200);
  const material=executor.services(AbortSignal.timeout(30000));await executor.execute({id:'explicit-quarry',goalId:'explicit-quarry',source:'user',kind:'collect',params:{item:'cobblestone',quantity:1,returnTo:plan.exit,searchFrom:shift({x:37,y:64,z:6})},completion:{kind:'inventory',item:'cobblestone',minimum:1},dependencies:[],reservationKeys:[]},material);
  assert.equal(executor.count('cobblestone'),1);assert.equal(bot.blockAt(new Vec3(9038,86,9004))?.name,'stone','the closer source at the departure must be left for the explicitly selected quarry');assert.ok(bot.entity.position.distanceTo(new Vec3(9037.5,86,9004.5))<1);
  console.log('Actual quarry access and restart verified',JSON.stringify({position:bot.entity.position,sand:executor.count('sand'),planksProvided:4,sandItemsGiven:false,waterUnchanged:true,worldCutResumed:true}));
 }finally{bot.quit('material access validation finished');await sleep(200);rcon('forceload remove 9032 9000 9042 9012');}
});
