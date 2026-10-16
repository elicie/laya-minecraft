import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { startRuntime } from '../apps/server/src/main';
import { BotInputSchema, RulesSchema, CommandReceiptSchema, FleetSnapshotSchema } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ResourceRecovery } from '../packages/minecraft/src/resource-recovery';
import { resourceTrip } from '../packages/minecraft/src/resource-trip';

if (process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function guard(){assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');}
async function until(check:()=>boolean, reason:string, timeout=15000){const end=Date.now()+timeout;while(!check()&&Date.now()<end)await sleep(100);assert.ok(check(),reason);}

test('building material trip mines sand beyond the spent local region, actually smelts and crafts panes, and returns with them', {timeout:300000},async()=>{
  guard();const home=new Vec3(5806.5,80,5806.5);
  rcon('forceload add 5800 5800 5960 5812');rcon('fill 5800 80 5800 5960 86 5812 air');rcon('fill 5800 75 5800 5960 78 5812 dirt');rcon('fill 5800 79 5800 5960 79 5812 grass_block');
  rcon('fill 5940 80 5806 5945 80 5806 sand');
  const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaMaterialTrip',auth:'offline'});bot.loadPlugin(pathfinder);
  try{
    await once(bot,'spawn');rcon('tp LayaMaterialTrip 5806.5 80 5806.5');rcon('clear LayaMaterialTrip');
    // These utilities and fuel isolate sand exploration, real processing and return.
    rcon('give LayaMaterialTrip crafting_table 1');rcon('give LayaMaterialTrip furnace 1');rcon('give LayaMaterialTrip coal 1');
    await until(()=>bot.entity.position.distanceTo(home)<1&&bot.inventory.items().length===3&&!!bot.blockAt(home.floored().offset(0,-1,0)),'actual initial material state');
    const movements=new Movements(bot);movements.canDig=false;movements.allow1by1towers=false;movements.allowParkour=false;movements.maxDropDown=2;movements.infiniteLiquidDropdownDistance=false;movements.scafoldingBlocks=[];bot.pathfinder.setMovements(movements);
    const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false});const{id:_id,...config}=BotInputSchema.parse({name:'LayaMaterialTrip'});
    let furthest=0;
    const executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld',villageTask:async(_task,s)=>{await s.ensureItem('glass_pane',3);return{outcome:'completed',checkpoint:s.checkpoint,observations:s.observations,evidence:s.evidence};},onProgress:(action,reason)=>{furthest=Math.max(furthest,bot.entity.position.distanceTo(home));if(action==='제련'||action==='제작')console.log(action,reason);}});
    const services=executor.services(AbortSignal.timeout(270000));
    const old=new ResourceRecovery(bot,services,'sand',['sand'],true,()=>false);old.state.destinationsUsed=5;old.state.elapsedMs=60000;old.wait('preserved spent local search',6);
    const result=await executor.execute({id:'material',goalId:'warehouse',kind:'build',source:'user',params:{materialExpedition:true},completion:{kind:'manual',reason:'physical material processing and return'},dependencies:[],reservationKeys:[]},services);
    assert.equal(result.outcome,'completed');assert.ok(furthest>100);assert.ok(executor.count('glass_pane')>=3);
    assert.ok(bot.entity.position.distanceTo(home)<1.5);assert.equal(resourceTrip(services.checkpoint)!.phase,'complete');
    assert.match(rcon('execute if block 5940 80 5806 air'),/Test passed/);
    console.log('Verified actual building material trip',JSON.stringify({home,furthest,actual:bot.entity.position,glassPanes:executor.count('glass_pane'),inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),returns:resourceTrip(services.checkpoint)!.returns,provided:['crafting_table','furnace','coal'],sandOrGlassGiven:false}));
  }finally{const ended=once(bot,'end');bot.quit('material trip validation finished');await Promise.race([ended,sleep(1000)]);rcon('forceload remove 5800 5800 5960 5812');}
});

test('a real wood trip provisions food at hunger 18 and completes only with the logs back at its requested work position', {timeout:240000},async()=>{
  guard();const dir=mkdtempSync(join(tmpdir(),'laya-wood-return-')),botId=randomUUID(),home={x:6306.5,y:80,z:6306.5};
  rcon('forceload add 6300 6300 6420 6312');rcon('fill 6300 80 6300 6420 86 6312 air');rcon('fill 6300 75 6300 6420 78 6312 dirt');rcon('fill 6300 79 6300 6420 79 6312 grass_block');
  rcon('fill 6406 80 6306 6406 81 6306 oak_log');rcon('fill 6405 82 6305 6407 82 6307 oak_leaves[persistent=true]');
  rcon('setblock 6358 79 6308 farmland[moisture=7]');rcon('setblock 6358 80 6308 potatoes[age=7]');rcon('kill @e[type=!player,x=6300,y=-64,z=6300,dx=120,dy=152,dz=12]');
  const runtime=await startRuntime({runtimeDir:dir,host:'127.0.0.1',port:0,workerExecArgv:['--import','tsx'],tickIntervalMs:100});const url=`http://127.0.0.1:${runtime.address.port}/api/v1`;
  async function request(method:string,path:string,body?:unknown){const response=await fetch(url+path,{method,headers:{'content-type':'application/json','x-laya-control':'1','idempotency-key':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const value:unknown=await response.json();assert.equal(response.status,method==='GET'?200:202,JSON.stringify(value));return value;}
  async function command(method:string,path:string,body:unknown={}){let r=CommandReceiptSchema.parse(await request(method,path,body));const end=Date.now()+20000;while(!['applied','failed'].includes(r.state)&&Date.now()<end){await sleep(100);r=CommandReceiptSchema.parse(await request('GET','/commands/'+r.id));}assert.equal(r.state,'applied',JSON.stringify(r));return r;}
  try{
    await command('PATCH','/rules',{patch:{world:'127.0.0.1:25566',autonomyEnabled:false}});await command('POST','/bots',{id:botId,name:'LayaWoodReturn',connection:{host:'127.0.0.1',port:25566,version:'1.21.1'}});
    let s=FleetSnapshotSchema.parse(await request('GET','/snapshot'));const readyUntil=Date.now()+20000;
    while(!s.agents.find(a=>a.id===botId)?.session?.report?.ready&&Date.now()<readyUntil){await sleep(100);s=FleetSnapshotSchema.parse(await request('GET','/snapshot'));}
    await command('POST',`/bots/${botId}/pause`);rcon('tp LayaWoodReturn 6306.5 80 6306.5');rcon('clear LayaWoodReturn');
    const positionUntil=Date.now()+10000;
    while(s.agents.find(a=>a.id===botId)?.session?.report?.position?.x!==home.x&&Date.now()<positionUntil){await sleep(100);s=FleetSnapshotSchema.parse(await request('GET','/snapshot'));}
    rcon('gamemode survival LayaWoodReturn');rcon('effect clear LayaWoodReturn');rcon('effect give LayaWoodReturn minecraft:instant_health 1 10 true');rcon('effect give LayaWoodReturn minecraft:hunger 30 31 true');
    const actualFood=()=>{const raw=rcon('data get entity LayaWoodReturn foodLevel'),match=raw.trim().match(/(-?\d+)\s*$/);assert.ok(match,raw);return Number(match[1]);};
    const hungerUntil=Date.now()+40000;while(actualFood()>18&&Date.now()<hungerUntil)await sleep(100);rcon('effect clear LayaWoodReturn minecraft:hunger');assert.equal(actualFood(),18,'the real survival player starts without a food item at hunger 18');
    const receipt=await command('POST','/goals',{kind:'collect',item:'oak_log',quantity:2,preferredBotId:botId,params:{returnTo:home}}),goalId=String((receipt.result as {goalId:string}).goalId);
    await command('POST',`/bots/${botId}/resume`);let heldBeforeReturn=false,provisionedBeforeWood=false,ateBeforeWood=false;const end=Date.now()+200000;
    while(Date.now()<end){
      s=FleetSnapshotSchema.parse(await request('GET','/snapshot'));const a=s.agents.find(a=>a.id===botId)!,g=s.goals.find(g=>g.id===goalId)!;
      const count=a.session?.report?.inventory.filter(i=>i.name==='oak_log').reduce((sum,i)=>sum+i.count,0)??0;
      const p=a.session?.report?.position;
      if(a.survivalRecovery?.checkpoint.expeditionFoodTarget===19&&a.session?.report?.health===20&&count===0)provisionedBeforeWood=true;
      if(provisionedBeforeWood&&count===0&&(a.session?.report?.food??0)>=19)ateBeforeWood=true;
      if(count>=2&&p&&Math.hypot(p.x-home.x,p.z-home.z)>20){assert.notEqual(g.state,'completed');heldBeforeReturn=true;}
      if(g.state==='completed')break;
      await sleep(200);
    }
    const g=s.goals.find(g=>g.id===goalId)!;assert.equal(g.state,'completed',JSON.stringify({state:g.state,reason:g.reason,action:s.agents.find(a=>a.id===botId)?.session?.report?.action}));assert.equal(heldBeforeReturn,true);assert.equal(provisionedBeforeWood,true);assert.equal(ateBeforeWood,true);
    const a=s.agents.find(a=>a.id===botId)!,p=a.session!.report!.position!;assert.ok(Math.hypot(p.x-home.x,p.y-home.y,p.z-home.z)<=1.5);assert.ok(a.session!.report!.inventory.some(i=>i.name==='oak_log'&&i.count>=2));
    assert.match(rcon('execute if block 6358 80 6308 air'),/Test passed/);
    console.log('Verified real wood collection and return',JSON.stringify({home,actual:p,goalState:g.state,heldBeforeReturn,provisionedBeforeWood,ateBeforeWood,food:a.session!.report!.food,inventory:a.session!.report!.inventory}));
  }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});rcon('forceload remove 6300 6300 6420 6312');}
});
