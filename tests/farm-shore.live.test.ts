import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BotInputSchema,RulesSchema,type TaskSpec} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {executeVillageTask} from '../packages/minecraft/src/village-actions';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable minecraft-laya-validation:25566 only');
const rcon=(cmd:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',cmd],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
test('a real shoreline farm recovers drops, repairs soil and replants from an observed bank',{timeout:80000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const raised=process.env.MC_FARM_RAISED_BANK==='1';
 const origin={x:10010,y:79,z:10011},plots=[{x:10011,y:79,z:10010},{x:10011,y:79,z:10012}];
 rcon('forceload add 10000 10000 10025 10025');rcon('fill 10000 79 10000 10025 86 10025 air');rcon('fill 10000 77 10000 10025 78 10025 dirt');rcon('fill 10000 79 10000 10025 79 10025 grass_block');rcon('fill 10008 79 10008 10010 79 10014 water');rcon('kill @e[type=!player,x=10000,y=77,z=10000,dx=25,dy=12,dz=25]');
 if(raised){rcon('fill 10011 80 10007 10020 80 10015 grass_block');for(const p of plots)rcon(`setblock ${p.x} ${p.y+1} ${p.z} air`);}
 const isolated=process.env.MC_FARM_ISOLATED_BANK==='1';
 if(isolated){assert.equal(raised,true);rcon('fill 10011 81 10008 10011 82 10008 stone');rcon('fill 10012 81 10009 10012 82 10009 stone');}
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaShoreFarm',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon(`tp LayaShoreFarm 10014.5 ${raised?81:80} 10011.5`);rcon('clear LayaShoreFarm');rcon('give LayaShoreFarm wooden_hoe 1');rcon('give LayaShoreFarm wheat_seeds 2');
  const ready=Date.now()+8000;while((bot.entity.position.distanceTo(new Vec3(10014.5,raised?81:80,10011.5))>.2||!bot.inventory.items().some(i=>i.name==='wheat_seeds'))&&Date.now()<ready)await sleep(50);
  const movement=new Movements(bot);movement.canDig=false;movement.allow1by1towers=false;movement.allowParkour=false;movement.maxDropDown=2;movement.infiniteLiquidDropdownDistance=false;movement.scafoldingBlocks=[];movement.blocksToAvoid.add(bot.registry.blocksByName.farmland!.id);bot.pathfinder.setMovements(movement);
  const {id:_id,...config}=BotInputSchema.parse({name:'LayaShoreFarm'}),rules=RulesSchema.parse({autonomyEnabled:false}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld',villageTask:executeVillageTask});
  const task:TaskSpec={id:'shore',goalId:'shore',source:'user',kind:'farm',params:{id:'shore',origin,positions:plots,plots:2,crop:'wheat',mode:'setup'},completion:{kind:'farm',crop:'wheat',plots:2,mode:'setup'},dependencies:[],reservationKeys:[]};
  const first=await executor.execute(task,executor.services(AbortSignal.timeout(25000)));assert.equal(first.outcome,'completed');
  assert.equal(bot.inventory.items().filter(i=>i.name==='wheat_seeds').reduce((n,i)=>n+i.count,0),0);assert.equal(bot.blockAt(new Vec3(origin.x,origin.y,origin.z))?.name,'water');
  for(const p of plots){assert.equal(bot.blockAt(new Vec3(p.x,p.y,p.z))?.name,'farmland');rcon(`setblock ${p.x} ${p.y+1} ${p.z} wheat[age=7]`);}
  rcon('give LayaShoreFarm wheat_seeds 2');await sleep(250);const harvest:TaskSpec={...task,params:{...task.params,mode:'harvest',quantity:2},completion:{kind:'farm',crop:'wheat',plots:2,mode:'harvest',quantity:2,baseline:0}};
  if(isolated){rcon(`setblock ${plots[1]!.x} ${plots[1]!.y+1} ${plots[1]!.z} wheat[age=0]`);harvest.params.quantity=1;harvest.completion={kind:'farm',crop:'wheat',plots:2,mode:'harvest',quantity:1,baseline:0};await sleep(200);}
  const deadline=AbortSignal.timeout(45000);let checkpoint:any={};const pendingResume=process.env.MC_FARM_PENDING_RESUME==='1';
  if(pendingResume){const held=executor.services(deadline);held.recoverDrops=async()=>{};const paused=await executor.execute(harvest,held);assert.equal(paused.outcome,'condition-wait');assert.ok(paused.checkpoint.farmPendingHarvest);assert.equal(bot.pathfinder.movements.blocksToAvoid.has(bot.registry.blocksByName.farmland!.id),true);assert.equal((paused.checkpoint.farm as any)?.harvested??0,0);assert.equal(bot.blockAt(new Vec3(plots[0]!.x,plots[0]!.y+1,plots[0]!.z))?.name,'air');checkpoint=paused.checkpoint;}
  if(isolated){assert.equal(pendingResume,true);assert.ok(checkpoint.farmAccessOrigin);rcon('tp LayaShoreFarm 10011.5 79.9375 10010.15');await sleep(300);}
  let result=await executor.execute(harvest,executor.services(deadline,checkpoint));
  for(let retry=0;result.outcome==='condition-wait'&&result.checkpoint.farmPendingHarvest&&retry<3;retry++){await sleep(500);result=await executor.execute(harvest,executor.services(deadline,result.checkpoint));}
console.log('harvest evidence',JSON.stringify({result,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),position:bot.entity.position,drops:Object.values(bot.entities).filter(e=>e.name==='item').map(e=>({position:e.position,item:e.getDroppedItem?.()?.name,count:e.getDroppedItem?.()?.count,below:bot.blockAt(e.position.offset(0,-1,0))?.name}))}));assert.equal(result.outcome,'completed');assert.ok(executor.count('wheat')>=(isolated?1:2));
  for(const p of plots){assert.equal(bot.blockAt(new Vec3(p.x,p.y,p.z))?.name,'farmland');assert.equal(bot.blockAt(new Vec3(p.x,p.y+1,p.z))?.name,'wheat');}
  const returnTo=executor.services(deadline,{dryGroundApproach:true,farmPlotPositions:plots});await returnTo.near(new Vec3(10014.5,raised?81:80,10011.5),0);assert.ok(bot.entity.position.distanceTo(new Vec3(10014.5,raised?81:80,10011.5))<.5,'replanting must leave an actual land route back');
  assert.equal(bot.health,20);assert.equal(result.checkpoint.farmDryGround,undefined);assert.equal(bot.pathfinder.movements.blocksToAvoid.has(bot.registry.blocksByName.farmland!.id),true);console.log('Actual shoreline farming',JSON.stringify({plots:plots.length,raisedBank:raised,pendingDropResume:pendingResume,existingWater:true,harvested:executor.count('wheat'),replanted:true,health:bot.health,fixtureItemsGiven:true,maturityPrepared:true,productionWorld:false}));
 }finally{bot.quit('shore farm validation finished');await sleep(200);rcon('forceload remove 10000 10000 10025 10025');}
});
