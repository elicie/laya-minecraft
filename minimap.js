const {Vec3}=require('vec3'),{HOSTILES}=require('./combat')
const palette=['#1a252a','#719955','#367faa','#98958b','#9b865b','#426548','#e0dcb8','#dadfe0','#cf652f','#776069','#b89061']
function tile(name){if(['water','bubble_column'].includes(name))return 2;if(name.includes('lava'))return 8;if(name.endsWith('_leaves'))return 5;if(name.includes('snow')||name==='ice')return 7;if(name==='sand'||name==='sandstone')return 6;if(name.includes('planks')||name.endsWith('_log'))return 10;if(name==='dirt'||name.includes('path')||name==='farmland')return 4;if(name.includes('grass')||name.includes('moss'))return 1;if(name.includes('netherrack')||name.includes('crimson'))return 9;return 3}
function createMinimap(bot,{now=Date.now}={}){
 let cached=null,key='',until=0
 function snapshot(){
  if(!bot.entity)return null
  const center=bot.entity.position.floored(),dimension=bot.game.dimension,nextKey=`${dimension}:${Math.floor(center.x/4)}:${Math.floor(center.y/4)}:${Math.floor(center.z/4)}`
  if(cached&&key===nextKey&&now()<until)return cached
  const radius=32,step=2,size=33,cells=[],heights=[],top=Math.min(319,center.y+12),bottom=Math.max(-64,center.y-24)
  for(let iz=0;iz<size;iz++)for(let ix=0;ix<size;ix++){
   const x=center.x-radius+ix*step,z=center.z-radius+iz*step;let code=0,height=null
   for(let y=top;y>=bottom;y--){const b=bot.blockAt(new Vec3(x,y,z));if(!b)break;if(b.boundingBox==='block'||['water','lava','bubble_column'].includes(b.name)||b.name.endsWith('_leaves')){code=tile(b.name);height=y;break}}
   cells.push(code);heights.push(height)
  }
  key=nextKey;until=now()+2500;cached={center:{x:center.x,y:center.y,z:center.z},radius,step,size,palette,cells,heights,dimension,observedAt:now()};return cached
 }
 function markers(){return Object.values(bot.entities||{}).filter(e=>e.position&&(e.type==='player'||e.username||HOSTILES.has(e.name)||['cow','pig','sheep','chicken','rabbit'].includes(e.name))).map(e=>({x:e.position.x,z:e.position.z,name:e.username||e.name,type:e.type==='player'||e.username?'player':HOSTILES.has(e.name)?'hostile':'animal'})).filter(e=>e.name!==bot.username)}
 return {snapshot,markers}
}
module.exports={createMinimap,palette,tile}
