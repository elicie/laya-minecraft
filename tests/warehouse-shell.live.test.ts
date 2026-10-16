import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { BotInputSchema, RulesSchema, type TaskSpec } from '../packages/contracts/src';
import { blueprint, materialRequirements } from '../packages/contracts/src/blueprints';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { executeVillageTask } from '../packages/minecraft/src/village-actions';

if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon=(command:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8'});
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('an actual warehouse closes its complete shell after failed windows, then installs the windows from the ground without reopening its construction stair',{timeout:360000},async()=>{
  assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
  rcon('forceload add 7100 7100 7130 7130');rcon('fill 7100 80 7100 7130 86 7130 air');rcon('fill 7100 76 7100 7130 78 7130 dirt');rcon('fill 7100 79 7100 7130 79 7130 grass_block');
  const bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'LayaWindowStage',auth:'offline'});bot.loadPlugin(pathfinder);
  try{
    await once(bot,'spawn');rcon('tp LayaWindowStage 7108.5 80 7104.5');rcon('clear LayaWindowStage');
    const origin={x:7105,y:80,z:7105},blocks=blueprint('warehouse',origin),required=materialRequirements(blocks);
    for(const [item,quantity] of Object.entries(required))if(item!=='glass_pane')rcon(`give LayaWindowStage ${item} ${quantity}`);
    const ready=Date.now()+10000;while((bot.entity.position.distanceTo(new Vec3(7108.5,80,7104.5))>1||Object.entries(required).some(([item,n])=>item!=='glass_pane'&&bot.inventory.items().filter(i=>i.name===item).reduce((s,i)=>s+i.count,0)<n))&&Date.now()<ready)await sleep(100);
    const movements=new Movements(bot);movements.canDig=false;movements.canOpenDoors=true;movements.allow1by1towers=false;movements.allowParkour=false;movements.maxDropDown=2;movements.infiniteLiquidDropdownDistance=false;movements.scafoldingBlocks=[];bot.pathfinder.setMovements(movements);
    const rules=RulesSchema.parse({world:'127.0.0.1:25566',autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaWindowStage'});
    const executor=new MineflayerExecutor(bot,{config,rules,world:rules.world,dimension:()=>'overworld',villageTask:executeVillageTask});
    const services=executor.services(AbortSignal.timeout(330000),{materialExpedition:true,confirmedRecoveryDeathId:'observed-respawn',resourceTrip:{item:'glass_pane',minimum:3,home:{x:7108,y:80,z:7104},trail:[{x:7108,y:80,z:7104}],phase:'complete',returns:1,failure:'Observed sand search failed'}});
    const task:TaskSpec={id:'stage',goalId:'warehouse',kind:'build',source:'user',params:{design:'warehouse',origin},completion:{kind:'blocks',blocks},dependencies:[],reservationKeys:[]};
    for(const count of [8,16,24,32,35]){const foundation=await executor.execute(task,services);assert.equal(foundation.outcome,'partial',foundation.reason);
      assert.equal(blocks.filter(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name===b.name).length,count,'small actual floor batches are committed before upper construction');}
    for(let batch=0;batch<20&&blocks.filter(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name===b.name).length<133;batch++){
      const shell=await executor.execute(task,services);assert.equal(shell.outcome,'partial',shell.reason);
    }
    assert.equal(typeof services.checkpoint.buildAccess,'string','the staged warehouse preserves its observed stair until final closure');
    const remaining=blocks.filter(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name!==b.name);
    assert.equal(remaining.length,3);assert.ok(remaining.every(b=>b.name==='glass_pane'));assert.ok(Math.abs(bot.entity.position.y-80)<.1);
    assert.equal(bot.inventory.items().filter(i=>i.name==='glass_pane').length,0);
    rcon('give LayaWindowStage glass_pane 3');const glassUntil=Date.now()+5000;while(executor.count('glass_pane')<3&&Date.now()<glassUntil)await sleep(50);
    const complete=await executor.execute(task,services);assert.equal(complete.outcome,'completed',complete.reason);
    assert.ok(blocks.every(b=>bot.blockAt(new Vec3(b.position.x,b.position.y,b.position.z))?.name===b.name));
    for(const block of blocks)assert.match(rcon(`execute if block ${block.position.x} ${block.position.y} ${block.position.z} ${block.name}`),/Test passed/);
    console.log('Actual staged warehouse verified',JSON.stringify({origin,cells:blocks.length,shellCells:133,windows:3,constructionMaterialsProvided:true,actual:bot.entity.position}));
  }finally{bot.quit('warehouse staged windows validation finished');await sleep(250);rcon('forceload remove 7100 7100 7130 7130');}
});
