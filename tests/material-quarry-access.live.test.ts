import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import {RulesSchema,BotInputSchema,type TaskSpec} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable25566 only');
const rcon=(s:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',s],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
test('observed quarry creates six stable collection cells and reobserves naturally grassed dirt without repeating excavation',{timeout:180000,skip:!process.env.MC_QUARRY_SNAPSHOT},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const scene=JSON.parse(readFileSync(process.env.MC_QUARRY_SNAPSHOT!,'utf8'));assert.equal(scene.unmoved,true);assert.equal(scene.world,'infra:25565');const offset=24000,shift=(p:{x:number;y:number;z:number})=>({...p,x:p.x+offset,z:p.z+offset}),data=minecraftData('1.21.1');
 const commands=['forceload add 24049 24052 24063 24065','fill 24049 58 24052 24063 59 24065 stone','fill 24049 60 24052 24063 74 24065 air'];
 for(const row of scene.blocks){if(!data.blocksByName[row.name]){assert.equal(row.boundingBox,'empty');continue;}const p=shift(row.position);commands.push(`setblock ${p.x} ${p.y} ${p.z} ${row.name}`);}
 let bot:Awaited<ReturnType<typeof createCompatibleBot>>|undefined;
 try{
  const response=execFileSync('docker',['exec','-i','minecraft-laya-validation','rcon-cli'],{input:commands.join('\n')+'\nexit\n',encoding:'utf8',maxBuffer:3e6});assert.doesNotMatch(response,/Unknown or incomplete command|Incorrect argument|not loaded/i);
  bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaQuarryTest',auth:'offline'});bot.loadPlugin(pathfinder);await once(bot,'spawn');rcon('tp LayaQuarryTest 24057.5 68 24057.5');rcon('clear LayaQuarryTest');await sleep(1700);
  const movements=new Movements(bot);movements.canDig=false;movements.allow1by1towers=false;movements.allowParkour=false;movements.maxDropDown=2;bot.pathfinder.setMovements(movements);
  const {id:_id,...config}=BotInputSchema.parse({name:'LayaQuarryTest'}),rules=RulesSchema.parse({world:'127.0.0.1:25566'}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld',onProgress:(action,reason)=>console.log('Quarry progress',JSON.stringify({action,reason,position:bot!.entity.position}))});
  const cuts=[
   {stand:{x:57,y:68,z:57},position:{x:56,y:67,z:57},before:'grass_block',after:'air'},
   {stand:{x:56,y:67,z:57},position:{x:56,y:67,z:58},before:'grass_block',after:'air'},
   {stand:{x:56,y:67,z:58},position:{x:57,y:67,z:58},before:'grass_block',after:'air'},
   {stand:{x:56,y:67,z:58},position:{x:56,y:66,z:57},before:'dirt',after:'air'},
   {stand:{x:56,y:66,z:57},position:{x:56,y:66,z:58},before:'dirt',after:'air'},
   {stand:{x:56,y:66,z:58},position:{x:56,y:65,z:57},before:'dirt',after:'air'},
   {stand:{x:56,y:65,z:57},position:{x:55,y:65,z:57},before:'grass_block',after:'air'},
   {stand:{x:56,y:65,z:57},position:{x:55,y:64,z:57},before:'sand',after:'dirt'},
   {stand:{x:55,y:65,z:57},position:{x:55,y:66,z:56},before:'grass_block',after:'air'},
   {stand:{x:55,y:65,z:57},position:{x:55,y:65,z:56},before:'dirt',after:'air'},
   {stand:{x:55,y:65,z:57},position:{x:55,y:64,z:56},before:'sand',after:'dirt'},
   {stand:{x:55,y:65,z:57},position:{x:55,y:65,z:58},before:'grass_block',after:'air'},
   {stand:{x:55,y:65,z:57},position:{x:55,y:64,z:58},before:'sand',after:'dirt'},
   {stand:{x:55,y:65,z:58},position:{x:55,y:64,z:59},before:'sand',after:'dirt'},
   {stand:{x:55,y:65,z:59},position:{x:55,y:64,z:60},before:'sand',after:'dirt'},
   {stand:{x:55,y:65,z:60},position:{x:55,y:64,z:61},before:'sand',after:'dirt'},
  ];
  const access={edits:cuts.map(e=>({...e,stand:shift(e.stand),position:shift(e.position)})),exit:shift({x:57,y:68,z:57})},task:TaskSpec={id:'quarry',goalId:'fixture',kind:'build',source:'user',params:{mode:'material-access',access},completion:{kind:'blocks',blocks:access.edits.map(e=>({position:e.position,name:e.after}))},dependencies:[],reservationKeys:[]};
  const services=executor.services(AbortSignal.timeout(120000));let result;try{result=await executor.execute(task,services);}catch(e){console.log('Quarry failure',JSON.stringify({checkpoint:services.checkpoint,position:bot.entity.position,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),actual:access.edits.map(q=>({...q,actual:bot!.blockAt(new Vec3(q.position.x,q.position.y,q.position.z))?.name}))}));throw e;}console.log('Quarry result',JSON.stringify({outcome:result.outcome,reason:result.reason,checkpoint:result.checkpoint,position:bot.entity.position,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count}))}));assert.equal(result.outcome,'completed',result.reason);assert.ok(executor.count('sand')>=4&&executor.count('sand')<=6,'count only actually picked up sand; edge drops may be lost');assert.equal(executor.count('oak_log'),0);assert.equal(executor.count('oak_planks'),0);assert.equal(bot.health,20);
  const sandBeforeReobserve=executor.count('sand');const grass=access.edits.filter(e=>e.after==='dirt').at(-1)!.position;rcon(`setblock ${grass.x} ${grass.y} ${grass.z} grass_block`);await sleep(150);
  const fresh=executor.services(AbortSignal.timeout(30000),{resourceRecovery:{sand:{destinationsUsed:5}}});const reobserved=await executor.execute(task,fresh);assert.deepEqual(fresh.checkpoint.resourceRecovery,{sand:{destinationsUsed:5}});assert.equal(reobserved.outcome,'completed');assert.equal(bot.blockAt(new Vec3(grass.x,grass.y,grass.z))?.name,'grass_block');assert.equal(executor.count('sand'),sandBeforeReobserve);
  console.log('Quarry actual access',JSON.stringify({sand:executor.count('sand'),position:bot.entity.position,health:bot.health,fixtureMaterialsGiven:false,naturalGrassReobserved:true,grassChangePreparedInFixture:true,productionWorld:false}));
 }finally{bot?.quit('quarry validation complete');await sleep(200);rcon('forceload remove 24049 24052 24063 24065');}
});
