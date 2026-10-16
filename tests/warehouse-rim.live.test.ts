import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BotInputSchema,RulesSchema,type TaskSpec} from '../packages/contracts/src';
import {blueprint} from '../packages/contracts/src/blueprints';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {executeVillageTask} from '../packages/minecraft/src/village-actions';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('a real resumed warehouse uses its completed foundation around unused rim holes and opens its finished chest',{timeout:600000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const origin={x:9505,y:80,z:9505},blocks=blueprint('warehouse',origin),holes=[{x:9504,y:79,z:9504},{x:9504,y:79,z:9505},{x:9504,y:79,z:9506},{x:9505,y:79,z:9504},{x:9506,y:79,z:9504}];
 rcon('forceload add 9500 9500 9530 9530');rcon('fill 9500 80 9500 9530 87 9530 air');rcon('fill 9500 75 9500 9530 78 9530 dirt');rcon('fill 9500 79 9500 9530 79 9530 grass_block');
 for(const p of holes)rcon(`fill ${p.x} ${p.x===9504&&p.z===9504?76:78} ${p.z} ${p.x} ${p.y} ${p.z} air`);
 const installed=blocks.filter(b=>b.position.y===80||b.name==='oak_planks'&&b.position.y===81&&!(b.position.x===9505&&b.position.z===9508)&&!(b.position.x===9511&&b.position.z===9509));assert.equal(installed.length,52);
 for(const b of installed)rcon(`setblock ${b.position.x} ${b.position.y} ${b.position.z} ${b.name}`);
 rcon('setblock 9503 80 9512 crafting_table');rcon('kill @e[type=!player,x=9500,y=75,z=9500,dx=30,dy=12,dz=30]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaRimBuild',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('tp LayaRimBuild 9506.5 80 9515.5');rcon('clear LayaRimBuild');
  for(const [item,count]of Object.entries({oak_log:31,oak_planks:3,stick:3,torch:4,glass:6,wooden_pickaxe:1,wooden_axe:1}))rcon(`give LayaRimBuild ${item} ${count}`);
  const ready=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(9506.5,80,9515.5))>.1||!bot.inventory.items().some(i=>i.name==='oak_log'&&i.count===31)||!bot.blockAt(new Vec3(9511,80,9509)))&&Date.now()<ready)await sleep(50);
  const movements=new Movements(bot);movements.canDig=false;movements.canOpenDoors=true;movements.allow1by1towers=false;movements.allowParkour=false;movements.maxDropDown=2;movements.infiniteLiquidDropdownDistance=false;movements.scafoldingBlocks=[];bot.pathfinder.setMovements(movements);
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaRimBuild'}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld',villageTask:executeVillageTask});
  const services=executor.services(AbortSignal.timeout(570000),{materialExpedition:true,confirmedRecoveryDeathId:'observed-old-death',resourceTrip:{item:'glass_pane',minimum:3,home:{x:9508,y:80,z:9504},trail:[{x:9508,y:80,z:9504}],phase:'complete',returns:1}});
  const near=services.near;services.near=async(p,radius)=>{console.log('Observed build walk',JSON.stringify({phase:'start',from:bot.entity.position,to:p,radius}));await near(p,radius);console.log('Observed build walk',JSON.stringify({phase:'arrived',actual:bot.entity.position}));};
  const task:TaskSpec={id:'resumed-rim',goalId:'resumed-rim',source:'user',kind:'build',params:{design:'warehouse',origin},completion:{kind:'blocks',blocks},dependencies:[],reservationKeys:[]};
  for(let batch=0;batch<24;batch++){console.log('Actual resumed batch',JSON.stringify({batch,matched:blocks.filter(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name===b.name).length}));const result=await executor.execute(task,services);assert.ok(['partial','completed'].includes(result.outcome),result.reason);if(result.outcome==='completed')break;}
  assert.ok(blocks.every(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name===b.name),'all 136 actual blocks must match');assert.equal(services.checkpoint.safeDetourRequired,true);
  for(const p of holes)assert.equal(bot.blockAt(new Vec3(p.x,p.y,p.z))?.name,'air','unused rim holes remain untouched');
  const container={id:'real-rim-warehouse',world:rules.world,dimension:'overworld',position:blocks.find(b=>b.name==='chest')!.position};
  const registered=await executor.execute({id:'register-rim',goalId:'resumed-rim',source:'user',kind:'build',params:{mode:'register-warehouse'},completion:{kind:'warehouse',container,blocks},dependencies:[],reservationKeys:[]},executor.services(AbortSignal.timeout(30000),{safeDetourRequired:true}));
  assert.equal(registered.outcome,'completed',registered.reason);assert.ok(registered.observations.some(o=>o.kind==='container'&&o.data.container.id===container.id));
  console.log('Actual resumed rim warehouse',JSON.stringify({initialCells:52,finalCells:blocks.length,chestOpened:true,unusedRimHoles:holes.length,rawLogsPlanksGlassTorchesToolsProvided:true,chestsDoorsTableGiven:false,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count}))}));
 }finally{bot.quit('resumed warehouse rim validation finished');await sleep(250);rcon('forceload remove 9500 9500 9530 9530');}
});
