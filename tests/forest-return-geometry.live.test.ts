import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import {BotInputSchema,RulesSchema} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {beginResourceTrip,recordResourceTripPosition,returnFromResourceTrip,resourceTrip} from '../packages/minecraft/src/resource-trip';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable minecraft-laya-validation:25566 only');
const rcon=(cmd:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',cmd],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
test('the observed forest corner returns through nearby actual stands after an interrupted shortcut', {timeout:90000,skip:!process.env.MC_FOREST_SNAPSHOT},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const version=process.env.MC_VERSION??'1.21.1',snap=JSON.parse(readFileSync(process.env.MC_FOREST_SNAPSHOT!,'utf8')),data=minecraftData(version),commands=['forceload add 13999 13917 14005 13924','fill 13999 63 13917 14005 78 13924 air','fill 13999 62 13917 14005 62 13924 stone'];
 for(const col of snap.results.filter((r:any)=>Array.isArray(r.blocks)))for(const b of col.blocks){if(b.name==='air')continue;if(!data.blocksByName[b.name]){assert.equal(b.boundingBox,'empty');continue;}const props=Object.entries(b.properties??{});commands.push(`setblock ${col.x+14000} ${b.y} ${col.z+14000} ${b.name}${props.length?'['+props.map(([k,v])=>`${k}=${v}`).join(',')+']':''}`);}
 execFileSync('docker',['exec','-i','minecraft-laya-validation','rcon-cli'],{input:commands.join('\n')+'\nexit\n',encoding:'utf8',maxBuffer:1024*1024});await sleep(200);rcon('kill @e[type=!player,x=13999,y=60,z=13917,dx=6,dy=20,dz=7]');
 const b=await createCompatibleBot({host:'127.0.0.1',port:25566,version,username:'LayaForestCopy',auth:'offline'});b.loadPlugin(pathfinder);
 try{
  await once(b,'spawn');rcon('tp LayaForestCopy 14001.5 67 13919.5');rcon('clear LayaForestCopy');await sleep(1800);
  const m=new Movements(b);m.canDig=false;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.infiniteLiquidDropdownDistance=false;m.scafoldingBlocks=[];b.pathfinder.setMovements(m);
  const rules=RulesSchema.parse({autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaForestCopy'}),ex=new MineflayerExecutor(b,{config,rules,world:'127.0.0.1:25566',dimension:()=>'overworld'}),s=ex.services(AbortSignal.timeout(45000),{resourceRecovery:{oak_log:{elapsedMs:1234,destinationsUsed:3}}});
  await beginResourceTrip(s,'oak_log',1);await s.near(new Vec3(14001.5,66,13920.5),0);await recordResourceTripPosition(s,true);await s.near(new Vec3(14002.5,65,13920.5),0);await recordResourceTripPosition(s,true);
  rcon('tp LayaForestCopy 14002.3 65 13920.3939198034');await sleep(300);await returnFromResourceTrip(s);
  if(version==='26.1'){const attributes=(b.entity as unknown as {attributes:Record<string,{value:number}>}).attributes;assert.ok(Math.abs(attributes['minecraft:movement_speed']!.value-.1)<.000001);assert.equal(attributes['generic.scale'],undefined);}
  assert.equal(resourceTrip(s.checkpoint)!.phase,'complete');assert.ok(b.entity.position.distanceTo(new Vec3(14001.5,67,13919.5))<.6);assert.equal((s.checkpoint.resourceRecovery as any).oak_log.elapsedMs,1234);assert.equal(b.health,20);
  console.log('Actual copied forest return',JSON.stringify({version,nearbyStands:true,recordedTrailPreserved:true,spentBudgetPreserved:true,health:b.health,itemsGiven:false,terrainEditsByBot:false,productionWorld:false}));
 }finally{b.quit('forest return geometry finished');await sleep(200);rcon('forceload remove 13999 13917 14005 13924');}
});
