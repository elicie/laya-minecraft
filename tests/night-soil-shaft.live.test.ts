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
test('an empty player shelters under flat observed soil, resumes sealed, then climbs out and restores the three real cuts',{timeout:85000},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const cycle=rcon('gamerule doDaylightCycle').includes('true'),oldTime=Number(rcon('time query daytime').match(/\d+/g)?.at(-1)??0);let p=new Vec3(25010,80,25010);
 rcon('forceload add 25000 25000 25025 25025');rcon('fill 25000 76 25000 25025 87 25025 air');rcon('fill 25000 76 25000 25025 76 25025 stone');rcon('fill 25000 77 25000 25025 78 25025 dirt');rcon('fill 25000 79 25000 25025 79 25025 grass_block');rcon('setblock 25010 78 25010 stone');rcon('gamerule doDaylightCycle true');rcon('time set 11000');rcon('execute positioned 25010 80 25010 run kill @e[type=!player,distance=..40]');
 const b=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',auth:'offline',username:'LayaSoilShaft'});b.loadPlugin(pathfinder);
 try{
  await once(b,'spawn');rcon('tp LayaSoilShaft 25010.5 80 25010.5');rcon('clear LayaSoilShaft');
  for(let i=0;i<160&&(b.entity.position.distanceTo(p.offset(.5,0,.5))>.05||b.entity.onGround!==true||!b.blockAt(p.offset(0,-4,0))||b.time.timeOfDay<11000);i++)await sleep(50);
  const m=new Movements(b);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.scafoldingBlocks=[];b.pathfinder.setMovements(m);
  const {id:_id,...config}=BotInputSchema.parse({name:'LayaSoilShaft'}),rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),e=new MineflayerExecutor(b,{config,rules,world:rules.world,dimension:()=>'overworld',onProgress:(action,reason)=>console.log('Shaft progress',JSON.stringify({action,reason,position:b.entity.position,inventory:b.inventory.items().map(i=>({name:i.name,count:i.count}))}))});
  const denied=e.services(AbortSignal.timeout(5000),{buildProtection:{origin:{x:24990,y:70,z:24990},width:50,depth:50,height:20}});assert.equal(await e.shelterAtNight(denied),false);assert.equal(b.inventory.items().length,0);
  const cancel=new AbortController(),s=e.services(cancel.signal);let failure:unknown;const first=e.shelterAtNight(s).catch(error=>{failure=error;return false;});
  for(let i=0;i<500&&(s.checkpoint.nightSoilShaft as any)?.phase!=='closed'&&!failure;i++)await sleep(50);if(failure)throw failure;
  assert.equal((s.checkpoint.nightSoilShaft as any)?.phase,'closed');const actual=(s.checkpoint.nightSoilShaft as any).outside;p=new Vec3(actual.x,actual.y,actual.z);assert.notEqual(p.x===25010&&p.z===25010,true,'the shallow original soil must be preserved');assert.equal(b.blockAt(p.offset(0,-1,0))?.name,'dirt');assert.equal(Math.round(b.entity.position.y),77);const health=b.health;
  cancel.abort();await first;rcon(`setblock ${p.x} ${p.y-1} ${p.z} grass_block`);await sleep(150);const resumed=e.services(AbortSignal.timeout(35000),structuredClone(s.checkpoint));let completed=false;const second=e.shelterAtNight(resumed).then(v=>{completed=true;return v;});second.catch(()=>{});
  rcon('time set 18000');rcon(`summon husk ${p.x+.5} ${p.y} ${p.z+.5}`);await sleep(1500);assert.equal(b.health,health);assert.equal(completed,false);assert.equal(b.blockAt(p.offset(0,-1,0))?.name,'grass_block');
  rcon('time set 1000');await sleep(1000);assert.equal(completed,false,'daylight must not open under a nearby actual hostile');rcon('execute positioned 25010 80 25010 run kill @e[type=husk,distance=..40]');
  assert.equal(await second,true);assert.equal(resumed.checkpoint.nightBurrowPending,false);for(const d of [1,2,3])assert.equal(b.blockAt(p.offset(0,-d,0))?.name,'dirt');assert.equal(Math.round(b.entity.position.y),80);assert.equal(b.entity.onGround,true);assert.equal(b.health,health);assert.equal(e.count('dirt'),0);assert.equal(b.blockAt(new Vec3(25010,78,25010))?.name,'stone');assert.equal(b.blockAt(p.offset(0,-4,0))?.name,'stone');
  console.log('Actual flat soil shelter',JSON.stringify({materialsGiven:false,foodGiven:false,fixtureHostile:true,closedCheckpointResumed:true,cutsRestored:3,actual:b.entity.position,health:b.health,productionWorld:false}));
 }finally{b.quit('flat soil shelter validation finished');await sleep(200);rcon('execute positioned 25010 80 25010 run kill @e[type=husk,distance=..40]');rcon(`gamerule doDaylightCycle ${cycle}`);rcon(`time set ${oldTime}`);rcon('forceload remove 25000 25000 25025 25025');}
});
