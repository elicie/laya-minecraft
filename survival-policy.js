const fs=require('node:fs'),path=require('node:path')
const {randomUUID}=require('node:crypto')
const questions=require('./training/food-questions.json')
const {log:defaultLog}=require('./decision')
const labels={eat:'식량 섭취',cook:'조리',bread:'빵 제작',hunt:'사냥',farm:'농사·수확',explore:'식량 탐색',wait:'작물 성장 대기',continue:'기존 목표 진행',stop:'회복 대기'}
function normalizeObservation(value={}){
 const number=(name,min,max)=>Math.max(min,Math.min(max,Number.isFinite(value[name])?value[name]:min))
 return {version:1,goal:String(value.goal||'survive').slice(0,40),health:number('health',0,20),hunger:number('hunger',0,20),urgent:!!value.urgent,target:number('target',1,64),safe:number('safe',0,2048),raw:number('raw',0,2048),wheat:number('wheat',0,2048),prey:number('prey',0,128),ripe:number('ripe',0,2048),growing:!!value.growing,checkDue:!!value.checkDue,farmReady:!!value.farmReady,deaths:number('deaths',0,100000),blocked:[...new Set((Array.isArray(value.blocked)?value.blocked:[]).filter(a=>Object.hasOwn(labels,a)))].sort()}
}
function describeObservation(value){
 const s=normalizeObservation(value),yes=v=>v?'yes':'no'
 return `Goal=${s.goal}; health=${s.health}/20 (${s.health<8?'critical':'safe'}); hunger=${s.hunger}/20 (${s.hunger<18?'hungry':'satisfied'}); urgent=${yes(s.urgent)}; safe_meals=${s.safe}; stock_target=${s.target} (${s.safe>=s.target?'enough':'short'}); raw_ingredients=${s.raw}; wheat=${s.wheat} (${s.wheat>=3?'bread_ready':'insufficient'}); nearby_animals=${s.prey}; ripe_crops=${s.ripe}; growing_farm=${yes(s.growing)}; growth_check_due=${yes(s.checkDue)}; farm_supplies=${yes(s.farmReady)}; blocked=${s.blocked.join(',')||'none'}.`
}
function allowedActions(value){
 const s=normalizeObservation(value)
 const out=s.health<8?['stop']:['explore']
 if(s.safe>0&&s.hunger<20)out.push('eat')
 if(s.raw>0)out.push('cook')
 if(s.wheat>=3)out.push('bread')
 if(s.prey>0&&s.health>=10)out.push('hunt')
 if(s.ripe>0||s.health>=8&&(s.farmReady||s.growing)&&(!s.growing||s.checkDue))out.push('farm')
 if(s.growing&&!s.checkDue)out.push('wait')
 if(s.safe>=s.target&&(!s.urgent||s.hunger>=18))out.push('continue')
 return out.filter(a=>!s.blocked.includes(a))
}
function fallbackAction(value){
 const s=normalizeObservation(value),allowed=allowedActions(s),has=a=>allowed.includes(a)
 if(s.urgent&&has('eat'))return 'eat'
 if(has('continue'))return 'continue'
 for(const action of ['cook','bread'])if(has(action))return action
 if(s.ripe&&has('farm'))return 'farm'
 if(has('stop'))return 'stop'
 for(const action of ['hunt','wait','farm','explore'])if(has(action))return action
 return 'stop'
}
function urgentAction(value){
 const s=normalizeObservation(value),has=a=>allowedActions(s).includes(a)
 if(!s.urgent||s.hunger>=18)return null
 if(has('eat'))return 'eat'
 for(const a of ['bread','cook'])if(has(a))return a
 if(s.ripe&&has('farm'))return 'farm'
 return null
}
function rewardFor(before,after,{ok,elapsed_ms}){
 const hunger=after.hunger-before.hunger,food=after.safe-before.safe,raw=after.raw-before.raw,damage=Math.max(0,before.health-after.health),deaths=Math.max(0,after.deaths-before.deaths)
 const parts={hunger:.4*Math.max(0,hunger),food:.2*food,raw:.1*raw,damage:-damage,death:-10*deaths,failure:ok?0:-2,time:-Math.min(1,elapsed_ms/100000)}
 return {value:Object.values(parts).reduce((sum,n)=>sum+n,0),parts,version:'food-v1-provisional'}
}
function createSurvivalPolicy({fetchImpl=fetch,log=defaultLog,experienceFile=path.join(__dirname,'logs/policy-experiences.jsonl'),threshold=0.6}={}){
 let latest=null,episodeId=randomUUID(),episodeStep=0
 async function decide(value,{plan=null}={}){
  const observation=normalizeObservation(value),state=describeObservation(observation),allowed=allowedActions(observation),started=Date.now()
  let answer=null,error=null,model=null
  try{
   const response=await fetchImpl(process.env.LAYA_POLICY_ENDPOINT||'http://127.0.0.1:8083/api/decide',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(5000),body:JSON.stringify({state,questions})})
   if(!response.ok)throw new Error('상황 판단 모델 HTTP '+response.status)
   const result=await response.json();answer=result.answers?.food_action;model=result.model
   if(!answer||result.state_truncated||result.usage?.truncated)throw new Error('상태가 잘렸거나 판단 형식이 올바르지 않습니다.')
   if(!allowed.includes(answer.choice))throw new Error('현재 상태에서 실행할 수 없는 행동: '+answer.choice)
   const confidence=answer.probabilities?.[answer.choice]??answer.confidence
   if(!Number.isFinite(confidence)||confidence<threshold||confidence>1)throw new Error('판단 확신이 부족하거나 올바르지 않습니다.')
  }catch(e){error=e.message}
  const urgent=urgentAction(observation),preferred=plan&&allowed.includes(plan.action)?plan:null
  if(urgent&&answer?.choice!==urgent)error=`허기 회복 우선: ${urgent}을 먼저 실행합니다.`
  const usePlan=preferred&&(!urgent||preferred.action===urgent)?preferred:null
  const decision={source:usePlan?'qwen':error?'fallback':'laya',action:urgent||usePlan?.action||(error?fallbackAction(observation):answer.choice),proposed:answer?.choice||null,confidence:answer?.probabilities?.[answer.choice]??answer?.confidence??null,probabilities:answer?.probabilities||{},model:usePlan?.model||model,error,plan:preferred,observation,state,allowed,started,latency_ms:Date.now()-started}
  decision.id=log({type:'policy_decision',...decision});latest=decision
  return decision
 }
 function outcome(decision,action,ok,after,error=null){
  const elapsed_ms=Date.now()-decision.started,next=normalizeObservation(after),reward=rewardFor(decision.observation,next,{ok,elapsed_ms})
  const terminal=next.health<=0||next.deaths>decision.observation.deaths,interrupted=!ok&&/중지|취소|cancel/i.test(error||'')
  const row={type:'policy_outcome',episodeId,episodeStep:episodeStep++,decision_id:decision.id,action,source:decision.source,model:decision.model,probabilities:decision.probabilities,chosenProbability:decision.source==='laya'?decision.probabilities[action]:null,ok,error,terminal,interrupted,state:decision.state,observation:decision.observation,after:next,elapsed_ms,reward:reward.value,rewardParts:reward.parts,rewardVersion:reward.version,labelStatus:'unreviewed',trainingEligible:false}
  // Experience is recorded, never treated as its own correct-action label.
  fs.mkdirSync(path.dirname(experienceFile),{recursive:true});fs.appendFileSync(experienceFile,JSON.stringify({time:new Date().toISOString(),...row})+'\n');log(row)
  if(terminal||interrupted||action==='continue'||action==='eat'&&next.hunger>=18){episodeId=randomUUID();episodeStep=0}
 }
 return {decide,outcome,status:()=>latest}
}
module.exports={createSurvivalPolicy,normalizeObservation,describeObservation,allowedActions,fallbackAction,urgentAction,rewardFor,labels,questions}
