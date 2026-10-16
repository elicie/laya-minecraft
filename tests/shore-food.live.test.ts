import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { BotInputSchema, RulesSchema } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ConditionWait } from '../packages/minecraft/src/services';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('a critical unarmed player eats a reachable shore fish while refusing an offshore target and never entering water',{timeout:65000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 rcon('forceload add 8800 8800 8830 8820');rcon('fill 8800 77 8800 8830 85 8820 air');rcon('fill 8800 77 8800 8830 78 8820 dirt');rcon('fill 8800 79 8800 8830 79 8820 grass_block');rcon('fill 8811 79 8805 8814 79 8807 water');rcon('execute positioned 8810 80 8806 run kill @e[type=!player,distance=..40]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaShoreFood',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('tp LayaShoreFood 8810.5 80 8806.5');rcon('clear LayaShoreFood');rcon('effect give LayaShoreFood hunger 10 255 true');const hungryUntil=Date.now()+6000;while(bot.food>17&&Date.now()<hungryUntil)await sleep(20);rcon('effect clear LayaShoreFood hunger');rcon('damage LayaShoreFood 16 minecraft:generic');
  const ready=Date.now()+5000;while((bot.health>6||bot.entity.position.distanceTo(new Vec3(8810.5,80,8806.5))>1)&&Date.now()<ready)await sleep(50);assert.ok(bot.health>0&&bot.health<=6);assert.ok(bot.food<=17);assert.equal(bot.inventory.items().length,0);
  const m=new Movements(bot);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.scafoldingBlocks=[];m.infiniteLiquidDropdownDistance=false;bot.pathfinder.setMovements(m);
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaShoreFood'}),e=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld'}),s=e.services(AbortSignal.timeout(45000));
  let wet=false;const watch=()=>{const p=bot.entity.position.floored();if(bot.blockAt(p)?.name==='water'||bot.blockAt(p.offset(0,-1,0))?.name==='water')wet=true;};bot.on('physicsTick',watch);
  rcon('summon cod 8813.5 79.4 8806.5 {NoAI:1b,Health:3.0f}');const fishUntil=Date.now()+5000;while(!Object.values(bot.entities).some(x=>x.name==='cod')&&Date.now()<fishUntil)await sleep(50);const offshore=Object.values(bot.entities).find(x=>x.name==='cod')!;assert.ok(offshore);await assert.rejects(e.fightEntity(offshore,s,true),ConditionWait);
  rcon('summon cod 8811.25 79.4 8806.5 {NoAI:1b,Health:3.0f}');await sleep(200);const healthBefore=bot.health,foodBefore=bot.food;await e.ensureFood(s);assert.ok(e.count('cod')>=1);assert.ok(await e.eat(s));assert.ok(bot.food>foodBefore);assert.ok(bot.health>=healthBefore);assert.equal(wet,false);assert.equal(bot.blockAt(bot.entity.position.floored().offset(0,-1,0))?.name,'grass_block');bot.removeListener('physicsTick',watch);
  console.log('Actual unarmed shore food verified',JSON.stringify({healthBefore,foodBefore,health:bot.health,food:bot.food,actual:bot.entity.position,wet,foodGiven:false,weaponGiven:false,sourceAnimalProvided:true}));
 }finally{bot.quit('shore food validation finished');await sleep(250);rcon('forceload remove 8800 8800 8830 8820');}
});

test('a critical unarmed player follows a live chicken over dry ground and eats the actual recovered food',{timeout:65000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 rcon('forceload add 8900 8900 8930 8920');rcon('fill 8900 77 8900 8930 85 8920 air');rcon('fill 8900 77 8900 8930 78 8920 dirt');rcon('fill 8900 79 8900 8930 79 8920 grass_block');rcon('fill 8910 80 8904 8922 80 8910 orange_tulip');rcon('execute positioned 8910 80 8906 run kill @e[type=!player,distance=..40]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaChickenFood',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('tp LayaChickenFood 8910.5 80 8906.5');rcon('clear LayaChickenFood');await sleep(3500);rcon('effect give LayaChickenFood hunger 10 255 true');const hungryUntil=Date.now()+6000;while(bot.food>17&&Date.now()<hungryUntil)await sleep(20);rcon('effect clear LayaChickenFood hunger');console.log('Chicken injury command',rcon('damage LayaChickenFood 16 minecraft:generic'));
  const ready=Date.now()+5000;while((bot.health>6||bot.entity.position.distanceTo(new Vec3(8910.5,80,8906.5))>1)&&Date.now()<ready)await sleep(50);console.log('Chicken initial survival state',JSON.stringify({position:bot.entity.position,health:bot.health,food:bot.food}));assert.ok(bot.health>0&&bot.health<=6);assert.ok(bot.food<=17);assert.equal(bot.inventory.items().length,0);
  const m=new Movements(bot);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.scafoldingBlocks=[];m.infiniteLiquidDropdownDistance=false;bot.pathfinder.setMovements(m);
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaChickenFood'}),e=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld'}),s=e.services(AbortSignal.timeout(45000));
  let wet=false;const watch=()=>{const p=bot.entity.position.floored();if(bot.blockAt(p)?.name==='water'||bot.blockAt(p.offset(0,-1,0))?.name==='water')wet=true;};bot.on('physicsTick',watch);
  rcon('summon chicken 8916.5 80 8906.5');await sleep(200);const healthBefore=bot.health,foodBefore=bot.food;try{await e.ensureFood(s);}catch(error){console.log('Chicken food diagnosis',JSON.stringify({source:s.checkpoint.foodSourceObservation,recovery:s.checkpoint.resourceRecovery,body:bot.blockAt(bot.entity.position.floored())?.name,boundingBox:bot.blockAt(bot.entity.position.floored())?.boundingBox,entities:Object.values(bot.entities).map(x=>({name:x.name,position:x.position}))}));throw error;}assert.ok(e.count('chicken')>=1);assert.ok(await e.eat(s));assert.ok(bot.food>foodBefore);assert.ok(bot.health>=healthBefore);assert.equal(wet,false);assert.equal(bot.blockAt(bot.entity.position.floored().offset(0,-1,0))?.name,'grass_block');bot.removeListener('physicsTick',watch);
  console.log('Actual unarmed live chicken food verified',JSON.stringify({healthBefore,foodBefore,health:bot.health,food:bot.food,actual:bot.entity.position,wet,foodGiven:false,weaponGiven:false,sourceAnimalProvided:true}));
 }finally{bot.quit('chicken food validation finished');await sleep(250);rcon('forceload remove 8900 8900 8930 8920');}
});

test('a critical unarmed player follows a live cow and eats its actual beef without a supplied weapon',{timeout:65000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 rcon('forceload add 9000 9000 9059 9059');rcon('fill 9000 77 9000 9059 85 9059 air');rcon('fill 9000 77 9000 9059 78 9059 dirt');rcon('fill 9000 79 9000 9059 79 9059 grass_block');rcon('execute positioned 9030 80 9030 run kill @e[type=!player,distance=..40]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaUnarmedCow',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('tp LayaUnarmedCow 9030.5 80 9030.5');rcon('clear LayaUnarmedCow');await sleep(3500);rcon('effect give LayaUnarmedCow hunger 10 255 true');const hungryUntil=Date.now()+6000;while(bot.food>17&&Date.now()<hungryUntil)await sleep(20);rcon('effect clear LayaUnarmedCow hunger');console.log('Cow injury command',rcon('damage LayaUnarmedCow 16 minecraft:generic'));
  const ready=Date.now()+5000;while((bot.health>6||bot.entity.position.distanceTo(new Vec3(9030.5,80,9030.5))>1)&&Date.now()<ready)await sleep(50);console.log('Cow initial survival state',JSON.stringify({position:bot.entity.position,health:bot.health,food:bot.food}));assert.ok(bot.health>0&&bot.health<=6);assert.ok(bot.food<=17);assert.equal(bot.inventory.items().length,0);
  const m=new Movements(bot);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.scafoldingBlocks=[];m.infiniteLiquidDropdownDistance=false;bot.pathfinder.setMovements(m);
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaUnarmedCow'}),e=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld'}),s=e.services(AbortSignal.timeout(45000));
  let wet=false;const watch=()=>{const p=bot.entity.position.floored();if(bot.blockAt(p)?.name==='water'||bot.blockAt(p.offset(0,-1,0))?.name==='water')wet=true;};bot.on('physicsTick',watch);
  rcon('summon cow 9036.5 80 9030.5');await sleep(200);const healthBefore=bot.health,foodBefore=bot.food;try{await e.ensureFood(s);}catch(error){console.log('Cow food diagnosis',JSON.stringify({source:s.checkpoint.foodSourceObservation,recovery:s.checkpoint.resourceRecovery,body:bot.blockAt(bot.entity.position.floored())?.name,boundingBox:bot.blockAt(bot.entity.position.floored())?.boundingBox,entities:Object.values(bot.entities).map(x=>({name:x.name,position:x.position}))}));throw error;}assert.ok(e.count('beef')>=1);assert.ok(await e.eat(s));assert.ok(bot.food>foodBefore);assert.ok(bot.health>=healthBefore);assert.equal(wet,false);assert.equal(bot.blockAt(bot.entity.position.floored().offset(0,-1,0))?.name,'grass_block');bot.removeListener('physicsTick',watch);
  console.log('Actual unarmed live cow food verified',JSON.stringify({healthBefore,foodBefore,health:bot.health,food:bot.food,actual:bot.entity.position,wet,foodGiven:false,weaponGiven:false,sourceAnimalProvided:true}));
 }finally{bot.quit('cow food validation finished');await sleep(250);rcon('forceload remove 9000 9000 9059 9059');}
});
