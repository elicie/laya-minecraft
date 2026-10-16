import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BotInputSchema,RulesSchema} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {recoveryThreatsClear} from '../packages/minecraft/src/combat-retreat';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(s:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',s],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

test('a real sealed shaft restores all soil and walks behind existing ridge cover while its nearby pillager remains alive',{timeout:90000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const cycle=rcon('gamerule doDaylightCycle').includes('true'),oldTime=Number(rcon('time query daytime').match(/\d+/g)?.at(-1)??0),p=new Vec3(26010,80,26010);
 rcon('forceload add 25990 25990 26030 26030');rcon('fill 25990 76 25990 26030 86 26030 air');rcon('fill 25990 76 25990 26030 76 26030 stone');rcon('fill 25990 77 25990 26030 78 26030 dirt');rcon('fill 25990 79 25990 26030 79 26030 grass_block');
 rcon('fill 26012 75 26008 26020 75 26012 stone');rcon('fill 26012 76 26008 26020 84 26012 air');rcon('gamerule doDaylightCycle true');rcon('time set 11000');rcon('execute positioned 26010 80 26010 run kill @e[type=!player,distance=..50]');
 const b=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',auth:'offline',username:'LayaCoveredExit'});b.loadPlugin(pathfinder);
 try{
  await once(b,'spawn');rcon('tp LayaCoveredExit 26010.5 80 26010.5');rcon('clear LayaCoveredExit');
  for(let i=0;i<160&&(b.entity.position.distanceTo(p.offset(.5,0,.5))>.05||b.entity.onGround!==true||!b.blockAt(p.offset(0,-4,0))||b.time.timeOfDay<11000);i++)await sleep(50);
  const m=new Movements(b);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.scafoldingBlocks=[];b.pathfinder.setMovements(m);
  const {id:_id,...config}=BotInputSchema.parse({name:'LayaCoveredExit'}),rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false});
  const e=new MineflayerExecutor(b,{config,rules,world:rules.world,dimension:()=>'overworld',onProgress:(action,reason)=>console.log(JSON.stringify({action,reason,position:b.entity.position,health:b.health}))});
  const cancel=new AbortController(),s=e.services(cancel.signal);let failure:unknown;const first=e.shelterAtNight(s).catch(error=>{failure=error;return false;});
  for(let i=0;i<500&&(s.checkpoint.nightSoilShaft as any)?.phase!=='closed'&&!failure;i++)await sleep(50);if(failure)throw failure;
  assert.equal((s.checkpoint.nightSoilShaft as any)?.phase,'closed');cancel.abort();await first;
  rcon('summon pillager 26013.5 76 26010.5');await sleep(500);assert.equal(recoveryThreatsClear(b,p),false);
  const health=b.health,resumed=e.services(AbortSignal.timeout(45000),structuredClone(s.checkpoint));rcon('time set 1000');
  assert.equal(await e.shelterAtNight(resumed),true);assert.equal(resumed.checkpoint.nightBurrowPending,false);
  assert.equal((resumed.checkpoint.nightSoilShaft as any)?.phase,'done');assert.ok((resumed.checkpoint.nightSoilEgress as any)?.path.length>0);
  for(const d of [1,2,3])assert.equal(b.blockAt(p.offset(0,-d,0))?.name,'dirt');
  assert.equal(recoveryThreatsClear(b,b.entity.position),true);assert.equal(b.health,health);assert.equal(e.count('dirt'),0);
  assert.ok(Object.values(b.entities).some(e=>e.name==='pillager'),'the hostile was not removed to force the exit');
  console.log('Actual covered escape',JSON.stringify({materialsGiven:false,hostileStillAlive:true,soilRestored:3,walked:(resumed.checkpoint.nightSoilEgress as any).walked,actual:b.entity.position,health:b.health,productionWorld:false}));
 }finally{b.quit('covered escape validation finished');await sleep(200);rcon('execute positioned 26010 80 26010 run kill @e[type=pillager,distance=..50]');rcon(`gamerule doDaylightCycle ${cycle}`);rcon(`time set ${oldTime}`);rcon('forceload remove 25990 25990 26030 26030');}
});
