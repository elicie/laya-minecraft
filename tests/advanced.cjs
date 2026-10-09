const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{Vec3}=require('vec3')
const {createCombat}=require('../combat'),{createSurvivalSkills}=require('../survival-skills'),{blueprint,furnishingPlan,requirements,matches}=require('../structures'),{validateGoals,parseKnownGoals}=require('../missions'),{createCollector}=require('../resource-collector')
const data=require('minecraft-data')('1.21.1')
assert.equal(validateGoals({goals:parseKnownGoals('당근 농장 계속 관리해줘',data)},data)[0].crop,'carrot')
assert.equal(validateGoals({goals:parseKnownGoals('당근 농장 계속 관리해줘',data)},data)[0].mode,'continuous')
assert.equal(validateGoals({goals:parseKnownGoals('밀 16개 수확해줘',data)},data)[0].quantity,16)
assert.equal(validateGoals({goals:parseKnownGoals('주변 경비해줘',data)},data)[0].mode,'continuous')
assert.equal(validateGoals({goals:parseKnownGoals('나무 32개 채집해줘',data)},data)[0].resource,'logs')
assert.deepEqual(validateGoals({goals:parseKnownGoals('철광석 찾아줘',data)},data)[0].resources,['iron_ore','deepslate_iron_ore'])
assert.throws(()=>validateGoals({goals:[{type:'fight',target:'player'}]},data))
assert.throws(()=>validateGoals({goals:[{type:'farm',crop:'invented'}]},data))
assert.throws(()=>validateGoals({goals:[{type:'explore',mode:'teleport'}]},data))
for(const kind of ['cabin','house','warehouse','tower','bridge']){
 const cells=blueprint(kind),furniture=furnishingPlan(kind,{x:0,y:0,z:0});assert.equal(new Set(cells.map(p=>`${p.x},${p.y},${p.z}`)).size,cells.length)
 assert.equal(new Set(furniture.map(f=>f.p.toString())).size,furniture.length)
 assert(!furniture.some(f=>cells.some(c=>f.p.equals(new Vec3(c.x,c.y,c.z)))),'furniture must not overlap walls/roof')
 if(kind!=='bridge'){assert.equal(cells.filter(c=>c.material==='door').length,2);assert(cells.filter(c=>c.material==='glass_pane').length>=3)}
}
assert(blueprint('house').some(c=>c.phase==='경사 지붕'&&c.y>5))
assert.equal(requirements('cabin').oak_door,1)
assert.equal(requirements('cabin').white_bed,1)
assert.equal(requirements('cabin').torch,2)
for(const kind of ['cabin','house']){
 const {designs,createStructures}=require('../structures'),d=designs[kind],cells=blueprint(kind),mid=Math.floor(d.width/2)
 assert(!cells.some(c=>c.x===mid&&c.z===mid&&c.y===d.height),'roof must leave a hollow attic')
 assert(cells.some(c=>c.z===-1&&c.phase==='현관'),'an accessible porch must be planned')
 assert.equal(cells.filter(c=>c.material==='log').length,12,'vertical corner posts')
 assert.equal(cells.filter(c=>c.material==='glass_pane').length,6,'wider side/rear windows')
 assert(blueprint(kind,undefined,2).some(c=>c.x===mid&&c.z===mid&&c.y===d.height),'keep the old roof when resuming an existing building')
}
assert.equal(matches({name:'oak_door',getProperties:()=>({half:'upper'})},'door','lower'),false)
async function main(){const bot=new EventEmitter();bot.entity={position:new Vec3(0,64,0)};bot.time={timeOfDay:1000};bot.entities={1:{id:1,name:'enderman',position:new Vec3(1,64,0),type:'mob'}};bot.inventory={slots:[],items:()=>[]};bot.deactivateItem=()=>{};bot.clearControlStates=()=>{};const combat=createCombat(bot,{check:()=>{},near:async()=>{},sleep:async()=>{},equip:async()=>{},eat:async()=>{}});const guard=await combat.defend(0);assert(guard.waiting);assert.equal(combat.status().kills,0)
bot.inventory.slots[5]={name:'diamond_helmet',maxDurability:363,durabilityUsed:0};bot.inventory.items=()=>[{name:'iron_helmet',maxDurability:165,durabilityUsed:0}];let equipCount=0;bot.equip=async()=>{equipCount++};const skills=createSurvivalSkills(bot,{check:()=>{},near:async()=>{},sleep:async()=>{}});await skills.equip(0);assert.equal(equipCount,0,'equipping must preserve better worn armor')
await assert.rejects(()=>combat.fight({name:'player',username:'human',type:'player'},0),/플레이어/)
let attempted=false;const collector=createCollector(bot,{check:()=>{throw new Error('cancelled')},near:async()=>{attempted=true},sleep:async()=>{},log:()=>{}});await assert.rejects(()=>collector.collect(['oak_log'],['oak_log'],5,0),/cancelled/);assert.equal(attempted,false)
await missionProgress()
console.log('PASS Korean goal modes, valid resources/crops, neutral mob exclusion, no player attack, armor preservation, build geometry/furniture/doors, cancellation, growth waiting, harvest targets, evidence-only resource search')}
async function missionProgress(){
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createMissions}=require('../missions')
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-mission-progress-')),realNow=Date.now
 let now=realNow(),harvested=0,works=0,found=false
 Date.now=()=>now
 const bot={registry:data,inventory:{items:()=>[],slots:[]},entity:{position:new Vec3(0,64,0)},game:{dimension:'overworld'},food:20,health:20}
 const hooks={check:()=>{},token:()=>0,isBusy:()=>false,run:fn=>fn(),skills:{},world:{farmStatus:()=>({farms:[{crop:'wheat',harvested}]}),farm:async()=>{works++;harvested=works===1?5:20;return {title:'밀',planted:24,plots:24,ripe:0,harvested,complete:true,waiting:true,nextCheck:now+30000}}},structures:{},campaign:{snapshot:()=>({stages:[]})},explore:async()=>({resourceLocations:found?[{name:'iron_ore',x:1,y:2,z:3}]:[]}),log:()=>{}}
 try{
  const farm=createMissions(bot,hooks,path.join(temp,'farm.json'));await farm.start('밀 16개 수확해줘');await farm.tick();assert(farm.view().enabled);assert.equal(farm.view().index,0);await farm.tick();assert.equal(works,1,'growth wait must not repeatedly run work');now+=31000;await farm.tick();assert.equal(farm.view().phase,'목표 완료');assert.equal(farm.view().index,1)
  const continuous=createMissions(bot,hooks,path.join(temp,'continuous.json'));await continuous.start('밀 농장 계속 관리해줘');await continuous.tick();assert(continuous.view().enabled,'a planted continuous farm must keep its goal');assert.equal(continuous.view().index,0)
  const search=createMissions(bot,hooks,path.join(temp,'search.json'));await search.start('철광석 찾아줘');await search.tick();assert(search.view().enabled,'walking without finding iron must not complete the search');found=true;now+=2100;await search.tick();assert.equal(search.view().phase,'목표 완료')
 }finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exit(1)})
