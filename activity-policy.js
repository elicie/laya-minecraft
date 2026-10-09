const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto')
const {log:defaultLog}=require('./decision'),questions=require('./training/activity-questions.json')
const domains=['farm','build','collect','explore','fight']
const labels={food:'식량 회복',farm:'농사·수확',wait:'성장·대상 대기',survey:'건축 부지 조사',gather:'부족한 준비물 확보',build:'건축 진행',collect:'목표 자원 채집',search:'지형·자원 탐색',fight:'적대 몹 전투',retreat:'안전한 곳으로 퇴각',finish:'목표 달성 확인',pause:'중지·상태 확인'}
function normalizeObservation(value={}){
 const n=(key,max)=>Math.max(0,Math.min(max,Number.isFinite(value[key])?value[key]:0)),b=key=>!!value[key]
 return {version:1,domain:domains.includes(value.domain)?value.domain:'explore',mode:String(value.mode||'once').slice(0,16),health:n('health',20),hunger:n('hunger',20),bagFull:b('bagFull'),goalDone:b('goalDone'),siteKnown:b('siteKnown'),suppliesMissing:b('suppliesMissing'),farmPlaceKnown:b('farmPlaceKnown'),seedAvailable:b('seedAvailable'),ripe:n('ripe',2048),growing:b('growing'),checkDue:b('checkDue'),have:n('have',2048),target:n('target',512),sources:n('sources',128),toolReady:b('toolReady'),found:b('found'),threats:n('threats',128),closeThreats:n('closeThreats',128),creeperClose:b('creeperClose'),bowReady:b('bowReady'),weaponReady:b('weaponReady'),built:n('built',2048),harvested:n('harvested',2048),visited:n('visited',100000),kills:n('kills',100000),failures:n('failures',100),blocked:[...new Set((Array.isArray(value.blocked)?value.blocked:[]).filter(a=>Object.hasOwn(labels,a)))].sort()}
}
function dangerous(s){return (s.threats>0||s.closeThreats>0)&&s.health<10||s.closeThreats>=3||s.creeperClose&&!s.bowReady}
function describeObservation(value){
 const s=normalizeObservation(value),yn=v=>v?'yes':'no'
 return `Goal=${s.domain}; mode=${s.mode}; health=${s.health}; hunger=${s.hunger}; bag_full=${yn(s.bagFull)}; objective_done=${yn(s.goalDone)}; site_known=${yn(s.siteKnown)}; supplies_missing=${yn(s.suppliesMissing)}; farm_place=${yn(s.farmPlaceKnown)}; seeds_available=${yn(s.seedAvailable)}; ripe=${s.ripe}; growing=${yn(s.growing)}; check_due=${yn(s.checkDue)}; stock=${s.have}/${s.target}; resource_sources=${s.sources}; tool_ready=${yn(s.toolReady)}; requested_resource_found=${yn(s.found)}; enemies=${s.threats}; close_enemies=${s.closeThreats}; close_creeper=${yn(s.creeperClose)}; bow_ready=${yn(s.bowReady)}; weapon_ready=${yn(s.weaponReady)}; unsafe_combat=${yn(dangerous(s))}; blocks_built=${s.built}; harvested=${s.harvested}; visits=${s.visited}; kills=${s.kills}; failures=${s.failures}; blocked=${s.blocked.join(',')||'none'}.`
}
function allowedActions(value){
 const s=normalizeObservation(value),actions=['pause']
 if(s.threats>0||s.closeThreats>0)actions.push('retreat')
 if(s.health<8||dangerous(s))return actions
 if(s.hunger<18)actions.push('food')
 if(s.goalDone)actions.push('finish')
 if(!s.goalDone){
  if(s.domain==='build'){if(!s.siteKnown)actions.push('survey');else if(s.suppliesMissing)actions.push('gather');else actions.push('build')}
  if(s.domain==='farm'){
   if(s.suppliesMissing)actions.push('gather')
   if(s.growing&&!s.ripe&&!s.checkDue)actions.push('wait')
   else if(!s.suppliesMissing&&s.farmPlaceKnown&&s.seedAvailable)actions.push('farm')
  }
  if(s.domain==='collect'){if(!s.toolReady)actions.push('gather');else if(s.sources>0)actions.push('collect')}
  if(s.domain==='fight'){if(!s.threats)actions.push('wait');else if(!s.weaponReady)actions.push('gather');else actions.push('fight')}
  if(s.domain!=='fight')actions.push('search')
 }
 if(s.bagFull)return actions.filter(a=>['pause','retreat','food','finish','wait'].includes(a))
 return actions.filter(a=>a==='pause'||!s.blocked.includes(a))
}
function fallbackAction(value){
 const s=normalizeObservation(value),has=a=>allowedActions(s).includes(a)
 if(dangerous(s)&&has('retreat'))return 'retreat'
 if(s.health<8)return 'pause'
 if(s.hunger<18&&has('food'))return 'food'
 if(has('finish'))return 'finish'
 if(s.bagFull)return 'pause'
 if(s.domain==='farm'&&has('wait'))return 'wait'
 for(const action of ['survey','gather','farm','build','collect','fight','wait','search'])if(has(action))return action
 return 'pause'
}
function createActivityPolicy({fetchImpl=fetch,log=defaultLog,experienceFile=path.join(__dirname,'logs/activity-experiences.jsonl'),threshold=.6}={}){
 let latest=null,episodeId=randomUUID(),step=0
 async function decide(value,{preview=false}={}){
  const observation=normalizeObservation(value),state=describeObservation(observation),allowed=allowedActions(observation),started=Date.now();let answer=null,error=null,model=null
  try{
   const response=await fetchImpl(process.env.LAYA_ACTIVITY_ENDPOINT||'http://127.0.0.1:8084/api/decide',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(5000),body:JSON.stringify({state,questions})})
   if(!response.ok)throw new Error('행동 판단 모델 HTTP '+response.status)
   const result=await response.json();answer=result.answers?.activity_action;model=result.model
   if(!answer||result.state_truncated||result.usage?.truncated)throw new Error('상태가 잘렸거나 판단 형식이 올바르지 않습니다.')
   if(!allowed.includes(answer.choice))throw new Error('현재 상태에서 실행할 수 없는 행동: '+answer.choice)
   const confidence=answer.probabilities?.[answer.choice]??answer.confidence
   if(!Number.isFinite(confidence)||confidence<threshold||confidence>1)throw new Error('판단 확신이 부족하거나 올바르지 않습니다.')
  }catch(e){error=e.message}
  const decision={preview,source:error?'fallback':'laya',action:error?fallbackAction(observation):answer.choice,proposed:answer?.choice||null,confidence:answer?.probabilities?.[answer.choice]??answer?.confidence??null,probabilities:answer?.probabilities||{},model,error,observation,state,allowed,started,latency_ms:Date.now()-started}
  decision.id=log({type:'activity_decision',...decision});latest=decision;return decision
 }
 function outcome(decision,ok,after,error=null,details={}){
  const next=normalizeObservation(after),terminal=next.health<=0,interrupted=!ok&&/중지|취소|cancel/i.test(error||'')
  const row={type:'activity_outcome',episodeId,episodeStep:step++,decision_id:decision.id,action:decision.action,source:decision.source,model:decision.model,state:decision.state,observation:decision.observation,after:next,details,ok,error,terminal,interrupted,elapsed_ms:Date.now()-decision.started,labelStatus:'unreviewed',trainingEligible:false}
  fs.mkdirSync(path.dirname(experienceFile),{recursive:true});fs.appendFileSync(experienceFile,JSON.stringify({time:new Date().toISOString(),...row})+'\n');log(row)
  if(terminal||interrupted||decision.action==='finish'||decision.action==='pause'){episodeId=randomUUID();step=0}
 }
 return {decide,outcome,status:()=>latest}
}
module.exports={domains,labels,questions,normalizeObservation,describeObservation,allowedActions,fallbackAction,dangerous,createActivityPolicy}
