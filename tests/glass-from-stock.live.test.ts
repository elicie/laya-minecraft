import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BotInputSchema,RulesSchema} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('actual glass preparation gathers its sand and stone, crafts a pick and furnace, and smelts six glass from held wood',{timeout:150000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 rcon('forceload add 8900 8900 8940 8912');rcon('fill 8900 76 8900 8940 85 8912 air');rcon('fill 8900 76 8900 8940 78 8912 dirt');rcon('fill 8900 79 8900 8940 79 8912 grass_block');rcon('setblock 8907 80 8907 crafting_table');rcon('fill 8920 80 8905 8922 80 8906 sand');rcon('fill 8930 80 8903 8930 81 8906 stone');rcon('kill @e[type=!player,x=8900,y=76,z=8900,dx=40,dy=10,dz=12]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaGlassStock',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('tp LayaGlassStock 8906.5 80 8906.5');rcon('clear LayaGlassStock');rcon('give LayaGlassStock oak_log 36');rcon('give LayaGlassStock oak_planks 3');rcon('give LayaGlassStock stick 2');rcon('give LayaGlassStock wooden_axe 1');
  const ready=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(8906.5,80,8906.5))>.1||!bot.inventory.items().some(i=>i.name==='oak_log'&&i.count===36)||!bot.blockAt(new Vec3(8930,80,8903)))&&Date.now()<ready)await sleep(50);
  const movement=new Movements(bot);movement.canDig=false;movement.allow1by1towers=false;movement.allowParkour=false;movement.maxDropDown=2;movement.infiniteLiquidDropdownDistance=false;movement.scafoldingBlocks=[];bot.pathfinder.setMovements(movement);
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaGlassStock'}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld'});
  assert.equal(executor.count('sand'),0);assert.equal(executor.count('cobblestone'),0);assert.equal(executor.count('wooden_pickaxe'),0);assert.equal(executor.count('furnace'),0);assert.equal(executor.count('glass'),0);
  const services=executor.services(AbortSignal.timeout(140000));await executor.execute({id:'actual-glass',goalId:'glass-stock-check',kind:'smelt',params:{item:'glass',quantity:6},completion:{kind:'inventory',item:'glass',minimum:6},dependencies:[],reservationKeys:[]},services);
  assert.equal(executor.count('glass'),6);assert.equal(executor.count('sand'),0);assert.equal(executor.count('wooden_pickaxe'),1);assert.equal(executor.count('furnace'),0);assert.ok(executor.count('oak_log')<36);assert.ok(bot.findBlock({matching:b=>b.name==='furnace',maxDistance:16}));
  for(let x=8920;x<=8922;x++)for(let z=8905;z<=8906;z++)assert.equal(bot.blockAt(new Vec3(x,80,z))?.name,'air');
  for(let y=80;y<=81;y++)for(let z=8903;z<=8906;z++)assert.equal(bot.blockAt(new Vec3(8930,y,z))?.name,'air');
  assert.equal(bot.blockAt(new Vec3(8906,79,8906))?.name,'grass_block');
  console.log('Actual full glass preparation',JSON.stringify({inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),rawWoodAndAxeProvided:true,sandStoneGlassPickFurnaceItemsGiven:false,worktableAndNaturalSourcesPrepared:true}));
 }finally{bot.quit('glass preparation validation finished');await sleep(200);rcon('forceload remove 8900 8900 8940 8912');}
});
