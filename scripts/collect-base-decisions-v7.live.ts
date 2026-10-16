/** Controlled observed decision states. Admin fixtures are confined to disposable25566.
 * These records never pretend to be natural production or completed actions. */
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {Vec3} from 'vec3';
import {createCompatibleBot} from '../packages/minecraft/src/compatibility';
import {BASE_DECISION_QUESTION,renderQwenBaseState,type ChoiceCandidate} from '../packages/models/src';
if(process.env.MC_HOST!=='127.0.0.1'||process.env.MC_PORT!=='25566')throw Error('Disposable minecraft-laya-validation:25566 only');
if(execFileSync('docker',['inspect','-f','{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}','minecraft-laya-validation'],{encoding:'utf8'}).trim()!=='25566')throw Error('Wrong disposable server mapping');
const output=resolve(process.argv[2]??'');if(!process.argv[2]||existsSync(output))throw Error('Fresh output path required');
const rcon=(s:string)=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',s],{encoding:'utf8'}),sleep=(n:number)=>new Promise(r=>setTimeout(r,n)),sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
async function main(){
const username='LayaBaseV7Data',bot=await createCompatibleBot({host:'127.0.0.1',port:25566,version:'1.21.1',username,auth:'offline'});const rows:any[]=[];
const oldTime=Number(rcon('time query daytime').match(/\d+/g)?.at(-1)??0),oldCycle=rcon('gamerule doDaylightCycle').includes('true');
const rationale:Record<string,string>={seed_supply:'Requested seed reserve is missing; visible grass and safe daylight support a small seed collection before lower-priority wood work.',wood_supply:'Seed reserve is present but the requested tool-wood reserve is missing; a natural oak log is directly observed in safe daylight.',farm_setup:'The controlled irrigated soil is unplanted and actual inventory contains seeds and a hoe, so the requested farm can be established.',farm_harvest:'All observed wheat is age7 and actual seeds and hoe allow replanting after the requested harvest.',bake_food:'At least three actual wheat and the observed existing crafting table allow the requested bread batch.',base_return:'The requested resource trip is ready to return; stock is actually held and the base is observed farther away in safe daylight.',warehouse_store:'Actual held seed supplies should be deposited into the adjacent observed warehouse for the requested delivery.',warehouse_take:'The next requested farm has a hoe but no held seeds; actual chest seed stock can be withdrawn first.',tool_craft:'A missing hoe can be crafted from the actual planks and sticks at the existing observed worktable.',explore:'The requested resource is absent from the surveyed local fixture; a safe daylight exploration is the only permitted next workflow.',shelter:'It is actually night and the player is inside the closed verified shelter scene; remain sheltered until daylight.',wait:'The observed crops are immature, stock is sufficient, and the only permitted workflow is waiting for actual growth.'};
try{
 await once(bot,'spawn');rcon('gamerule doDaylightCycle false');
 for(let round=0;round<6;round++){
  const x=20000+round*64,z=20000,y=80;const plots=[{x:x+3,y:y-1,z:z+3},{x:x+3,y:y-1,z:z+4},{x:x+4,y:y-1,z:z+4}],base={x:x+12,y,z:z+12},chest={x:x+10,y,z:z+10};
  rcon(`forceload add ${x} ${z} ${x+31} ${z+31}`);rcon(`fill ${x} ${y} ${z} ${x+31} ${y+8} ${z+31} air`);rcon(`fill ${x} ${y-2} ${z} ${x+31} ${y-1} ${z+31} grass_block`);rcon(`setblock ${x+2} ${y-1} ${z+3} water`);rcon(`setblock ${x+11} ${y} ${z+10} crafting_table`);rcon(`setblock ${x+7} ${y} ${z+7} oak_log`);rcon(`setblock ${x+6} ${y} ${z+6} short_grass`);rcon(`kill @e[type=!player,x=${x},y=${y-2},z=${z},dx=31,dy=12,dz=31]`);
  for(const action of Object.keys(BASE_DECISION_QUESTION.criteria)){
   rcon(`tp ${username} ${chest.x+1.5} ${y} ${chest.z+1.5}`);await sleep(150);
   const seedCount=17+round,woodCount=9+round;const items:Record<string,number>={};let ware:Record<string,number>={wheat_seeds:seedCount,oak_log:woodCount};let cropAge=0,planted=true;
   if(action==='seed_supply')ware={oak_log:woodCount};
   if(action==='wood_supply')ware={wheat_seeds:seedCount};
   if(['seed_supply','wood_supply'].includes(action)&&round%3>0)items[action==='seed_supply'?'wheat_seeds':'oak_log']=5+round;
   if(action==='farm_setup'){items.wheat_seeds=seedCount;items.wooden_hoe=1;planted=false;}
   if(action==='farm_harvest'){items.wheat_seeds=seedCount;items.wooden_hoe=1;cropAge=7;}
   if(action==='bake_food')items.wheat=7+round;
   if(action==='base_return'||action==='warehouse_store')items.wheat_seeds=2+round;
   if(action==='warehouse_take')items.wooden_hoe=1;
   if(action==='tool_craft'){items.oak_planks=3+round;items.stick=2+round;}
   rcon(`clear ${username}`);for(const [name,count]of Object.entries(items))rcon(`give ${username} ${name} ${count}`);
   rcon(`setblock ${chest.x} ${chest.y} ${chest.z} air`);rcon(`setblock ${chest.x} ${chest.y} ${chest.z} chest`);
   let slot=0;for(const [name,count]of Object.entries(ware))rcon(`item replace block ${chest.x} ${chest.y} ${chest.z} container.${slot++} with ${name} ${count}`);
   for(const p of plots){rcon(`setblock ${p.x} ${p.y} ${p.z} farmland[moisture=7]`);rcon(`setblock ${p.x} ${p.y+1} ${p.z} ${planted?`wheat[age=${cropAge}]`:'air'}`);}
   // Closed small shelter is prepared only in this disposable scene.
   rcon(`fill ${x+18} ${y-1} ${z+18} ${x+22} ${y+3} ${z+22} cobblestone`);rcon(`fill ${x+19} ${y} ${z+19} ${x+21} ${y+2} ${z+21} air`);rcon(`setblock ${x+20} ${y} ${z+18} oak_door[facing=north,half=lower,open=false]`);rcon(`setblock ${x+20} ${y+1} ${z+18} oak_door[facing=north,half=upper,open=false]`);
   const at=action==='shelter'?new Vec3(x+20.5,y,z+20.5):(action==='base_return'||['seed_supply','wood_supply'].includes(action)&&round%3===2)?new Vec3(x+2.5,y,z+20.5):new Vec3(chest.x+1.5,y,chest.z+1.5);
   rcon(`tp ${username} ${chest.x+1.5} ${y} ${chest.z+1.5}`);await sleep(350);
   const chestBlock=bot.blockAt(new Vec3(chest.x,chest.y,chest.z));if(chestBlock?.name!=='chest')throw Error('Unobserved chest');
   const window=await bot.openContainer(chestBlock);const warehouseItems=window.containerItems().map(i=>({name:i.name,count:i.count}));window.close();
   rcon(`tp ${username} ${at.x} ${at.y} ${at.z}`);rcon(`time set ${action==='shelter'?14700+round*70:1800+round*370}`);
   const until=Date.now()+5000;while((bot.entity.position.distanceTo(at)>.2||Math.abs(bot.time.timeOfDay-(action==='shelter'?14700+round*70:1800+round*370))>80||Object.keys(items).some(n=>bot.inventory.items().filter(i=>i.name===n).reduce((v,i)=>v+i.count,0)!==items[n]))&&Date.now()<until)await sleep(50);await sleep(350);
   if(bot.entity.position.distanceTo(at)>.3)throw Error('Fixture position not observed');
   const cropFacts=plots.map(p=>{const b=bot.blockAt(new Vec3(p.x,p.y+1,p.z));if(!b)throw Error('Unloaded crop');return{position:p,name:b.name,age:b.name==='wheat'?Number(b.getProperties().age):null};});
   const observedAt=Date.now(),candidates:ChoiceCandidate[]=[{id:randomUUID(),action,description:action}];
   if(!['wait','shelter','explore','base_return'].includes(action))candidates.push({id:randomUUID(),action:'explore',description:'Permitted general daylight exploration, lower priority than requested food prerequisite'});
   const taskKind:Record<string,string>={seed_supply:'collect',wood_supply:'collect',farm_setup:'farm',farm_harvest:'farm',bake_food:'craft',base_return:'home',warehouse_store:'store',warehouse_take:'take',tool_craft:'craft',explore:'explore',shelter:'sleep',wait:'farm'};
   const taskItem:Record<string,string>={seed_supply:'wheat_seeds',wood_supply:'oak_log',farm_setup:'wheat',farm_harvest:'wheat',bake_food:'bread',base_return:'wheat_seeds',warehouse_store:'wheat_seeds',warehouse_take:'wheat_seeds',tool_craft:'wooden_hoe',explore:'diamond',shelter:'',wait:'wheat'};
   const observation={observedAt,world:'127.0.0.1:25566',dimension:'overworld',health:bot.health,food:bot.food,timeOfDay:bot.time.timeOfDay,worldAge:bot.time.age,role:'farmer',position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},base:{outside:base},nearbyThreatsClear:true,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),warehouse:{items:warehouseItems,observedAt},targets:{seeds:seedCount,wood:woodCount,bread:16+round},farm:{plots:3,planted:cropFacts.filter(p=>p.name==='wheat').length,watered:3,ripe:cropFacts.filter(p=>p.age===7).length,harvested:0,observedAt},candidates:candidates.map((c,i)=>({id:c.id,action:c.action,kind:taskKind[c.action!],priority:20,item:taskItem[c.action!],mode:action==='farm_harvest'?'harvest':action==='farm_setup'?'setup':undefined,targetQuantity:action==='seed_supply'?seedCount:action==='wood_supply'?woodCount:1}))};
   if(['seed_supply','wood_supply'].includes(action)&&round%3>0)observation.candidates[0]!.kind=round%3===1?'store':'home';
   const state=renderQwenBaseState({state:JSON.stringify(observation),candidates});
   rows.push({id:randomUUID(),task:'base_action',state,state_sha256:sha(state),episode_id:`controlled-v7-round-${round}-${action}`,source:'validation',world:observation.world,recorded_at:observedAt,world_age:bot.time.age,run_day:null,proposal:action,expected:null,allowed:[],reviewed:false,reviewer:null,rationale:null,question_sha256:sha(readFileSync(resolve('packages/contracts/src/base-decisions.json'))),evidence:{observation,cropFacts,chestPosition:chest,actualChestItems:warehouseItems,actualWorktable:bot.blockAt(new Vec3(x+11,y,z+10))?.name,actualFixtureWood:bot.blockAt(new Vec3(x+7,y,z+7))?.name,actualGrass:bot.blockAt(new Vec3(x+6,y,z+6))?.name,actualShelterDoor:action==='shelter'?bot.blockAt(new Vec3(x+20,y,z+18))?.getProperties():undefined,fixturePrepared:true,fixtureGivenItems:items,fixtureMaturityPrepared:cropAge===7,actionExecuted:false,sceneRequest:action,reviewGuidance:rationale[action],split:round<3?'train':round===3?'calibration':'eval'}});
   console.log(JSON.stringify({round,action,health:bot.health,food:bot.food,cropFacts,records:rows.length}));
  }
  rcon(`forceload remove ${x} ${z} ${x+31} ${z+31}`);
 }
 mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');console.log(JSON.stringify({output,records:rows.length,reviewed:false,trained:false}));
}finally{bot.quit('controlled observations complete');rcon(`gamerule doDaylightCycle ${oldCycle}`);rcon(`time set ${oldTime}`);}

}
main().catch(error=>{console.error(error);process.exitCode=1;});
