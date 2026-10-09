const assert=require('node:assert/strict'),{Vec3}=require('vec3'),{createHome,isHomeRequest}=require('../home'),{parseKnownGoals,interpret}=require('../missions')
const registry=require('minecraft-data')('1.21.1'),calls=[],messages=[];let buildings=[],position=new Vec3(50,65,50)
const bot={entity:{get position(){return position}},blockAt:p=>({name:p.y===66&&p.z===0&&buildings.some(b=>b.complete)?'oak_door':p.y<=65?'oak_planks':'air',boundingBox:p.y<=65?'block':'empty'})}
const structures={allStatus:()=>buildings,status:kind=>buildings.find(b=>b.kind===kind)},home=createHome(bot,{structures,check:()=>{},near:async(p,range)=>{calls.push({p,range});position=p.clone()},log:e=>messages.push(e.text)})
async function main(){
 for(const text of ['집으로 가','집으로 가줘','집으로 가 줘','기지로 돌아가','거점 복귀해줘','성으로 돌아가','!home']){assert(isHomeRequest(text),text);assert.equal((await interpret(text,registry))[0].type,'home',text)}
 for(const text of ['집 지어줘','넓은 집 만들어줘','성을 지어줘'])assert(!isHomeRequest(text),text)
 assert.deepEqual(parseKnownGoals('집으로 가고 철 무기 만들어줘',registry)?.map(g=>g.type),['home','item'],'return home before crafting a weapon in a compound request')
 assert.equal(parseKnownGoals('성으로 돌아가',registry)[0].design,'castle')
 await assert.rejects(home.go(0),e=>e.code==='HOME_UNKNOWN');assert.equal(calls.length,0,'no home must not trigger movement or construction')
 buildings=[{kind:'house',title:'넓은 나무집',origin:{x:0,y:65,z:0},built:0,unloaded:0,complete:false}];await assert.rejects(home.go(0),e=>e.code==='HOME_UNKNOWN')
 buildings[0].built=1;await home.go(0);assert.equal(calls.at(-1).p.z,-2);assert(messages.some(m=>m.includes('미완성')))
 buildings[0].complete=true;await home.go(0);assert.deepEqual(calls.at(-1).p,new Vec3(3,66,2));assert.equal(calls.at(-1).range,0)
 buildings.push({kind:'castle',title:'유럽풍 성',origin:{x:4,y:65,z:4},built:622,unloaded:0,complete:true});await home.go(0,{design:'castle'});assert.deepEqual(calls.at(-1).p,new Vec3(11,66,13))
 buildings=[{kind:'house',title:'넓은 나무집',origin:{x:0,y:65,z:0},built:0,unloaded:100,complete:false}];structures.status=()=>({...buildings[0],unloaded:0,built:160,complete:true});await home.go(0);assert.equal(calls.at(-2).p.z,-2);assert.equal(calls.at(-1).p.z,2,'load recorded house chunks before selecting interior')
 console.log('PASS home command parsing, no accidental construction, missing/unbuilt home handling, partial site return, completed house/castle interior, unloaded recorded site loading')
}
main().catch(e=>{console.error(e);process.exitCode=1})
