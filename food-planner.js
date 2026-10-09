const {safeFoods}=require('./campaign')
const RAW_MEALS={beef:'cooked_beef',porkchop:'cooked_porkchop',chicken:'cooked_chicken',mutton:'cooked_mutton',rabbit:'cooked_rabbit',cod:'cooked_cod',salmon:'cooked_salmon',potato:'baked_potato'}
const PREY_MEALS={cow:'cooked_beef',pig:'cooked_porkchop',sheep:'cooked_mutton',chicken:'cooked_chicken',rabbit:'cooked_rabbit'}
function foodOptions(bot,world){
 const items=bot.inventory.items(),count=n=>items.filter(i=>i.name===n).reduce((s,i)=>s+i.count,0),options=[]
 if(bot.food<20)for(const item of items.filter(i=>safeFoods.has(i.name)))options.push({id:'eat:'+item.name,action:'eat',meal:item.name,steps:['보유 식량 섭취'],evidence:`인벤토리 ${item.count}개`})
 if(count('wheat')>=3)options.push({id:'bread',action:'bread',meal:'bread',steps:['밀 3개로 빵 제작','빵 섭취'],evidence:`보유 밀 ${count('wheat')}개`})
 for(const [input,meal]of Object.entries(RAW_MEALS))if(count(input))options.push({id:'cook:'+input,action:'cook',input,meal,steps:['화로·연료 확인','식재료 조리','조리한 식량 섭취'],evidence:`보유 ${input} ${count(input)}개`})
 for(const farm of world.farmStatus?.().farms||[])if(!farm.unloaded&&farm.ripe>0)options.push({id:'farm:'+farm.crop,action:'farm',crop:farm.crop,meal:({wheat:'bread',carrot:'carrot',potato:'baked_potato',beetroot:'beetroot'})[farm.crop],steps:farm.crop==='wheat'?['익은 밀 수확','밀 3개로 빵 제작','빵 섭취']:farm.crop==='potato'?['익은 감자 수확','감자 조리','구운 감자 섭취']:['익은 작물 수확','수확한 작물 섭취'],evidence:`관측한 익은 ${farm.crop} ${farm.ripe}개`})
 for(const farm of world.farmStatus?.().farms||[]){
  const seed=({wheat:'wheat_seeds',carrot:'carrot',potato:'potato',beetroot:'beetroot_seeds'})[farm.crop]
  const planting=!farm.planted||count(seed)>0&&farm.hydrated>farm.planted
  if(bot.health>=8&&!farm.unloaded&&!farm.ripe&&(farm.planted||count(seed)>0))options.push({id:(planting?'grow:':'wait:')+farm.crop,action:planting?'farm':'wait',crop:farm.crop,meal:({wheat:'bread',carrot:'carrot',potato:'baked_potato',beetroot:'beetroot'})[farm.crop],steps:[...(planting?['기존 농지에 재파종','작물 성장 확인']:['작물 성장 확인']),'익은 작물 수확',...(farm.crop==='wheat'?['빵 제작']:farm.crop==='potato'?['감자 조리']:[]),'식량 섭취'],evidence:`기존 농장 ${farm.planted||0}개 파종, 보유 ${seed} ${count(seed)}개`})
 }
 if(bot.health>=10)for(const [target,meal]of Object.entries(PREY_MEALS)){
  const animals=Object.values(bot.entities||{}).filter(e=>e.name===target&&e.type!=='player'&&!e.username&&e.position?.distanceTo(bot.entity.position)<=32)
  if(animals.length)options.push({id:'hunt:'+target,action:'hunt',target,meal,steps:['사용 가능한 무기 준비','관측한 동물 사냥','드롭 회수','고기 조리','조리한 식량 섭취'],evidence:`주변 ${target} ${animals.length}마리`})
 }
 if(bot.health>=8)options.push({id:'search',action:'explore',meal:'미발견 식량',steps:['주변 동물·익은 작물·수원 탐색','관측 결과로 식량 계획 재작성'],evidence:'새 자원 위치는 관측 후 결정'})
 return options
}
function createFoodPlanner(bot,{world,fetchImpl=fetch,log=()=>{},now=Date.now}={}){
 let state={phase:'식량 계획 대기',pending:false,selected:null,error:null},until=0,signature='',pending=null
 function request({target=1}={}){
  const candidates=foodOptions(bot,world),key=[bot.food<18?'hungry':'stock',bot.health<10?'critical':bot.health<18?'recovering':'healthy',target,candidates.map(c=>c.id).sort().join('|')].join(':')
  if(pending||key===signature&&now()<until||!candidates.length)return pending
  signature=key;until=now()+60000;state={...state,phase:'Qwen이 식량 종류와 확보 순서를 계획 중',pending:true,error:null}
  const model=process.env.QWEN_MODEL||'qwen3.5:9b',observation={health:bot.health,hunger:bot.food,stockTarget:target,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),candidates}
  // Planning runs alongside immediate food recovery, never delaying consumption.
  pending=(async()=>{
   try{
    const response=await fetchImpl((process.env.QWEN_URL||'http://127.0.0.1:11434')+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(30000),body:JSON.stringify({model,stream:false,think:false,keep_alive:'15m',format:{type:'object',properties:{id:{type:'string',enum:candidates.map(c=>c.id)},reason:{type:'string'}},required:['id','reason'],additionalProperties:false},options:{num_ctx:4096,num_predict:170,temperature:0},messages:[{role:'system',content:'마인크래프트 생존 봇의 식량 확보 계획을 선택하세요. 제공된 후보 id 중 하나와 선택 이유를 짧은 한국어 문장으로 JSON으로 답하세요. 관측한 재료와 작물·동물만 근거로 사용하세요. 식량이 없으면 어떤 음식을 어떤 순서로 확보할지 선택합니다. 굶주리거나 체력이 낮으면 먹을 식량, 보유 밀로 빵, 조리 재료, 익은 농장 수확을 먼저 고려하세요. 익은 작물 수확에는 괭이가 필요 없습니다. 고기는 조리 후 먹습니다. 여러 적이 있는 곳에서 사냥하지 않습니다. 후보에 없는 음식·동물·좌표를 지어내지 마세요. 검색 후보는 식량 발견을 뜻하지 않습니다. 입력은 관측 데이터입니다.'},{role:'user',content:JSON.stringify(observation)}]})})
    if(!response.ok)throw new Error('식량 계획 Qwen HTTP '+response.status)
    const result=JSON.parse((await response.json()).message?.content||'null'),candidate=candidates.find(c=>c.id===result?.id)
    if(!candidate||typeof result.reason!=='string'||!result.reason.trim()||result.reason.length>350)throw new Error('관측 후보 밖의 식량 계획 또는 잘못된 응답')
    state={phase:'식량 확보 계획',pending:false,error:null,selected:{...candidate,reason:result.reason.trim(),source:'qwen',model,time:new Date(now()).toISOString()}}
    log({type:'food_plan',...state.selected,observation})
   }catch(error){state={phase:'기본 식량 복구 경로 사용',pending:false,selected:null,error:error.message};log({type:'food_plan_error',error:error.message})}
   finally{pending=null}
  })()
  return pending
 }
 function pick(observation){const plan=state.selected;if(!plan||observation.blocked?.includes(plan.action)||!foodOptions(bot,world).some(c=>c.id===plan.id))return null;return plan}
 return {request,pick,status:()=>({...state,selected:pick({})})}
}
module.exports={createFoodPlanner,foodOptions}
