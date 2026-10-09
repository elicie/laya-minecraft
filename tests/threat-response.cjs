const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Vec3}=require('vec3')
const {createThreatResponse,observedEnemies}=require('../threat-response'),{createMissions}=require('../missions'),{createCampaign}=require('../campaign'),{createDeathRecovery}=require('../death-recovery')
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'laya-threat-unit-'))
function setup(extra={}){
 let now=100000,generation=0,busy=false,working=true,ready=true,inventory=[{name:'stone_sword',count:1}],checkpoint={request:'집 지어줘',index:3},fights=0,retreats=0,eaten=0,foods=0,resumes=0,interrupts=0
 const bot={health:20,food:20,entity:{position:new Vec3(0,65,0)},entities:{},time:{timeOfDay:14000},inventory:{items:()=>inventory}},events=[]
 const hooks={check:t=>{if(t!==generation||!ready)throw new Error('cancelled')},token:()=>generation,isReady:()=>ready,isBusy:()=>busy,hasWork:()=>working,suspend:()=>({...checkpoint}),interrupt:()=>{interrupts++;generation++},run:async fn=>{assert(!busy,'actions must never overlap');busy=true;try{return await fn()}finally{busy=false}},skills:{fightThreat:async e=>{fights++;delete bot.entities[e.id];return {killed:true}},retreat:async()=>{retreats++;bot.entity.position=new Vec3(-18,65,0)},eat:async()=>{eaten++;bot.food=20},combatStatus:()=>({active:false})},food:async()=>{foods++;bot.food=20},resume:saved=>{assert.equal(saved.index,3);assert.equal(saved.request,'집 지어줘');resumes++;return true},log:e=>events.push(e),now:()=>now,...extra}
 const manager=createThreatResponse(bot,hooks)
 return {bot,hooks,manager,events,advance:ms=>now+=ms,weapon:value=>inventory=value?[{name:'stone_sword',count:1}]:[],foodItem:()=>inventory.push({name:'bread',count:2}),busy:value=>busy=value,working:value=>working=value,ready:value=>ready=value,counts:()=>({fights,retreats,eaten,foods,resumes,interrupts}),cancel:()=>{generation++;working=false;manager.cancel()},enemy:(name='husk',x=3,id=1)=>bot.entities[id]={id,name,type:'mob',position:new Vec3(x,65,0)}}
}
async function safeResume(x){x.advance(1200);await x.manager.tick();x.advance(3000);await x.manager.tick();assert.equal(x.manager.isActive(),false);assert.equal(x.counts().resumes,1)}
async function main(){
 const busy=setup();busy.busy(true);busy.enemy();await busy.manager.tick();assert.equal(busy.counts().interrupts,1);assert.equal(busy.counts().fights,0,'cancel old work before taking controls');busy.busy(false);await busy.manager.tick();assert.equal(busy.counts().fights,1);busy.advance(300);await safeResume(busy)
 for(const scenario of ['unarmed','low-health','low-food','creeper','multiple','ranged']){
  const x=setup();x.enemy(scenario==='creeper'?'creeper':scenario==='ranged'?'skeleton':'husk',scenario==='ranged'?10:3)
  if(scenario==='unarmed')x.weapon(false);if(scenario==='low-health')x.bot.health=8;if(scenario==='low-food')x.bot.food=10;if(scenario==='multiple')x.enemy('zombie',4,2)
  await x.manager.tick();assert.equal(x.counts().fights,0,scenario);assert.equal(x.counts().retreats,1,scenario);assert(x.manager.isActive(),scenario)
 }
 const idle=setup();idle.working(false);idle.enemy();await idle.manager.tick();assert.equal(idle.counts().interrupts,0,'explicitly stopped bot must stay stopped')
 const nonhostile=setup();nonhostile.enemy('cow');nonhostile.enemy('wolf',2,2);const player=nonhostile.enemy('husk',2,3);player.type='player';const named=nonhostile.enemy('husk',2,4);named.username='someone';assert.equal(observedEnemies(nonhostile.bot).length,0);await nonhostile.manager.tick();assert.equal(nonhostile.counts().interrupts,0)
 nonhostile.manager.damage();await nonhostile.manager.tick();assert(nonhostile.manager.isActive(),'unattributed damage must trigger a safety check');assert.equal(nonhostile.counts().fights,0,'never attack players or neutral mobs');nonhostile.advance(3000);await safeResume(nonhostile)
 const blocked=setup();blocked.bot.world={raycast:()=>({boundingBox:'block'})};blocked.enemy('skeleton',10);await blocked.manager.tick();assert.equal(blocked.counts().interrupts,0,'wall must hide an unprovoked enemy')
 const ranged=setup();ranged.enemy('skeleton',19);await ranged.manager.tick();assert.equal(ranged.counts().interrupts,0);ranged.manager.damage();await ranged.manager.tick();assert.equal(ranged.counts().interrupts,1,'a ranged hit must interrupt long work even outside proactive radius')
 const healing=setup();healing.bot.health=5;healing.bot.food=12;healing.foodItem();await healing.manager.tick();assert.equal(healing.counts().eaten,1);healing.advance(600);await healing.manager.tick();assert(healing.manager.isActive());assert.equal(healing.counts().resumes,0,'low health must delay resumption');healing.bot.health=12;await safeResume(healing)
 const finding=setup();finding.bot.health=4;finding.bot.food=12;await finding.manager.tick();assert.equal(finding.counts().foods,1,'recover food instead of idling forever');assert.equal(finding.counts().resumes,0)
 let finishFight;const stopped=setup();stopped.hooks.skills.fightThreat=()=>new Promise(resolve=>finishFight=resolve);stopped.enemy();const pending=stopped.manager.tick();stopped.cancel();finishFight({killed:true});await pending;stopped.advance(4000);await stopped.manager.tick();assert(!stopped.manager.isActive());assert.equal(stopped.counts().resumes,0,'stop/death/new command must prevent a late resume')
 let finishFood;const eating=setup({food:()=>new Promise(resolve=>finishFood=resolve)});eating.bot.health=4;eating.bot.food=12;const foodPending=eating.manager.tick();eating.enemy('creeper');await eating.manager.tick();assert.equal(eating.counts().interrupts,2,'interrupt food gathering when a new threat arrives');finishFood();await foodPending;await eating.manager.tick();assert.equal(eating.counts().retreats,1)
 await realMissionCancellation();await respawnFood()
 console.log('PASS threat handling: cancel long work, exclusive controls, fight/retreat guards, damage/visibility, neutral/player exclusion, food/recovery, stop during response, interrupt recovery food, preserve real mission stage and failures')
}
async function realMissionCancellation(){
 let generation=0,busy=false,completeOld,acquisitions=0;const registry=require('minecraft-data')('1.21.1'),inventory=[{name:'stone_sword',count:1}],events=[]
 const bot={registry,inventory:{items:()=>inventory,slots:[]},entity:{position:new Vec3(0,65,0)},entities:{},game:{dimension:'overworld',difficulty:'normal'},food:20,health:20,time:{timeOfDay:1000}}
 const check=t=>{if(t!==generation)throw new Error('cancelled')},campaign=createCampaign(path.join(temp,'campaign.json'))
 const mission=createMissions(bot,{check,token:()=>generation,isBusy:()=>busy,run:async fn=>{busy=true;try{return await fn()}finally{busy=false}},acquire:async(name,count,token)=>{acquisitions++;if(acquisitions===1)await new Promise(r=>completeOld=r);check(token);inventory.push({name,count})},skills:{},world:{},structures:{},endgame:{},campaign,explore:async()=>{},log:e=>events.push(e)},path.join(temp,'mission.json'))
 await mission.start('iron_sword');const working=mission.tick();assert(busy)
 const x=setup({check,token:()=>generation,isBusy:()=>busy||mission.isRunning(),suspend:()=>mission.suspendForThreat(),interrupt:()=>generation++,resume:c=>mission.resumeAfterThreat(c)});x.bot.entities[1]={id:1,name:'husk',type:'mob',position:new Vec3(3,65,0)}
 await x.manager.tick();assert(x.manager.isActive());assert.equal(mission.view().index,0);completeOld();await working;assert.equal(mission.view().failures,0,'safety cancellation is not a failed goal');assert.equal(events.filter(e=>e.type==='plan_result').length,0,'interrupted stage must not report success or failure')
 await mission.tick();assert.equal(acquisitions,1,'safety hold blocks premature restart');await x.manager.tick();x.advance(300);await x.manager.tick();x.advance(3000);await x.manager.tick();assert(!x.manager.isActive());await mission.tick();assert.equal(mission.view().request,'iron_sword');assert.equal(mission.view().index,1);assert.equal(acquisitions,2)
 await mission.start('diamond');const checkpoint=mission.suspendForThreat();mission.stop();assert(!mission.resumeAfterThreat(checkpoint),'manual stop clears the hold');assert(!mission.view().autoRequested)
 await mission.start('diamond');const replaced=mission.suspendForThreat();await mission.start('bread');assert(!mission.resumeAfterThreat(replaced),'new goal must supersede the old checkpoint');assert.equal(mission.view().request,'bread');assert(mission.view().enabled)
}
async function respawnFood(){
 let now=100000,foods=0,resumes=0;const bot={health:4,food:12,entity:{position:new Vec3(0,65,0)},entities:{},game:{dimension:'overworld'},time:{timeOfDay:1000}},goal={kind:'mission',request:'집 지어줘',index:2}
 const recovery=createDeathRecovery(bot,{check:()=>{},token:()=>0,isReady:()=>true,isBusy:()=>false,stopWork:()=>{},run:fn=>fn(),recover:async()=>({recovered:0}),retreat:async()=>{},resume:async()=>resumes++,goal:()=>goal,food:async()=>{foods++;bot.food=20},now:()=>now},path.join(temp,'death.json'))
 recovery.died({position:bot.entity.position,dimension:'overworld',resume:goal});recovery.spawned();now+=2000;await recovery.tick();assert.equal(foods,1);assert.equal(resumes,0);bot.health=12;now+=2000;await recovery.tick();now+=600;await recovery.tick();assert.equal(resumes,1)
}
const deadline=setTimeout(()=>{console.error('threat test did not settle');process.exit(1)},5000)
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(deadline);fs.rmSync(temp,{recursive:true})})
