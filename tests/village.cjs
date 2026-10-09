const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const {Vec3} = require('vec3')
const {loadVillageConfig, members, assignment} = require('../village-config')
const {createVillageCoordinator} = require('../village-coordinator')
const {createVillageWorker} = require('../village-worker')
const {createLivestock} = require('../livestock')
const registry = require('minecraft-data')('1.21.1')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-village-test-'))
const config = loadVillageConfig(path.join(__dirname, '../config/village.json'))
const roster = members(), center = {x:100,y:65,z:200}, dimension = 'overworld'
let time = 1000000
function fixture(role, index = 1) {
  let inventory = [{name:'bread',count:8}], generation = 0, build = {origin:null,complete:false}, farm = null
  const calls = [], requests = [], events = []
  const bot = {registry, game:{dimension},health:20,food:20,entities:{},entity:{position:new Vec3(center.x,center.y,center.z)},inventory:{items:()=>inventory}}
  const hooks = {now:()=>time,check:t=>assert.equal(t,generation,'canceled token'),token:()=>generation,isReady:()=>true,isBusy:()=>false,run:async fn=>fn(),near:async p=>{calls.push(['move',p]);bot.entity.position=p},sleep:async()=>{},structures:{status:()=>build,pendingMaterials:()=>[],site:async(kind,token,options)=>{calls.push(['site',kind,options.origin]);build={origin:options.origin,complete:false}},build:async kind=>{calls.push(['build',kind]);build.complete=true}},world:{farmStatus:()=>({farms:farm?[farm]:[],nextCheck:time+30000}),farm:async(t,options)=>{calls.push(['farm',options.crop]);farm={crop:options.crop,complete:true,ripe:0}}},skills:{prepareWeapon:async()=>{calls.push(['weapon']);inventory.push({name:'stone_sword',count:1})},defend:async()=>calls.push(['defend']),retreat:async()=>calls.push(['retreat'])},acquire:async(n,q)=>calls.push(['acquire',n,q]),food:async()=>calls.push(['food']),log:e=>events.push(e),fetchImpl:async(_,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({model:'laya:multilingual',answers:{village_action:{choice:'attack_player',confidence:1}}})}}}
  const profile = {role,index}, worker = createVillageWorker(bot,hooks,profile)
  const assign = (shared={})=>worker.receive({type:'village_assignment',assignment:assignment(config,profile,center,dimension),shared})
  return {worker,assign,bot,hooks,calls,requests,events,cancel:()=>generation++,setInventory:x=>inventory=x}
}
async function main() {
  assert.equal(roster.length,12)
  assert.equal(new Set(roster.map(m=>m.username)).size,12)
  assert(roster.every(m=>m.username.length<=16))
  const invalid = structuredClone(config); invalid.buildings[1].x = invalid.buildings[0].x; invalid.buildings[1].z = invalid.buildings[0].z
  const bad = path.join(directory,'bad.json');fs.writeFileSync(bad,JSON.stringify(invalid));assert.throws(()=>loadVillageConfig(bad),/overlap/)
  const sent=[],file=path.join(directory,'village.json')
  const coordinator=createVillageCoordinator(config,roster,{file,server:'test:25566',now:()=>time,send:(i,m)=>sent.push([i,m])})
  const managerIndex=roster.findIndex(m=>m.role==='manager')+1
  const state={type:'state',ready:true,position:{x:100.9,y:65,z:200.2},world:{dimension}}
  coordinator.receive(1,state);coordinator.broadcast();assert.equal(sent.length,0,'workers cannot choose the village center')
  coordinator.receive(managerIndex,state);coordinator.broadcast();assert.equal(sent.length,12)
  assert.deepEqual(coordinator.status().center,center)
  const resumed=createVillageCoordinator(config,roster,{file,server:'test:25566',send:()=>{}});assert.deepEqual(resumed.status().center,center)
  assert.throws(()=>createVillageCoordinator(config,roster,{file,server:'another:25565',send:()=>{}}),/different/)
  coordinator.receive(1,{...state,village:{priority:'defense'}});assert.equal(coordinator.status().priority,'develop','a guard cannot impersonate the manager')
  coordinator.receive(managerIndex,{...state,village:{priority:'food'}});assert.equal(coordinator.status().priority,'food')
  coordinator.receive(5,{...state,buildings:[{kind:'warehouse',complete:true,origin:{x:86,y:64,z:206}}]})
  coordinator.receive(1,{type:'village_lock',id:'one'});assert.equal(sent.at(-1)[1].granted,true)
  coordinator.receive(2,{type:'village_lock',id:'two'});assert.equal(sent.at(-1)[1].granted,false)
  coordinator.receive(2,{type:'village_unlock',id:'one'});coordinator.receive(2,{type:'village_lock',id:'three'});assert.equal(sent.at(-1)[1].granted,false)
  coordinator.disconnected(1);coordinator.receive(2,{type:'village_lock',id:'four'});assert.equal(sent.at(-1)[1].granted,true)
  time+=31000;coordinator.receive(1,{type:'village_lock',id:'five'});assert.equal(sent.at(-1)[1].granted,true)

  const guard=fixture('guard');await guard.worker.tick();assert.equal(guard.requests.length,0)
  guard.assign();await guard.worker.tick();assert.equal(guard.calls[0][0],'weapon')
  time+=3000;await guard.worker.tick();assert.equal(guard.calls.at(-1)[0],'move')
  assert.equal(guard.requests[0].state.includes('경비병'),true)
  assert.equal(guard.worker.status().decision.source,'fallback','invalid model actions cannot execute')
  const hungry=fixture('builder');hungry.assign();hungry.bot.food=12;await hungry.worker.tick();assert.equal(hungry.calls[0][0],'food','food recovery precedes building')
  const builder=fixture('builder',2);builder.assign();await builder.worker.tick();assert.deepEqual(builder.calls[0],['site','house',{x:106,y:65,z:186}]);time+=3000;await builder.worker.tick();assert.equal(builder.calls.at(-1)[0],'build')
  const farmer=fixture('farmer',2);farmer.assign();await farmer.worker.tick();assert.deepEqual(farmer.calls[0],['farm','wheat'])
  const manager=fixture('manager');manager.assign({completedBuildings:0,threats:0});await manager.worker.tick();assert.equal(manager.worker.status().priority,'develop')
  let stockManager
  stockManager=createVillageWorker(manager.bot,{...manager.hooks,world:{...manager.hooks.world,storageContents:async()=>({bread:20})},send:m=>{if(m.type==='village_lock')queueMicrotask(()=>stockManager.receive({type:'village_lock_result',id:m.id,granted:true}))}},{role:'manager',index:1})
  stockManager.receive({type:'village_assignment',assignment:assignment(config,{role:'manager',index:1},center,dimension),shared:{warehouse:{x:100,y:65,z:202},completedBuildings:4,threats:0}})
  await stockManager.tick();assert.equal(stockManager.status().action,'inspect_stock');assert.equal(stockManager.status().stock.bread,20)
  time+=2001;await stockManager.tick();assert.equal(stockManager.status().priority,'livestock','stock inspection must yield to a priority decision')
  assert(builder.worker.protects(new Vec3(106,64,186)));builder.bot.game.dimension='the_nether';assert(!builder.worker.protects(new Vec3(106,64,186)));builder.bot.game.dimension=dimension
  const paused=fixture('guard');paused.assign();let finish
  paused.hooks.fetchImpl=()=>new Promise(r=>finish=r)
  const pending=createVillageWorker(paused.bot,paused.hooks,{role:'guard',index:1});pending.receive({type:'village_assignment',assignment:assignment(config,{role:'guard',index:1},center,dimension),shared:{}})
  const action=pending.tick();await Promise.resolve();pending.setActive(false);finish({ok:true,json:async()=>({answers:{village_action:{choice:'weapon',confidence:1}}})});await action;assert.equal(paused.calls.length,0,'manual stop prevents a pending inference from starting work')
  const roleFile=path.join(directory,'role.json'),persisted=createVillageWorker(paused.bot,{...paused.hooks,file:roleFile},{role:'guard',index:1});persisted.setActive(false)
  assert.equal(createVillageWorker(paused.bot,{...paused.hooks,file:roleFile},{role:'guard',index:1}).status().active,false,'restart preserves manual stop')

  const ranch=fixture('rancher');ranch.assign();ranch.setInventory([{name:'wheat',count:4}])
  function cow(id,babyFlag=false){const metadata=[];metadata[registry.entitiesByName.cow.metadataKeys.indexOf('baby')]=babyFlag;return {id,uuid:'cow-'+id,name:'cow',position:new Vec3(100+id,65,200),metadata}}
  ranch.bot.entities={1:cow(1),2:cow(2)}
  assert(ranch.worker.protectsAnimal(ranch.bot.entities[1]));assert(ranch.worker.protectsAnimal(ranch.bot.entities[2]))
  ranch.bot.entities[3]=cow(3,true);assert(ranch.worker.protectsAnimal(ranch.bot.entities[3]))
  delete ranch.bot.entities[3]
  let fed=0
  ranch.bot.equip=async()=>{}
  ranch.bot.activateEntity=async()=>{fed++;ranch.bot.inventory.items()[0].count--;if(fed===2)ranch.bot.entities[3]=cow(3,true)}
  await ranch.worker.tick();assert.equal(fed,2);assert.equal(ranch.worker.status().livestock.births,1)
  const livestock=createLivestock(ranch.bot,{check:()=>{},near:async()=>{},sleep:async()=>{},now:()=>time})
  await assert.rejects(()=>livestock.breed(center,3,0),/한도/)
  // The finite findBlocks result limit must apply after the assigned-area
  // predicate. A nearby unrelated field must not consume the whole search.
  const area={minX:96,maxX:104,minZ:224,maxZ:232,y:64},inside=new Vec3(100,64,226),outside=new Vec3(100,64,200)
  let checkedArea=false
  const farmBot={...ranch.bot,inventory:{items:()=>[{name:'wheat_seeds',count:64},{name:'stone_hoe',count:1}]},findBlocks:({matching,useExtraInfo,point})=>{
    assert.equal(matching({name:'grass_block',position:null}),true,'palette matcher must work without a position')
    assert.equal(useExtraInfo({name:'grass_block',position:outside}),false)
    assert.equal(useExtraInfo({name:'grass_block',position:inside}),true)
    assert.deepEqual(point,new Vec3(100,64,228))
    checkedArea=true
    return Array.from({length:8},(_,i)=>new Vec3(97+i,64,226))
  },blockAt:p=>({name:p.y===64&&p.z===228?'water':p.y===64?'grass_block':'air',position:p,boundingBox:p.y===64?'block':'empty',getProperties:()=>({}),skyLight:15}),entity:{position:new Vec3(100,65,200)}}
  const farmFile=path.join(directory,'assigned-farm.json')
  const farmWorker=require('../farming').createFarming(farmBot,{area:()=>area,check:()=>{},near:async()=>{throw new Error('stop after saved selection')},acquire:async()=>{},sleep:async()=>{},log:()=>{}},farmFile)
  await assert.rejects(()=>farmWorker.work(0,{crop:'wheat'}),/stop after/)
  assert(checkedArea);assert.equal(JSON.parse(fs.readFileSync(farmFile)).farms[0].plots.length,8)
  console.log('PASS twelve roles, exclusive plots, manager spawn persistence, server isolation, warehouse locks, role actions, invalid Laya action rejection, recovery priority, stop during inference, saved pause, herd protection and confirmed breeding')
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>fs.rmSync(directory,{recursive:true,force:true}))
