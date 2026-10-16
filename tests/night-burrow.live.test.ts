import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BotInputSchema,RulesSchema} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(s:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',s],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
test('an empty player digs a protected-aware dirt recess, stays safe from an actual husk overnight, then restores all four excavated cells',{timeout:70000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const previousCycle=/\btrue\b/.test(rcon('gamerule doDaylightCycle'));rcon('gamerule doDaylightCycle true');rcon('time set 1000');rcon('forceload add 9400 9400 9430 9420');rcon('fill 9400 76 9400 9430 87 9420 air');rcon('fill 9400 77 9400 9430 78 9420 dirt');rcon('fill 9400 79 9400 9430 79 9420 grass_block');rcon('fill 9410 80 9400 9430 85 9420 dirt');rcon('fill 9410 79 9400 9430 79 9420 stone');rcon('fill 9410 82 9400 9430 82 9420 stone');rcon('execute positioned 9410 80 9410 run kill @e[type=!player,distance=..64]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaNightBurrow',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('tp LayaNightBurrow 9408.5 80 9410.5');rcon('clear LayaNightBurrow');const ready=Date.now()+8000;while((bot.entity.position.distanceTo(new Vec3(9408.5,80,9410.5))>.1||bot.entity.onGround!==true||!bot.blockAt(new Vec3(9412,82,9410)))&&Date.now()<ready)await sleep(50);assert.equal(bot.inventory.items().length,0);
  const m=new Movements(bot);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.scafoldingBlocks=[];m.infiniteLiquidDropdownDistance=false;bot.pathfinder.setMovements(m);
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaNightBurrow'}),e=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld',onProgress:(action,reason)=>console.log('Actual burrow progress',JSON.stringify({action,reason,actual:bot.entity.position,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count}))}))});
  rcon('time set 11000');const nightUntil=Date.now()+5000;while(bot.time.timeOfDay<11000&&Date.now()<nightUntil)await sleep(50);assert.equal(bot.time.isDay,true);
  const denied=e.services(AbortSignal.timeout(5000),{buildProtection:{origin:{x:9400,y:76,z:9400},width:31,depth:21,height:12}});assert.equal(await e.shelterAtNight(denied),false);assert.equal(bot.blockAt(new Vec3(9410,80,9410))?.name,'dirt');assert.equal(bot.inventory.items().length,0);
  const s=e.services(AbortSignal.timeout(55000));let finished=false,failure:unknown;const resting=e.shelterAtNight(s).then(v=>{finished=true;return v;},error=>{failure=error;return false;});
  const closedUntil=Date.now()+25000;while((s.checkpoint.nightBurrow as {phase?:string}|undefined)?.phase!=='closed'&&!failure&&Date.now()<closedUntil)await sleep(50);if(failure)throw failure;assert.equal((s.checkpoint.nightBurrow as {phase:string}).phase,'closed');assert.equal(s.checkpoint.nightBurrowPending,true);assert.equal(finished,false);
  const burrow=s.checkpoint.nightBurrow as {outside:{x:number;y:number;z:number};direction:{x:number;y:number;z:number};phase:string},outside=new Vec3(burrow.outside.x,burrow.outside.y,burrow.outside.z),front=outside.plus(new Vec3(burrow.direction.x,0,burrow.direction.z)),inside=front.plus(new Vec3(burrow.direction.x,0,burrow.direction.z)),health=bot.health;
  rcon('time set 18000');rcon(`summon husk ${outside.x+.5} ${outside.y} ${outside.z+.5}`);await sleep(2000);assert.equal(bot.health,health);assert.equal(bot.blockAt(front)?.name,'dirt');assert.equal(bot.blockAt(front.offset(0,1,0))?.name,'dirt');assert.ok(bot.entity.position.distanceTo(inside.offset(.5,0,.5))<1.5);
  rcon('time set 1000');await sleep(1000);assert.equal(finished,false,'daylight alone cannot open onto the actual adjacent hostile');rcon('execute positioned 9410 80 9410 run kill @e[type=husk,distance=..64]');assert.equal(await resting,true);if(failure)throw failure;
  assert.equal(s.checkpoint.nightBurrowPending,false);assert.equal((s.checkpoint.nightBurrow as {phase:string}).phase,'done');for(const p of [front,front.offset(0,1,0),inside,inside.offset(0,1,0)])assert.equal(bot.blockAt(p)?.name,'dirt');assert.ok(bot.entity.position.distanceTo(outside.offset(.5,0,.5))<1.5);assert.equal(bot.health,health);assert.equal(bot.blockAt(front.offset(0,-1,0))?.name,'stone');assert.equal(bot.blockAt(inside.offset(0,2,0))?.name,'stone');
  console.log('Actual night dirt shelter verified',JSON.stringify({actual:bot.entity.position,health,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),foodGiven:false,toolsGiven:false,materialsGiven:false,hostileProvided:true,dugCellsRestored:4,protectedTerrainUnchanged:true}));
 }finally{bot.quit('night burrow validation finished');await sleep(250);rcon('time set 1000');rcon(`gamerule doDaylightCycle ${previousCycle}`);rcon('forceload remove 9400 9400 9430 9420');}
});
