const {pickupStand}=require('./pickup-navigation')
const {Vec3}=require('vec3'),fs=require('node:fs'),path=require('node:path')
function createWorldSkills(bot,{check,near,acquire,place,sleep,log:hooksLog=()=>{},farmingArea=()=>null},farmFile){
 const items=()=> (bot.currentWindow||bot.inventory).items()
 async function storage(mode,name,quantity,token,options={}){
  if(!bot.registry.itemsByName[name]||!Number.isInteger(quantity)||quantity<1||quantity>512)throw new Error('보관 아이템 또는 수량 오류')
  let block=options.position?bot.blockAt(new Vec3(options.position.x,options.position.y,options.position.z)):bot.findBlock({matching:b=>b.name==='chest',maxDistance:24})
  if(options.position&&block?.name!=='chest')throw new Error('공유 창고 상자를 실제로 관측하지 못했습니다.')
  if(block)await near(block.position,2,token)
  else{if(mode==='take'||options.existingOnly)throw new Error('주변에 상자가 없어요.');await acquire('chest',1,token);block=await place('chest',token)}
  const chest=await bot.openContainer(block)
  try{check(token);const matching=(mode==='take'?chest.containerItems():chest.items()).filter(i=>i.name===name),item=matching[0];if(!item||matching.reduce((n,i)=>n+i.count,0)<quantity)throw new Error('요청한 수량이 없습니다.');if(mode==='take')await chest.withdraw(item.type,null,quantity);else await chest.deposit(item.type,null,quantity);check(token)}finally{chest.close()}
 }
 async function storageContents(position,token){
  const block=bot.blockAt(new Vec3(position.x,position.y,position.z));if(block?.name!=='chest')throw new Error('공유 창고 상자를 관측하지 못했습니다.')
  await near(block.position,2,token);check(token);const chest=await bot.openContainer(block)
  try{check(token);const counts={};for(const item of chest.containerItems())counts[item.name]=(counts[item.name]||0)+item.count;return counts}finally{chest.close()}
 }
 const farming=require('./farming').createFarming(bot,{check,near,acquire,sleep,log:hooksLog,area:farmingArea},farmFile)
 async function farm(token,options){return farming.work(token,options)}
 async function sleepInBed(token){const block=bot.findBlock({matching:b=>b.name.endsWith('_bed'),maxDistance:24});if(!block)throw new Error('주변에 침대가 없습니다.');await near(block.position,2,token);check(token);await bot.sleep(block)}
 async function recover(death,token){
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code})}
  check(token)
  if(!death?.position)throw new Error('저장된 사망 위치가 없어요.')
  if(death.dimension!==bot.game.dimension)fail('DEATH_OTHER_DIMENSION','사망 지점이 다른 차원입니다. 포털을 먼저 이동해야 합니다.')
  if(death.time&&Date.now()-Date.parse(death.time)>=300000)fail('DEATH_EXPIRED','사망 후 5분이 지나 아이템이 소실되었을 수 있습니다.')
  const p=new Vec3(death.position.x,death.position.y,death.position.z),{HOSTILES}=require('./combat')
  const danger=()=>Object.values(bot.entities).some(e=>e.type!=='player'&&HOSTILES.has(e.name)&&e.position.distanceTo(p)<10)
  if(danger())fail('DEATH_DANGER','사망 지점에 적이 있어 바로 접근하지 않습니다.')
  const before=items().reduce((n,i)=>n+i.count,0)
  // Entering pickup range can collect drops before the next entity scan.
  await near(p,2,token);check(token);await sleep(400);check(token)
  if(danger())fail('DEATH_DANGER','접근 중 사망 지점의 적을 발견해 회수를 중단했습니다.')
  const drops=()=>Object.values(bot.entities).filter(e=>e.name==='item'&&e.position.distanceTo(p)<16)
  const deadline=Date.now()+30000
  for(let pass=0;pass<3&&Date.now()<deadline;pass++){
   const remaining=drops();if(!remaining.length)break
   for(const e of remaining){
    check(token);if(Date.now()>=deadline)break
    if(!bot.entities[e.id])continue
    if(danger())fail('DEATH_DANGER','회수 중 주변 적을 발견해 접근을 중단했습니다.')
    // A one-block path radius can leave a drop outside the pickup hitbox.
    await near(pickupStand(bot,e.position),0,token);await sleep(400);check(token)
   }
  }
  const recovered=items().reduce((n,i)=>n+i.count,0)-before
  if(recovered<=0)fail('DEATH_EMPTY','사망 위치에 남아 있는 아이템을 인벤토리에서 확인하지 못했습니다.')
  if(drops().length)fail('DEATH_PARTIAL','일부 아이템은 회수했지만 사망 지점에 드롭이 남아 있습니다.')
  return {recovered,position:death.position}
 }
 return {storage,storageContents,farm,farmStatus:farming.status,sleepInBed,recover}
}
module.exports={createWorldSkills}
