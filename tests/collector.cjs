const assert=require('node:assert/strict'),{Vec3}=require('vec3'),{createCollector}=require('../resource-collector')
const {pickupStand}=require('../pickup-navigation')
const collisionBot={blockAt:p=>({boundingBox:p.y<=66?'block':'empty'})}
assert.deepEqual(pickupStand(collisionBot,new Vec3(2.5,66.8,3.5)),new Vec3(2,67,3),'a drop on furniture must target walkable feet above it rather than the solid furniture cell')
async function grass(){
 let seeds=0,dug=0,available=true;const p=new Vec3(0,65,1)
 const block={name:'short_grass',position:p,canHarvest:()=>true},bot={entity:{position:new Vec3(0,65,0)},game:{dimension:'overworld'},entities:{},inventory:{slots:[],inventoryStart:9,inventoryEnd:45,items:()=>seeds?[{name:'wheat_seeds',count:seeds}]:[]},findBlocks:()=>available?[p]:[],blockAt:()=>block,pathfinder:{setGoal:()=>{},goto:async()=>{}},unequip:async()=>{},dig:async()=>{dug++;if(dug===7){bot.entities[1]={name:'item',position:p,getDroppedItem:()=>({name:'wheat_seeds'})};available=false}}}
 const collector=createCollector(bot,{check:()=>{},sleep:async()=>{},log:()=>{},near:async(q,range)=>{assert.equal(range,0,'walk into the actual pickup radius');seeds++;delete bot.entities[1]}})
 const result=await collector.collect(['short_grass'],['wheat_seeds'],1,0)
 assert.equal(dug,7,'normal empty grass drops must not stop after five attempts');assert.equal(result.collected,1)
}
async function missing(){
 let dug=0;const p=new Vec3(0,65,1),block={name:'stone',position:p,canHarvest:()=>true},bot={entity:{position:new Vec3(0,65,0)},game:{dimension:'overworld'},entities:{},inventory:{slots:[],inventoryStart:9,inventoryEnd:45,items:()=>[]},findBlocks:()=>[p],blockAt:()=>block,pathfinder:{setGoal:()=>{},goto:async()=>{}},unequip:async()=>{},dig:async()=>dug++}
 const collector=createCollector(bot,{check:()=>{},sleep:async()=>{},log:()=>{},near:async()=>{}})
 await assert.rejects(()=>collector.collect(['stone'],['cobblestone'],1,0),/다섯 번/);assert.equal(dug,5,'guaranteed drops still need bounded recovery failure')
}
async function stableFloor(){
 const under=new Vec3(0,64,0),deep=new Vec3(1,63,0),beside=new Vec3(1,65,0);let dug,amount=0
 const bot={entity:{position:new Vec3(.5,65,.5)},game:{dimension:'overworld'},entities:{},inventory:{slots:[],inventoryStart:9,inventoryEnd:45,items:()=>amount?[{name:'cobblestone',count:amount}]:[]},findBlocks:()=>[under,deep,beside],blockAt:p=>({name:'stone',position:p,canHarvest:()=>true}),pathfinder:{setGoal:()=>{},goto:async()=>{}},unequip:async()=>{},dig:async b=>{dug=b.position;amount++}}
 await createCollector(bot,{check:()=>{},sleep:async()=>{},log:()=>{},near:async()=>{}}).collect(['stone'],['cobblestone'],1,0)
 assert.deepEqual(dug,beside,'do not dig beneath the player or chase stone farther below the starting floor')
}
async function buildingProtection(){
 const foundation=new Vec3(1,65,0),natural=new Vec3(2,65,0);let dug,amount=0
 const bot={entity:{position:new Vec3(.5,65,.5)},game:{dimension:'overworld'},entities:{},inventory:{slots:[],inventoryStart:9,inventoryEnd:45,items:()=>amount?[{name:'cobblestone',count:amount}]:[]},findBlocks:()=>[foundation,natural],blockAt:p=>({name:'cobblestone',position:p,canHarvest:()=>true}),pathfinder:{setGoal:()=>{},goto:async()=>{}},unequip:async()=>{},dig:async b=>{dug=b.position;amount++}}
 await createCollector(bot,{check:()=>{},sleep:async()=>{},log:()=>{},near:async()=>{},protects:p=>p.equals(foundation)}).collect(['cobblestone'],['cobblestone'],1,0)
 assert.deepEqual(dug,natural,'direct collection must leave recorded building cells intact')
}
Promise.all([grass(),missing(),stableFloor(),buildingProtection()]).then(()=>console.log('PASS probabilistic seed drops, actual pickup proximity, bounded drop failure, stable mining floor and recorded building protection')).catch(e=>{console.error(e);process.exitCode=1})
