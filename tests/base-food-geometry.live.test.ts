import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Vec3} from 'vec3';
import {pathfinder,Movements} from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import {BotInputSchema,RulesSchema,type Position,type TaskSpec} from '../packages/contracts/src';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {MineflayerExecutor} from '../packages/minecraft/src/actions';
import {executeVillageTask} from '../packages/minecraft/src/village-actions';
import {restInWarehouse} from '../packages/minecraft/src/base-shelter';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable minecraft-laya-validation:25566 only');
const rcon=(cmd:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',cmd],{encoding:'utf8'}),sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
test('observed production bank geometry supports three real pickups, replanting, warehouse bread and eating',{
 timeout:300000,skip:!process.env.MC_GEOMETRY_SNAPSHOT||!process.env.MC_GEOMETRY_RULES,
},async()=>{
 assert.equal(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim(),'25566');
 const snapshot=JSON.parse(readFileSync(process.env.MC_GEOMETRY_SNAPSHOT!,'utf8')),scene=snapshot.results[0];assert.equal(snapshot.observerUnmoved,true);assert.equal(scene.readOnly,true);assert.equal(scene.world,'infra:25565');
 const shift=(p:Position)=>({x:p.x+12000,y:p.y,z:p.z+12000}),source=JSON.parse(readFileSync(process.env.MC_GEOMETRY_RULES!,'utf8')),world='127.0.0.1:25566';
 const base={...source.baseShelter,world,door:shift(source.baseShelter.door),inside:shift(source.baseShelter.inside),outside:shift(source.baseShelter.outside),blocks:source.baseShelter.blocks.map((b:any)=>({...b,position:shift(b.position)}))},warehouse={...source.warehouse,world,position:shift(source.warehouse.position)},farm={...source.baseAutonomy,origin:shift(source.baseAutonomy.origin),positions:source.baseAutonomy.positions.map(shift)};
 const version=process.env.MC_VERSION??'1.21.1',cycleRule=version.startsWith('26.')?'minecraft:advance_time':'doDaylightCycle',ticksRule=version.startsWith('26.')?'minecraft:random_tick_speed':'randomTickSpeed';
 const oldCycle=rcon('gamerule '+cycleRule).includes('true'),oldTime=Number(rcon('time query daytime').match(/\d+/g)?.at(-1)??0),oldTicks=Number(rcon('gamerule '+ticksRule).match(/\d+/g)?.at(-1)??3);
 const setupOnly=process.env.MC_FARM_SETUP_ONLY==='1',fullBatch=process.env.MC_FARM_FULL_BATCH==='1',harvestCount=fullBatch?farm.positions.length:3,breadCount=fullBatch?Math.floor(farm.positions.length/3):1;
 const data=minecraftData(version),commands=['forceload add 12043 12000 12069 12058','fill 12043 59 12000 12069 78 12058 air','fill 12043 79 12000 12069 98 12058 air',`gamerule ${cycleRule} false`,`gamerule ${ticksRule} 0`,'time set 0'],omitted:string[]=[];
 for(const row of [...scene.runs].sort((a:any,b:any)=>Number(['water','lava'].includes(a.state.name))-Number(['water','lava'].includes(b.state.name)))){
  const {name,properties,boundingBox}=row.state;
  if(!data.blocksByName[name]){assert.equal(boundingBox,'empty',`Unsupported solid ${name}`);omitted.push(name);continue;}
  const state=name+(Object.keys(properties).length?'['+Object.entries(properties).map(([k,v])=>`${k}=${v}`).join(',')+']':'');commands.push(`fill ${row.x+12000} ${row.y} ${row.from+12000} ${row.x+12000} ${row.y} ${row.to+12000} ${state}`);
 }
 if(!setupOnly)for(const p of farm.positions){commands.push(`setblock ${p.x} ${p.y} ${p.z} farmland[moisture=7]`,`setblock ${p.x} ${p.y+1} ${p.z} wheat[age=7]`);}
 for(const row of scene.runs.filter((r:any)=>r.state.name==='oak_door'))commands.push(`fill ${row.x+12000} ${row.y} ${row.from+12000} ${row.x+12000} ${row.y} ${row.to+12000} oak_door[${Object.entries(row.state.properties).map(([k,v])=>`${k}=${v}`).join(',')}]`);
 let bot:Awaited<ReturnType<typeof createCompatibleBot>>|undefined;
 try{
  const response=execFileSync('docker',['exec','-i','minecraft-laya-validation','rcon-cli'],{input:commands.join('\n')+'\nexit\n',encoding:'utf8',maxBuffer:4*1024*1024});writeFileSync('/tmp/laya-base-geometry-fixture-rcon.log',response);assert.doesNotMatch(response,/Unknown or incomplete command|Incorrect argument|Expected .* at position|not loaded|outside of the world/i);
  console.log('Copied observed terrain into disposable server',JSON.stringify({runs:scene.runs.length,omittedEmptyDecorations:[...new Set(omitted)],productionWorld:false,administrativeFixture:true}));
  await sleep(300);rcon('kill @e[type=!player,x=12043,y=55,z=12000,dx=26,dy=50,dz=58]');
  bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version,username:'LayaBankCopy',auth:'offline'});bot.loadPlugin(pathfinder);await once(bot,'spawn');
  const warehouseTool=process.env.MC_BASE_TOOL_FROM_WAREHOUSE==='1',carriedTool=process.env.MC_BASE_TOOL_START_CARRIED==='1',start=carriedTool?new Vec3(12049.5,64,12047.5):new Vec3(base.outside.x+.5,base.outside.y,base.outside.z+.5);
  rcon(`tp LayaBankCopy ${start.x} ${start.y} ${start.z}`);rcon('clear LayaBankCopy');rcon(`give LayaBankCopy wheat_seeds ${farm.positions.length}`);
  if(carriedTool)rcon('give LayaBankCopy oak_log 1');else if(warehouseTool)rcon(`item replace block ${warehouse.position.x} ${warehouse.position.y} ${warehouse.position.z} container.0 with oak_log 1`);else rcon('give LayaBankCopy wooden_hoe 1');
  const until=Date.now()+10000;while((bot.entity.position.distanceTo(start)>.3||!bot.blockAt(new Vec3(farm.origin.x,farm.origin.y,farm.origin.z))||!bot.inventory.items().some(i=>i.name==='wheat_seeds'))&&Date.now()<until)await sleep(50);
  await sleep(1800);
  const m=new Movements(bot);m.canDig=false;m.canOpenDoors=true;m.allow1by1towers=false;m.allowParkour=false;m.maxDropDown=2;m.infiniteLiquidDropdownDistance=false;m.scafoldingBlocks=[];m.blocksToAvoid.add(bot.registry.blocksByName.farmland!.id);bot.pathfinder.setMovements(m);
  const rules=RulesSchema.parse({world,warehouse,baseShelter:base,baseAutonomy:farm,autonomyEnabled:false}),{id:_id,...config}=BotInputSchema.parse({name:'LayaBankCopy'}),executor=new MineflayerExecutor(bot,{config,rules,world,dimension:()=>'overworld',villageTask:executeVillageTask}),s=executor.services(AbortSignal.timeout(180000));
  const task:TaskSpec={id:'copied-bank',goalId:'fixture',kind:'farm',source:'user',params:{...farm,crop:'wheat',mode:setupOnly?'setup':'harvest',plots:farm.positions.length},completion:{kind:'farm',crop:'wheat',mode:setupOnly?'setup':'harvest',plots:farm.positions.length,quantity:setupOnly?1:harvestCount,baseline:0},dependencies:[],reservationKeys:[]};
  let result;try{result=await executor.execute(task,s);}catch(error){console.log('Actual warehouse tool failure',JSON.stringify({inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),window:bot.currentWindow?.type,checkpoint:s.checkpoint}));throw error;}
  if(setupOnly){assert.equal(result.outcome,'completed');for(const p of farm.positions){assert.equal(bot.blockAt(new Vec3(p.x,p.y,p.z))?.name,'farmland');assert.equal(bot.blockAt(new Vec3(p.x,p.y+1,p.z))?.name,'wheat');}console.log('Actual expanded farm setup',JSON.stringify({plots:farm.positions.length,planted:farm.positions.length,actualTillingAndPlanting:true,sourceTerrainCopied:true,fixtureSeedsGiven:true,fixtureHoeGiven:true,productionWorld:false}));return;}
  console.log('Copied bank harvest result',JSON.stringify({outcome:result.outcome,reason:result.reason,position:bot.entity.position,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),checkpoint:result.checkpoint}));assert.equal(result.outcome,'completed');assert.equal(executor.count('wheat'),harvestCount);for(const p of farm.positions)assert.equal(bot.blockAt(new Vec3(p.x,p.y+1,p.z))?.name,'wheat');
  if(warehouseTool||carriedTool){if(!carriedTool)assert.equal((result.checkpoint.farmToolWarehouseSupply as any)?.item,'oak_log');assert.equal(executor.count('wooden_hoe'),1);assert.deepEqual((result.checkpoint.craftPreparations as any).wooden_hoe.table,base.blocks.find((b:any)=>b.name==='crafting_table').position);}
  assert.equal(await restInWarehouse(s,()=>true,undefined,'enter'),true);await executor.ensureItem('bread',breadCount,s);assert.equal(executor.count('wheat'),harvestCount-breadCount*3);assert.equal(executor.count('bread'),breadCount);
  const transfer=(kind:'take'|'store'):TaskSpec=>({id:kind+'-bread',goalId:'fixture',kind,source:'user',params:{item:'bread',quantity:kind==='store'?breadCount:1},completion:{kind:'inventory',item:'bread',minimum:kind==='take'?1:0},dependencies:[],reservationKeys:[]});
  await executor.execute(transfer('store'),s);assert.equal(executor.count('bread'),0);await executor.execute(transfer('take'),s);assert.equal(executor.count('bread'),1);
  rcon('effect give LayaBankCopy hunger 10 255 true');const hunger=Date.now()+5000;while(bot.food>18&&Date.now()<hunger)await sleep(50);rcon('effect clear LayaBankCopy minecraft:hunger');await sleep(200);const foodBefore=bot.food;assert.ok(foodBefore<=18);assert.equal(await executor.eat(s),true);assert.equal(executor.count('bread'),0);assert.ok(bot.food>foodBefore);
  console.log('Copied bank full food chain',JSON.stringify({version,harvested:harvestCount,replanted:farm.positions.length,breadCrafted:breadCount,breadStored:breadCount,breadWithdrawn:1,breadActuallyEaten:1,foodBefore,foodAfter:bot.food,fixtureSeedsGiven:true,fixtureHoeGiven:!warehouseTool&&!carriedTool,fixtureWarehouseLogGiven:warehouseTool&&!carriedTool,fixtureCarriedLogGiven:carriedTool,toolActuallyCraftedAtBase:warehouseTool||carriedTool,maturityPrepared:true,hungerPrepared:true,productionWorld:false}));
 }finally{bot?.clearControlStates();bot?.quit('copied geometry validation finished');await sleep(200);rcon('forceload remove 12043 12000 12069 12058');rcon(`gamerule ${cycleRule} ${oldCycle}`);rcon(`gamerule ${ticksRule} ${oldTicks}`);rcon(`time set ${oldTime}`);}
});
