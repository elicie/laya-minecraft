const {Vec3}=require('vec3'),{designs}=require('./structures')
function isHomeRequest(text){return /^(?:!home|(?:우리\s*)?(?:집|기지|거점|성|성채|성곽)(?:으로|로|에)?\s*(?:돌아가|돌아와|들어가|복귀|귀환|이동|가자|가|와)(?:\s*(?:줘|주세요|해줘|해|해라|줄래|요|라))?[.!?]?)$/i.test(text.trim())}
function homeDesign(text){return /^(?:우리\s*)?(?:성채|성곽|성)(?:으로|로|에|\s)/.test(text.trim())?'castle':''}
function createHome(bot,{structures,near,check,log=()=>{}}){
 function choose(design=''){
  return (structures.allStatus?.()||[]).filter(b=>b.origin&&['house','cabin','castle'].includes(b.kind)&&(!design||b.kind===design)&&(b.built>0||b.unloaded>0)).sort((a,b)=>Number(b.complete)-Number(a.complete)||(!a.complete&&!b.complete?['house','cabin','castle'].indexOf(a.kind)-['house','cabin','castle'].indexOf(b.kind):0)||bot.entity.position.distanceTo(new Vec3(a.origin.x,a.origin.y,a.origin.z))-bot.entity.position.distanceTo(new Vec3(b.origin.x,b.origin.y,b.origin.z)))[0]
 }
 function noHome(){const e=new Error('돌아갈 집 위치가 아직 없어요. 먼저 집을 짓거나 등록된 건축 부지를 확인해 주세요.');e.code='HOME_UNKNOWN';throw e}
 async function go(token,{design=''}={}){
  check(token);let home=choose(design);if(!home)noHome()
  const p=new Vec3(home.origin.x,home.origin.y,home.origin.z),d=designs[home.kind],outside=p.offset(Math.floor(d.width/2),0,-2)
  if(home.unloaded){await near(outside,3,token);check(token);home=structures.status(home.kind);if(!home.built)noHome()}
  const interior=home.kind==='castle'?p.offset(7,1,9):p.offset(Math.floor(d.width/2),1,2),door=home.kind==='castle'?p.offset(7,1,7):p.offset(Math.floor(d.width/2),1,0)
  const habitable=home.complete||bot.blockAt(door)?.name.endsWith('_door'),clear=q=>bot.blockAt(q)?.boundingBox==='empty'&&bot.blockAt(q.offset(0,1,0))?.boundingBox==='empty'&&bot.blockAt(q.offset(0,-1,0))?.boundingBox==='block'
  const inside=habitable&&clear(interior),destination=inside?interior:outside
  log({type:'message',text:inside?`${home.title} 안으로 돌아갑니다: ${destination}`:`${home.title}은 아직 미완성이어서 건축 부지로 돌아갑니다: ${destination}`})
  await near(destination,inside?0:2,token);check(token)
  const result={kind:home.kind,inside,position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},destination:{...destination}}
  log({type:'message',text:inside?`${home.title} 안에 도착했어요.`:`${home.title} 건축 부지에 도착했어요.`});return result
 }
 return {choose,go}
}
module.exports={isHomeRequest,homeDesign,createHome}
