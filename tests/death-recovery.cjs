const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Vec3}=require('vec3')
const {createDeathRecovery}=require('../death-recovery'),{createWorldSkills}=require('../world-skills')
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-death-unit-'));let serial=0
function setup(extra={}){
 let now=1000000,generation=0,ready=true,current={kind:'mission',request:'밀 16개 수확해줘',index:2},recoveries=0,resumes=0,retreats=0
 const bot={health:20,food:20,entity:{position:new Vec3(0,65,0)},game:{dimension:'overworld'},entities:{},time:{timeOfDay:1000}},events=[]
 const hooks={check:t=>assert.equal(t,generation,'cancelled'),token:()=>generation,isReady:()=>ready,isBusy:()=>false,stopWork:()=>generation++,run:fn=>fn(),goal:()=>current,log:e=>events.push(e),now:()=>now,recover:async()=>{recoveries++;return {recovered:6}},resume:async()=>{resumes++},retreat:async e=>{retreats++;delete bot.entities[e.id]},...extra}
 const manager=createDeathRecovery(bot,hooks,path.join(dir,`${serial++}.json`))
 const die=(opts={})=>manager.died({position:new Vec3(8,65,0),dimension:'overworld',inventory:[{name:'apple',count:6}],resume:current,...opts})
 return {bot,manager,die,hooks,events,advance:t=>now+=t,setGoal:g=>current=g,setReady:r=>ready=r,counts:()=>({recoveries,resumes,retreats}),cancel:()=>{generation++;manager.cancel()}}
}
async function settle(x){x.manager.spawned();x.advance(1600);await x.manager.tick();x.advance(600);await x.manager.tick()}
async function main(){
 const x=setup();x.die();await x.manager.tick();assert.equal(x.counts().recoveries,0,'dead bot must wait for actual spawn');await settle(x);assert.deepEqual(x.counts(),{recoveries:1,resumes:1,retreats:0});assert.equal(x.manager.status().resume.index,2,'resume the same stage');assert(!x.manager.isActive())
 const idle=setup();idle.die({resume:null});await settle(idle);assert.equal(idle.counts().recoveries,1);assert.equal(idle.counts().resumes,0,'idle death must not invent a goal')
 const empty=setup();empty.die({inventory:[]});await settle(empty);assert.equal(empty.counts().recoveries,0);assert.equal(empty.counts().resumes,1)
 for(const opts of [{dimension:'the_nether'},{position:new Vec3(120,65,0)}]){const y=setup();y.die(opts);await settle(y);assert.equal(y.counts().recoveries,0);assert.equal(y.counts().resumes,1)}
 const expired=setup();expired.die();expired.advance(270000);await settle(expired);assert.equal(expired.counts().recoveries,0)
 const changed=setup();changed.die();changed.setGoal({kind:'mission',request:'작은 집 지어줘',index:0});await settle(changed);assert.equal(changed.counts().resumes,0,'a new goal must not be replaced by the old goal')
 const canceled=setup();canceled.die();canceled.cancel();await settle(canceled);assert.deepEqual(canceled.counts(),{recoveries:0,resumes:0,retreats:0})
 const repeated=setup();for(let i=0;i<3;i++){repeated.die();repeated.advance(1000)}await settle(repeated);assert.equal(repeated.counts().resumes,0,'rapid deaths must wait for cooldown');assert(repeated.manager.status().resumeRequested,'preserve intent through repeated deaths');repeated.advance(31000);await repeated.manager.tick();repeated.advance(600);await repeated.manager.tick();assert.equal(repeated.counts().resumes,1,'resume the same goal after safe cooldown');assert.equal(repeated.counts().recoveries,0,'skip repeatedly dangerous corpse')
 const dangerous=setup();dangerous.die({position:new Vec3(16,65,0)});dangerous.bot.entities[1]={id:1,name:'zombie',type:'mob',position:new Vec3(16,65,0)};await settle(dangerous);assert.equal(dangerous.counts().recoveries,0,'do not return to a known hostile at the corpse')
 const near=setup();near.die();near.bot.entities[1]={id:1,name:'creeper',type:'mob',position:new Vec3(3,65,0)};near.manager.spawned();near.advance(1600);await near.manager.tick();assert.equal(near.counts().retreats,1);assert.equal(near.counts().recoveries,0,'retreat before recovery');near.advance(1600);await near.manager.tick();near.advance(600);await near.manager.tick();assert.equal(near.counts().resumes,1)
 const failures=setup({recover:async()=>{throw new Error('path unavailable')}});failures.die();failures.manager.spawned();failures.advance(1600);await failures.manager.tick();failures.advance(2100);await failures.manager.tick();failures.advance(600);await failures.manager.tick();assert.equal(failures.manager.status().attempts,2);assert.equal(failures.counts().resumes,1,'bounded failure must still replan the saved objective')
 let interrupt;const inflight=setup({recover:()=>new Promise(resolve=>interrupt=resolve)});inflight.die();inflight.manager.spawned();inflight.advance(1600);const pending=inflight.manager.tick();inflight.cancel();interrupt({recovered:6});await pending;assert.equal(inflight.counts().resumes,0,'stop during recovery must cancel resumption')
 await pickupRace()
 console.log('PASS death recovery: wait for spawn, actual pickup before entity scan, preserve goal stage, idle/manual stop, changed goal, corpse safety, cross-dimension/distance/age limits, repeated deaths, bounded retry and in-flight cancellation')
}
async function pickupRace(){
 let count=0;const bot={game:{dimension:'overworld'},inventory:{items:()=>count?[{name:'apple',count}]:[]},entities:{}}
 const world=createWorldSkills(bot,{check:()=>{},near:async()=>{count=4},sleep:async()=>{},log:()=>{}},path.join(dir,'farms.json'))
 const result=await world.recover({position:{x:0,y:65,z:0},dimension:'overworld'},0)
 assert.equal(result.recovered,4,'drops picked up while approaching must count as successful recovery')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(dir,{recursive:true,force:true}))
