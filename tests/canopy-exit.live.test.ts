import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BotInputSchema,RulesSchema} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {leaveRecoveryEdge} from '../packages/minecraft/src/recovery-safety';
import {safeResourceStand} from '../packages/minecraft/src/resource-recovery';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(s:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',s],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
test('an actual stable canopy exit reaches natural ground without editing leaves or spending held materials',{timeout:45000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 rcon('forceload add 9200 9200 9220 9212');rcon('fill 9200 76 9200 9220 87 9212 air');rcon('fill 9200 77 9200 9220 78 9212 dirt');rcon('fill 9200 79 9200 9220 79 9212 grass_block');rcon('fill 9209 80 9200 9220 80 9212 grass_block');rcon('fill 9200 80 9200 9204 80 9212 grass_block');rcon('fill 9205 81 9205 9208 81 9206 oak_leaves[persistent=true]');rcon('setblock 9206 82 9206 stone');rcon('execute positioned 9210 80 9206 run kill @e[type=!player,distance=..40]');
 const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaCanopyExit',auth:'offline'});bot.loadPlugin(pathfinder);
 try{
  await once(bot,'spawn');rcon('tp LayaCanopyExit 9207.5 82 9206.5');rcon('clear LayaCanopyExit');rcon('give LayaCanopyExit oak_log 8');rcon('give LayaCanopyExit wooden_axe 1');
  const ready=Date.now()+8000;while((bot.entity.onGround!==true||bot.entity.position.distanceTo(new Vec3(9207.5,82,9206.5))>.1||bot.inventory.items().length!==2)&&Date.now()<ready)await sleep(50);assert.equal(bot.blockAt(bot.entity.position.floored().offset(0,-1,0))?.name,'oak_leaves');assert.equal(safeResourceStand(bot,bot.entity.position,()=>false),false);
  rcon('summon husk 9223.5 82 9206.5 {NoAI:1b,NoGravity:1b}');await sleep(200);const threat=Object.values(bot.entities).find(e=>e.name==='husk');assert.ok(threat);const initialThreatDistance=bot.entity.position.distanceTo(threat.position);assert.ok(initialThreatDistance>12&&initialThreatDistance<20);const m=new Movements(bot);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.scafoldingBlocks=[];m.infiniteLiquidDropdownDistance=false;bot.pathfinder.setMovements(m);
  const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaCanopyExit'}),executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld'}),s=executor.services(AbortSignal.timeout(30000),{canopyExitVersion:1,recoverySafety:{anchor:{x:9207,y:82,z:9206},attempts:5,elapsedMs:170,probes:[],status:'waiting',fingerprint:'legacy-preflight',reason:'legacy no-motion planning refusals',displacements:[]}}),before=bot.inventory.items().map(i=>({name:i.name,count:i.count}));
  assert.equal(await leaveRecoveryEdge(bot,s),true);assert.equal(safeResourceStand(bot,bot.entity.position,()=>false),true);assert.equal(bot.entity.onGround,true);assert.ok(Math.abs(bot.entity.position.y-Math.round(bot.entity.position.y))<.05);assert.ok(s.checkpoint.canopyExit);assert.ok(s.checkpoint.canopyExitPreflightRepair);assert.ok((s.checkpoint.canopyExitSearch as {routes:{mode?:string}[]}).routes.some(r=>r.mode==='individual'));assert.ok(bot.entity.position.x<=9203.5);assert.ok(bot.entity.position.distanceTo(threat.position)>=20);assert.deepEqual(bot.inventory.items().map(i=>({name:i.name,count:i.count})),before);for(let x=9205;x<=9208;x++)assert.equal(bot.blockAt(new Vec3(x,81,9206))?.name,'oak_leaves');
  console.log('Actual canopy exit verified',JSON.stringify({actual:bot.entity.position,exit:s.checkpoint.canopyExit,safetyAttempts:(s.checkpoint.recoverySafety as {attempts:number}).attempts,heldItemsPrepared:true,hostileProvided:true,initialThreatDistance,finalThreatDistance:bot.entity.position.distanceTo(threat.position),botTerrainEdits:false}));
 }finally{bot.quit('canopy exit validation finished');await sleep(250);rcon('forceload remove 9200 9200 9220 9212');}
});
