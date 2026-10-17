import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {Vec3} from 'vec3';
import {BotInputSchema,RulesSchema} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test('an actual sand trip approaches a solid furnace landmark without mining it and returns with real sand',{timeout:60000},async()=>{
 assert.equal(process.env.MC_HOST,'127.0.0.1');assert.equal(process.env.MC_PORT,'25566');
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
 rcon('forceload add 8400 8400 8416 8412');rcon('fill 8400 79 8400 8416 79 8412 grass_block');rcon('fill 8400 80 8400 8416 86 8412 air');rcon('time set day');
 rcon('setblock 8407 80 8406 furnace');rcon('setblock 8410 80 8406 sand');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaLandmarkLab',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('clear LayaLandmarkLab');rcon('tp LayaLandmarkLab 8402.5 80 8406.5');
  const until=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(8402.5,80,8406.5))>1||!bot.blockAt(new Vec3(8410,80,8406)))&&Date.now()<until)await sleep(50);
  assert.equal(bot.inventory.items().length,0);
  const movement=new Movements(bot);movement.canDig=false;movement.allow1by1towers=false;movement.allowParkour=false;movement.maxDropDown=2;movement.infiniteLiquidDropdownDistance=false;movement.scafoldingBlocks=[];bot.pathfinder.setMovements(movement);
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaLandmarkLab',allowedActions:['collect','explore','home']});
  const executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>String(bot.game.dimension)}),services=executor.services(AbortSignal.timeout(40000));
  const result=await executor.execute({id:'landmark-sand',goalId:'landmark-goal',kind:'collect',params:{item:'sand',quantity:1,returnTo:{x:8402,y:80,z:8406},searchFrom:{x:8407,y:80,z:8406}},dependencies:[],reservationKeys:[],completion:{kind:'inventory',item:'sand',minimum:1}},services);
  assert.equal(result.outcome,'completed');assert.equal(executor.count('sand'),1);assert.equal(bot.blockAt(new Vec3(8407,80,8406))?.name,'furnace');assert.equal(bot.blockAt(new Vec3(8410,80,8406))?.name,'air');assert.ok(bot.entity.position.distanceTo(new Vec3(8402.5,80,8406.5))<1);
  console.log('Actual solid landmark sand trip verified',JSON.stringify({inventory:bot.inventory.items().map(item=>({name:item.name,count:item.count})),returned:bot.entity.position,landmarkIntact:true,inventoryItemsGiven:false,toolsGiven:false}));
 }finally{bot.quit('solid landmark lab validation complete');await sleep(250);rcon('forceload remove 8400 8400 8416 8412');}
});
