const {HOSTILES,canEngage}=require('./combat'),{safeFoods}=require('./campaign')
const RANGED=new Set(['skeleton','stray','bogged','pillager','witch','blaze','ghast'])
function observedEnemies(bot){return Object.values(bot.entities||{}).filter(e=>e.type!=='player'&&!e.username&&e.position&&(HOSTILES.has(e.name)||e.name==='spider'&&bot.time?.timeOfDay>=13000))}
function createThreatResponse(bot,hooks){
 const {check,token:currentToken,isReady,isBusy,hasWork,suspend,interrupt,run,skills,food,resume,log=()=>{},now=Date.now}=hooks
 let state={active:false,phase:'작업 중 위험 감시',reason:'공격과 가까운 적을 확인하며 작업을 진행합니다.',target:null,checkpoint:null,interruptions:0,resumptions:0,nextCheck:0,lastResult:null},running=false,lastDamage=-Infinity,handledDamage=-Infinity,safeSince=null,epoch=0
 const distance=e=>e.position.distanceTo(bot.entity.position)
 function visible(e){if(!bot.world?.raycast)return true;const start=bot.entity.position.offset(0,1.5,0),delta=e.position.offset(0,1,0).minus(start),length=delta.norm();return !bot.world.raycast(start,delta.scaled(1/(length||1)),Math.max(0,length-.3))}
 function enemies(){return observedEnemies(bot).filter(e=>distance(e)<24&&Math.abs(e.position.y-bot.entity.position.y)<6).sort((a,b)=>(b.name==='creeper'?100:0)+(RANGED.has(b.name)?25:0)-distance(b)-((a.name==='creeper'?100:0)+(RANGED.has(a.name)?25:0)-distance(a)))}
 function urgent(e){return distance(e)<(e.name==='creeper'?7:RANGED.has(e.name)?12:4.5)&&visible(e)||now()-lastDamage<2500&&distance(e)<20}
 function unsafe(e){return distance(e)<(RANGED.has(e.name)?18:e.name==='creeper'?10:12)&&visible(e)}
 function update(phase,reason,extra={}){const changed=state.phase!==phase||state.reason!==reason;state={...state,phase,reason,...extra};if(changed)log({type:'threat_response',...state,running})}
 function damage(){lastDamage=now();state.lastDamageAt=lastDamage}
 function cancel(reason='위험 대응과 자동 작업 재개를 취소했습니다.'){
  epoch++;safeSince=null
  if(state.active)update('대응 종료',reason,{active:false,checkpoint:null,target:null,nextCheck:0})
 }
 function watch(){
  if(state.active||running||!isReady()||bot.health<=0||!hasWork())return
  const all=enemies(),danger=all.filter(urgent),combat=skills.combatStatus?.()
  if(combat?.active&&bot.health>=10&&!danger.some(e=>e.name==='creeper')&&all.filter(e=>distance(e)<8).length<2)return
  if(!danger.length&&bot.health>=6&&(now()-lastDamage>=1200||lastDamage===handledDamage))return
  const checkpoint=suspend();if(!checkpoint)return
  state={...state,active:true,checkpoint,target:danger[0]?{id:danger[0].id,name:danger[0].name}:null,interruptions:state.interruptions+1,nextCheck:0};safeSince=null
  update('작업 일시 중단',danger.length?'가까운 적 또는 피격을 감지해 작업을 중단하고 기존 목표를 보존합니다.':'체력이 위험해 작업을 중단하고 식사·회복을 먼저 처리합니다.')
  handledDamage=lastDamage;interrupt()
 }
 async function tick(){
  watch()
  // Gathering recovery food is also interruptible if an enemy approaches.
  if(state.active&&running&&state.phase==='식사·회복'&&enemies().some(urgent)){
   update('회복 작업 중 위험 감지','식량 작업을 끊고 접근한 적과 먼저 거리를 확보합니다.');interrupt();return
  }
  if(!state.active||running||!isReady()||bot.health<=0||now()<state.nextCheck)return
  // The canceled task must close its crafting/furnace windows and release
  // controls before a response starts. Only one action owns the bot at a time.
  if(isBusy()){update('작업 정리 중','이전 작업의 이동·제작·채굴을 취소하고 대응을 준비합니다.');return}
  running=true;const token=currentToken(),ownEpoch=epoch
  try{
   check(token);const threats=enemies().filter(unsafe),enemy=threats[0]
   if(enemy){
    safeSince=null;state.target={id:enemy.id,name:enemy.name}
    if(canEngage(bot,threats)){
     update('작업 중 방어','체력·허기와 보유 무기를 확인해 가까운 단일 적을 상대합니다.')
     const result=await run(()=>skills.fightThreat?skills.fightThreat(enemy,token):skills.defend(token,{target:enemy.name}));check(token)
     state.lastResult=result?.killed?'서버 처치 이벤트 확인':'방어 결과 확인';state.nextCheck=now()+200
    }else{
     update('작업 중 후퇴','다수 적·크리퍼 또는 부족한 체력·식량·무기 때문에 거리를 확보합니다.')
     await run(()=>skills.retreat(enemy,token));check(token);state.lastResult='후퇴 경로 이동';state.nextCheck=now()+200
    }
    return
   }
   state.target=null
   const available=bot.inventory.items().some(i=>safeFoods.has(i.name))
   if(bot.food<18||bot.food<20&&bot.health<12){
    safeSince=null;update('식사·회복','주변 적과 거리를 확보했습니다. 식량을 먹거나 확보해 체력을 회복합니다.')
    if(available)await run(()=>skills.eat(token));else if(food)await run(()=>food(token));else throw new Error('회복할 식량이 필요합니다.')
    check(token);state.nextCheck=now()+500;return
   }
   if(bot.health<12){safeSince=null;update('체력 회복 확인','허기를 채웠습니다. 체력이 회복되는 동안 원래 작업을 보존합니다.');state.nextCheck=now()+1000;return}
   if(safeSince===null)safeSince=now()
   if(now()-safeSince<2000||now()-lastDamage<2500){update('주변 안전 확인','적 접근과 추가 피격이 없는지 확인한 뒤 같은 작업 단계를 이어갑니다.');state.nextCheck=now()+200;return}
   check(token);if(ownEpoch!==epoch)return
   const checkpoint=state.checkpoint
   // Clear the response first so a resumed action can itself be interrupted.
   state.active=false;state.checkpoint=null;safeSince=null
   const resumed=await resume(checkpoint);check(token);state.resumptions+=resumed?1:0
   update(resumed?'기존 작업 재개':'대응 완료',resumed?'주변이 안전해져 기존 목표의 같은 단계를 다시 실행합니다.':'목표가 변경되거나 중지되어 이전 작업을 다시 시작하지 않습니다.',{nextCheck:0})
  }catch(error){
   if(ownEpoch!==epoch||token!==currentToken()||!state.active)return
   safeSince=null;update('대응 경로 재확인',error.message,{lastResult:error.message,nextCheck:now()+1000})
  }finally{running=false}
 }
 return {tick,damage,cancel,isActive:()=>state.active,status:()=>({...state,running})}
}
module.exports={createThreatResponse,observedEnemies}
