const {Vec3}=require('vec3')
const HOSTILES=new Set(['zombie','husk','drowned','skeleton','stray','bogged','wither_skeleton','blaze','ghast','creeper','witch','pillager','vindicator','ravager','cave_spider','silverfish','endermite'])
const NEUTRAL=new Set(['enderman','piglin','zombified_piglin','wolf','iron_golem','bee'])
function usableWeapon(bot){return bot.inventory.items().filter(i=>/_(sword|axe)$/.test(i.name)&&require('./resource-collector').toolLife(i)>2).sort((a,b)=>weaponScore(b)-weaponScore(a))[0]}
function weaponScore(i){const tier=['wooden','golden','stone','iron','diamond','netherite'].indexOf(i.name.split('_')[0]);return tier*2+(i.name.endsWith('_sword')?1:0)}
function weaponRecipe(bot){const count=n=>bot.inventory.items().filter(i=>i.name===n).reduce((s,i)=>s+i.count,0);return count('iron_ingot')>=2?'iron_sword':count('cobblestone')>=2?'stone_sword':'wooden_sword'}
function canEngage(bot,enemies){
 const target=enemies[0];if(!target||bot.health<14||bot.food<18||!usableWeapon(bot))return false
 const close=enemies.filter(e=>e.position.distanceTo(bot.entity.position)<8)
 if(close.length>1||close.some(e=>e.name==='creeper'))return false
 return ['zombie','husk','drowned','spider','silverfish','endermite'].includes(target.name)&&target.position.distanceTo(bot.entity.position)<=12
}
function attackInterval(item){return item?.name.endsWith('_axe')?1100:650}
function threatScore(entity,position){const distance=entity.position.distanceTo(position);return ({creeper:80,witch:45,skeleton:30,blaze:35}[entity.name]||15)-distance*2}
function createCombat(bot,{check,near,sleep,equip,eat,acquire,log=()=>{}}){
 let state={phase:'대기',target:null,kills:0,retreats:0,lastResult:null},active=false
 const distance=e=>e.position.distanceTo(bot.entity.position)
 const threats=()=>Object.values(bot.entities||{}).filter(e=>e.type!=='player'&&(HOSTILES.has(e.name)||e.name==='spider'&&bot.time?.timeOfDay>=13000)&&distance(e)<20).sort((a,b)=>threatScore(b,bot.entity.position)-threatScore(a,bot.entity.position))
 function status(){return {...state,weapon:usableWeapon(bot)?.name||null,active,threats:threats().slice(0,8).map(e=>({id:e.id,name:e.name,distance:Math.round(distance(e)*10)/10}))}}
 function shield(on){if(on&&bot.inventory.slots[45]?.name==='shield')bot.activateItem(true);else bot.deactivateItem()}
 async function prepare(token){
  check(token);let weapon=usableWeapon(bot)
  if(!weapon){
   const count=n=>bot.inventory.items().filter(i=>i.name===n).reduce((s,i)=>s+i.count,0)
   const name=weaponRecipe(bot)
   state.phase='무기 제작';log({type:'message',text:`전투 준비: 보유 재료로 ${name} 제작을 진행합니다.`})
   if(!acquire)throw new Error('무기 제작 경로가 연결되지 않았습니다.')
   await acquire(name,count(name)+1,token);check(token);weapon=usableWeapon(bot)
  }
  if(!weapon)throw new Error('사용 가능한 무기를 확보하지 못했습니다.')
  await equip(token);await bot.equip(weapon,'hand');check(token);state.weapon=weapon.name;state.phase='무기 준비 완료';return {weapon:weapon.name}
 }
 async function retreat(entity,token){state.phase='거리 확보';state.retreats++;bot.pathfinder.setGoal(null);shield(true)
  const p=bot.entity.position.floored(),away=p.minus(entity.position),length=Math.hypot(away.x,away.z)||1
  const options=[];for(const offset of [0,Math.PI/3,-Math.PI/3,Math.PI/2,-Math.PI/2])for(const range of [5,8]){const angle=Math.atan2(away.z,away.x)+offset;for(let y=-1;y<=1;y++){const q=p.offset(Math.round(Math.cos(angle)*range),y,Math.round(Math.sin(angle)*range)),ground=bot.blockAt(q.offset(0,-1,0)),feet=bot.blockAt(q),head=bot.blockAt(q.offset(0,1,0));if(ground?.boundingBox!=='block'||!feet||!head||feet.boundingBox!=='empty'||head.boundingBox!=='empty'||[ground,feet,head].some(b=>['lava','water','magma_block','fire'].includes(b.name)))continue;options.push(q)}}
  options.sort((a,b)=>b.distanceTo(entity.position)-a.distanceTo(entity.position))
  for(const q of options.slice(0,3)){check(token);try{await near(q,1,token);check(token);return}catch(e){check(token)}}throw new Error('퇴각 경로를 찾지 못했습니다. 주변 접근로가 필요합니다.')
 }
 async function bow(entity,token){const bow=bot.inventory.items().find(i=>i.name==='bow'),arrow=bot.inventory.items().find(i=>i.name==='arrow');if(!bow||!arrow)throw new Error('크리퍼는 활과 화살을 확보한 후 상대합니다.');shield(false);await bot.equip(bow,'hand');const d=distance(entity);await bot.lookAt(entity.position.offset(0,(entity.height||1)/2+Math.min(4,d*d*0.003),0));bot.activateItem();try{for(let i=0;i<6;i++){check(token);await sleep(200)}}finally{bot.deactivateItem()}await sleep(300)}
 async function fight(entity,token){
  check(token);if(!entity||entity.type==='player'||entity.username)throw new Error('전투 대상이 없거나 플레이어입니다.')
  if(active)throw new Error('전투가 이미 진행 중입니다.');active=true;state.target={id:entity.id,name:entity.name};state.phase='전투 준비'
  let killed=false;const death=e=>{if(e.id===entity.id)killed=true};bot.on('entityDead',death)
  const until=Date.now()+45000
  try{
   if(bot.health<10||bot.food<8)throw new Error('전투 전에 허기와 체력을 회복해야 합니다.')
   await prepare(token)
   while(bot.entities[entity.id]&&Date.now()<until){
    check(token)
    const danger=threats().filter(e=>distance(e)<8&&e.id!==entity.id)
    if(bot.health<10||danger.length>=2||danger.some(e=>e.name==='creeper')){await retreat(danger.find(e=>e.name==='creeper')||entity,token);if(bot.food<18&&bot.inventory.items().some(i=>require('./campaign').safeFoods.has(i.name))){shield(false);await eat(token)}throw new Error('체력 또는 주변 적 때문에 퇴각했습니다. 회복 후 다시 진행합니다.')}
    if(entity.name==='creeper'){
     if(distance(entity)<7){await retreat(entity,token);check(token)}
     state.phase='원거리 공격';await bow(entity,token);continue
    }
    if(distance(entity)>3){state.phase='방패·접근';shield(['skeleton','stray','bogged','blaze','pillager'].includes(entity.name));await near(entity.position,2,token);check(token)}
    if(!bot.entities[entity.id])break
    if(distance(entity)>3.2){await sleep(100);continue}
    shield(false);await equip(token);const weapon=usableWeapon(bot);if(!weapon)throw new Error('전투 중 무기가 소모되었습니다.');if(bot.heldItem!==weapon)await bot.equip(weapon,'hand')
    const start=bot.entity.position.offset(0,bot.entity.height||1.62,0),aim=entity.position.offset(0,Math.min(entity.height||1,1),0),delta=aim.minus(start),len=delta.norm()
    const obstacle=bot.world?.raycast?.(start,delta.scaled(1/(len||1)),Math.max(0,len-0.3))
    if(obstacle&&obstacle.boundingBox==='block'){state.phase='시야 확보';await near(entity.position,1,token);continue}
    state.phase='근접 공격';await bot.lookAt(aim);bot.attack(entity);await sleep(attackInterval(bot.heldItem))
    if(['skeleton','stray','bogged','blaze','pillager'].includes(entity.name)&&bot.entities[entity.id]){shield(true);await sleep(300)}
   }
   check(token);if(!killed)throw new Error('서버에서 처치를 확인하지 못했습니다. 대상 이탈 또는 전투 시간 초과입니다.')
   state.kills++;state.phase='드롭 회수';shield(false)
   for(const drop of Object.values(bot.entities||{}).filter(e=>e.name==='item'&&e.position.distanceTo(entity.position)<8).slice(0,8)){check(token);try{await near(require('./pickup-navigation').pickupStand(bot,drop.position),0,token);await sleep(300)}catch(e){check(token)}}
   state.phase='전투 완료';state.lastResult='처치 확인';log({type:'message',text:`전투: ${entity.name} 처치 이벤트 확인`});return {killed:true,name:entity.name}
  }catch(e){state.lastResult=e.message;throw e}finally{active=false;bot.removeListener('entityDead',death);shield(false);bot.clearControlStates()}
 }
 async function defend(token,options={}){check(token);const target=options.target?Object.values(bot.entities||{}).filter(e=>e.name===options.target&&e.type!=='player').sort((a,b)=>distance(a)-distance(b))[0]:threats()[0];if(!target){state.phase='주변 경계';state.target=null;return {waiting:true,killed:false,nextCheck:Date.now()+5000}}return fight(target,token)}
 return {fight,defend,retreat,prepare,status,threats}
}
module.exports={createCombat,HOSTILES,NEUTRAL,attackInterval,threatScore,usableWeapon,canEngage,weaponRecipe}
