import {readFileSync,writeFileSync} from 'node:fs';
import {once} from 'node:events';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import {BaseShelterSchema,BotInputSchema,RulesSchema} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {restInWarehouse} from '../packages/minecraft/src/base-shelter';

/** Ordinary maintenance client: no commands, terrain edits, items or attacks. */
async function main(){
 const path=process.argv[2],output=process.argv[3];if(!path||!output)throw Error('Provide an already verified base rule JSON and output path');
 const base=BaseShelterSchema.parse(JSON.parse(readFileSync(path,'utf8'))),host=process.env.MC_HOST??'127.0.0.1',port=Number(process.env.MC_PORT??25566);if(base.world!==`${host}:${port}`)throw Error('Base world differs from the requested connection');
 const {id:_id,...config}=BotInputSchema.parse({name:'LayaBaseMonitor',allowedActions:['home'],connection:{host,port,version:process.env.MC_VERSION,auth:'offline'}}),rules=RulesSchema.parse({world:base.world,dimension:base.dimension,warehouse:{id:base.warehouseId,world:base.world,dimension:base.dimension,position:base.blocks.find(b=>b.name==='chest')!.position},baseShelter:base,autonomyEnabled:false});
 const bot=await createCompatibleBot({...config.connection,username:config.name}),controller=new AbortController();bot.loadPlugin(pathfinder);
 const records:unknown[]=[];bot.on('health',()=>{if(bot.health>0&&bot.health<20)controller.abort('maintenance observer was hurt');});
 try{
  await once(bot,'spawn');await new Promise(r=>setTimeout(r,1800));
  const movement=new Movements(bot);movement.canDig=false;movement.allow1by1towers=false;movement.allowParkour=false;movement.maxDropDown=2;movement.infiniteLiquidDropdownDistance=false;movement.scafoldingBlocks=[];bot.pathfinder.setMovements(movement);
  const record=(action:string,reason:string)=>{const row={at:Date.now(),action,reason,position:bot.entity.position,health:bot.health,food:bot.food,timeOfDay:bot.time.timeOfDay,worldAge:bot.time.age};records.push(row);writeFileSync(output,JSON.stringify({purpose:'ordinary maintenance shelter observation; not the three-day evaluation',records},null,2));console.log(JSON.stringify(row));};
  record('connected','No administrative fixture or gameplay supplies');
  const executor=new MineflayerExecutor(bot,{config,rules,world:base.world,dimension:()=>base.dimension,onProgress:record}),s=executor.services(AbortSignal.any([controller.signal,AbortSignal.timeout(900000)]));
  const sheltered=await restInWarehouse(s,()=>true);record('finished',`sheltered=${sheltered}; actualDay=${bot.time.isDay}`);
  writeFileSync(output,JSON.stringify({purpose:'ordinary maintenance shelter observation; not the three-day evaluation',sheltered,checkpoint:s.checkpoint,records},null,2));
 }finally{bot.clearControlStates();bot.quit('ordinary maintenance observation finished');}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
