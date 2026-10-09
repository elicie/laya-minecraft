const {Vec3}=require('vec3')
function pickupStand(bot,position){
 const p=new Vec3(position.x,position.y,position.z).floored(),candidates=[]
 for(const [x,z]of [[0,0],[1,0],[-1,0],[0,1],[0,-1]])for(const y of [0,1,-1]){const q=p.offset(x,y,z);if(bot.blockAt(q)?.boundingBox==='empty'&&bot.blockAt(q.offset(0,1,0))?.boundingBox==='empty'&&bot.blockAt(q.offset(0,-1,0))?.boundingBox==='block')candidates.push(q)}
 return candidates.sort((a,b)=>a.offset(.5,0,.5).distanceTo(position)-b.offset(.5,0,.5).distanceTo(position))[0]||p
}
module.exports={pickupStand}
