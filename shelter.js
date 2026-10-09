const {Vec3}=require('vec3'),fs=require('node:fs'),path=require('node:path')
const siteFile=path.join(process.env.BOT_LOG_DIR||path.join(__dirname,'logs'),'shelter-site.json')
function blueprint(origin){const cells=[];for(let y=0;y<=4;y++)for(let x=0;x<4;x++)for(let z=0;z<4;z++){
 const border=x===0||x===3||z===0||z===3,door=x===1&&z===0&&(y===1||y===2)
 if(y===0||y===4||(border&&!door))cells.push({x:origin.x+x,y:origin.y+y,z:origin.z+z})
}return cells}
function createShelter(bot,{check,near,planks,log}){
 let origin=null;try{const s=JSON.parse(fs.readFileSync(siteFile));if(s.server===`${process.env.MC_HOST||'127.0.0.1'}:${process.env.MC_PORT||25565}`)origin=s.origin}catch{}
 function status(){if(!origin)return {site:null,total:blueprint({x:0,y:0,z:0}).length,built:0,remaining:66,complete:false};const cells=blueprint(origin);const built=cells.filter(p=>bot.blockAt(new Vec3(p.x,p.y,p.z))?.name.endsWith('_planks')).length;return {site:origin,total:cells.length,built,remaining:cells.length-built,complete:built===cells.length}}
 function safeSite(p){for(let x=0;x<4;x++)for(let z=0;z<4;z++){const ground=bot.blockAt(p.offset(x,-1,z));if(ground?.boundingBox!=='block'||/leaves|log/.test(ground.name))return false;for(let y=0;y<=4;y++)if(bot.blockAt(p.offset(x,y,z))?.name!=='air')return false}return true}
 async function findSite(token){
  if(origin)return
  const start=bot.entity.position.floored();let tries=0
  for(const radius of [3,6,10,14])for(let dx=-radius;dx<=radius;dx+=2)for(let dz=-radius;dz<=radius;dz+=2)for(let dy=0;dy>=-3;dy--){check(token);const p=start.offset(dx,dy,dz);if(!safeSite(p))continue
   try{await near(p.offset(1,0,-1),1,token)}catch{check(token);if(++tries>=5)throw new Error('평평한 부지 후보에 접근하지 못했어요. 다른 위치를 탐색합니다.');continue}
   if(!safeSite(p))continue
   origin={x:p.x,y:p.y,z:p.z};fs.mkdirSync(path.dirname(siteFile),{recursive:true});fs.writeFileSync(siteFile,JSON.stringify({server:`${process.env.MC_HOST||'127.0.0.1'}:${process.env.MC_PORT||25565}`,origin}));log({type:'message',text:`대피소 부지 확보: (${p.x}, ${p.y}, ${p.z}), 4×4 나무 바닥·벽·지붕`});return
  }
  throw new Error('주변에 비어 있는 평평한 4×4 부지가 없어요. 넓은 공간을 탐색합니다.')
 }
 async function materials(token){await planks(status().remaining,token)}
 async function build(token){
  if(!origin)throw new Error('대피소 부지가 먼저 필요해요.')
  const offsets=[new Vec3(0,-1,0),new Vec3(-1,0,0),new Vec3(1,0,0),new Vec3(0,0,-1),new Vec3(0,0,1),new Vec3(0,1,0)]
  let placed=0
  for(const cell of blueprint(origin)){
   check(token);const p=new Vec3(cell.x,cell.y,cell.z),current=bot.blockAt(p)
   if(current?.name.endsWith('_planks'))continue
   if(current?.name!=='air')throw new Error(`건축 예정 위치 (${p.x}, ${p.y}, ${p.z})에 다른 블록이 있어요.`)
   if(bot.entity.position.distanceTo(p)>3.5||bot.entity.position.floored().equals(p)||bot.entity.position.floored().offset(0,1,0).equals(p))await near(new Vec3(origin.x+1,origin.y+1,origin.z-1),0,token)
   let item=bot.inventory.items().find(i=>i.name.endsWith('_planks'))
   if(!item)throw new Error('건축용 판자가 부족해요.')
   let success=false
   for(const off of offsets){const reference=bot.blockAt(p.plus(off));if(reference?.boundingBox!=='block')continue
    try{if(bot.entity.position.distanceTo(p)>4)await near(p,3,token);check(token);await bot.equip(item,'hand');await bot.placeBlock(reference,off.scaled(-1));check(token);success=bot.blockAt(p)?.name.endsWith('_planks');if(success)break}catch(e){check(token)}
   }
   if(!success)throw new Error(`블록 설치 위치 (${p.x}, ${p.y}, ${p.z})에 접근하지 못했어요.`)
   if(++placed>=12)return
  }
 }
 return {status,findSite,materials,build}
}
module.exports={blueprint,createShelter}
