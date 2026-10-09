const fs=require('node:fs'),path=require('node:path')
const {materialPlan}=require('./acquisition'),{designs}=require('./structures')
const {createFoodManager}=require('./food-manager')
const {createActivityManager}=require('./activity-manager')
const {dangerous}=require('./activity-policy')
const {createRoutine}=require('./routine')
const {isHomeRequest,homeDesign,createHome}=require('./home')
const TYPES=['item','build','farm','survive','fight','follow','store','take','sleep','recover','dragon','explore','collect','hunt','home']
const words=[['철곡괭이|철 곡괭이','iron_pickaxe'],['돌곡괭이|돌 곡괭이','stone_pickaxe'],['나무곡괭이|나무 곡괭이','wooden_pickaxe'],['다이아몬드? ?곡괭이|다이아 ?곡괭이','diamond_pickaxe'],['철검|철 무기|철 칼','iron_sword'],['돌괭이|돌 괭이','stone_hoe'],['방패','shield'],['철 투구','iron_helmet'],['철 흉갑','iron_chestplate'],['철 각반','iron_leggings'],['철 부츠','iron_boots'],['상자','chest'],['작업대','crafting_table'],['화로','furnace'],['횃불','torch'],['조약돌','cobblestone'],['철 주괴','iron_ingot'],['금 주괴','gold_ingot'],['철 원석','raw_iron'],['엔더의 눈','ender_eye'],['엔더 진주','ender_pearl'],['블레이즈 막대','blaze_rod'],['흑요석','obsidian'],['다이아몬드|다이아','diamond'],['석탄','coal'],['흙','dirt'],['막대기','stick'],['밀 씨앗','wheat_seeds'],['빵','bread'],['활','bow'],['화살','arrow']]
function goalTitle(g){return ({item:`${g.item} ${g.quantity}개 확보`,build:`${designs[g.design]?.title||'건물'} 건축`,farm:`${({wheat:'밀',carrot:'당근',potato:'감자',beetroot:'비트'})[g.crop||'wheat']} 농사 · ${({setup:'농장 조성',harvest:'수확 목표',continuous:'반복 관리'})[g.mode||'setup']}`,survive:'식량과 장비를 관리하며 생존',fight:'근처 적대 몹과 전투',follow:'근처 플레이어 따라가기',store:`${g.item} ${g.quantity}개 상자에 보관`,take:`상자에서 ${g.item} ${g.quantity}개 꺼내기`,sleep:'주변 침대에서 수면',recover:'사망 위치의 아이템 회수',dragon:'장비와 재료 준비부터 엔더드래곤 처치까지',collect:`${g.resource} ${g.quantity}개 채집`,home:'집·기지로 복귀',hunt:'동물 사냥과 드롭 회수',explore:'미방문 지형과 자원 탐색'})[g.type]}
function parseKnownGoals(text,registry){
 if(/엔더드래곤|엔더 드래곤|드래곤.*(?:처치|잡|진행)/.test(text))return [{type:'dragon'}]
 if(/생존|살아남|살아 남/.test(text)&&!/집|농사|창고|성|캐슬/.test(text))return [{type:'survive'}]
 const parts=text.replace(/((?:집|기지|거점|성채|성곽|성)(?:으로|로|에)\s*(?:돌아가|들어가|가))고/g,'$1,').split(/(?:만들고|짓고|모으고|캐고|모아서|그리고|하고|[,;])/).map(x=>x.trim()).filter(Boolean),out=[]
 for(const part of parts){if(/^(?:재료(?:부터)?|재료를|일단|먼저)$/.test(part))continue;let g=null
  if(isHomeRequest(part))g={type:'home',design:homeDesign(part)}
  else if(/(?:사망|죽은|죽었던).*(?:회수|찾|가져)/.test(part))g={type:'recover'}
  else if(/농사|농장|경작|파종|수확/.test(part))g={type:'farm',crop:/당근/.test(part)?'carrot':/감자/.test(part)?'potato':/비트/.test(part)?'beetroot':'wheat',mode:/계속|반복|자동|관리/.test(part)?'continuous':/수확/.test(part)?'harvest':'setup',quantity:Number(part.match(/(\d+)\s*개/)?.[1]||(/수확/.test(part)?16:1))}
  else if(/따라/.test(part))g={type:'follow'}
  else if(/잠자|자 줘|수면/.test(part))g={type:'sleep'}
  else if(/전투|몬스터|좀비.*잡|사냥|경비|지켜|호위/.test(part))g={type:/동물|소 |돼지|양 |닭|사냥/.test(part)&&!/좀비|몬스터|스켈레톤|크리퍼/.test(part)?'hunt':'fight',mode:/계속|경비|지켜|호위/.test(part)?'continuous':'once',target:/좀비/.test(part)?'zombie':/스켈레톤/.test(part)?'skeleton':/크리퍼/.test(part)?'creeper':'',quantity:Number(part.match(/(\d+)\s*마리/)?.[1]||1)}
  else if(/탐색|탐험|찾아/.test(part))g={type:'explore',resources:/철/.test(part)?['iron_ore','deepslate_iron_ore']:/석탄/.test(part)?['coal_ore','deepslate_coal_ore']:/물/.test(part)?['water']:[],mode:/계속|반복/.test(part)?'continuous':'once'}
  else if(/나무|원목|목재/.test(part)&&/캐|채집|모아|수집/.test(part))g={type:'collect',resource:'logs',quantity:Number(part.match(/(\d+)\s*개/)?.[1]||16)}
  else if(/성채|성곽|캐슬|(?:유럽|중세)[^,;]*성|(?:^|\s)성(?:을|의)?(?:\s|$|지|짓|만들|건축|세워)/.test(part))g={type:'build',design:'castle'}
  else if(/집|대피소|창고|전망대|다리/.test(part)&&!/상자.*(?:보관|넣|꺼내)/.test(part)){if(/성채|성곽|성 |대형|성당|아파트/.test(part))return null;g={type:'build',design:/창고/.test(part)?'warehouse':/전망대/.test(part)?'tower':/다리/.test(part)?'bridge':/넓은|큰/.test(part)?'house':'cabin'}}
  else{const exact=Object.keys(registry.itemsByName).find(n=>new RegExp('(?:^|\\s)'+n+'(?:$|\\s)').test(part)),entry=words.find(([pattern])=>new RegExp(pattern).test(part)),item=exact||entry?.[1];if(item)g={type:/보관|넣어|넣기|저장/.test(part)?'store':/꺼내|가져와/.test(part)?'take':'item',item,quantity:Number(part.match(/(\d+)\s*(?:개|자루|정|묶음)?/)?.[1]||1)}}
  if(!g)return null;out.push(g)
 }
 return out.length?out:null
}
function validateGoals(value,registry){if(!Array.isArray(value?.goals)||!value.goals.length||value.goals.length>12)throw new Error('목표를 작업으로 해석하지 못했습니다. 원하는 결과를 조금 더 구체적으로 입력해 주세요.');return value.goals.map(g=>{if(!TYPES.includes(g.type))throw new Error('알 수 없는 작업 종류');if(['item','store','take'].includes(g.type)&&!registry.itemsByName[g.item])throw new Error('존재하지 않는 아이템입니다: '+g.item);if(g.type==='build'&&!designs[g.design])throw new Error('사용 가능한 설계: 작은집, 넓은집, 창고, 전망대, 다리, 유럽풍 성');const quantity=g.quantity??1;if(!Number.isInteger(quantity)||quantity<1||quantity>512)throw new Error('수량은 1~512개여야 합니다.');const normalized={type:g.type,item:['item','store','take'].includes(g.type)?g.item:'',design:g.type==='build'?g.design:g.type==='home'?(g.design||''):'cabin',quantity};
 if(g.type==='farm'){normalized.crop=g.crop||'wheat';normalized.mode=g.mode||'setup';if(!['wheat','carrot','potato','beetroot'].includes(normalized.crop)||!['setup','harvest','continuous'].includes(normalized.mode))throw new Error('농사 작물 또는 방식 오류')}
 if(g.type==='fight'||g.type==='hunt'){normalized.mode=g.mode||'once';normalized.target=g.target||'';if(!['once','continuous'].includes(normalized.mode)||normalized.target&&!require('./combat').HOSTILES.has(normalized.target))throw new Error('전투 목표 오류')}
 if(g.type==='collect'){normalized.resource=g.resource||'logs';if(!['logs','planks','cobblestone','raw_iron','coal','sand','dirt'].includes(normalized.resource))throw new Error('채집 자원 오류')}
 if(g.type==='explore'){normalized.mode=g.mode||'once';normalized.resources=g.resources||[];if(!['once','continuous'].includes(normalized.mode)||!Array.isArray(normalized.resources)||normalized.resources.length>8||normalized.resources.some(n=>!registry.blocksByName[n]))throw new Error('탐색 자원 오류')}
 if(g.type==='home'&&normalized.design&&!['house','cabin','castle'].includes(normalized.design))throw new Error('귀환할 집 종류 오류')
 return {...normalized,reason:goalTitle(normalized)}})}
async function interpret(text,registry,signal,fetchImpl=fetch){
 if(/궁전|성당|아파트/.test(text))throw new Error('현재 지원하는 성 설계는 15×15 유럽풍 성입니다. 궁전·성당·아파트 전용 설계는 아직 없습니다.')
 const known=parseKnownGoals(text,registry);if(known)return validateGoals({goals:known},registry)
 const quick={ender_dragon:{type:'dragon'},dragon:{type:'dragon'},shelter:{type:'build',design:'cabin'},farm:{type:'farm'},castle:{type:'build',design:'castle'},survive:{type:'survive'},recover:{type:'recover'},home:{type:'home'}}
 if(quick[text])return validateGoals({goals:[quick[text]]},registry)
 if(registry.itemsByName[text])return validateGoals({goals:[{type:'item',item:text}]},registry)
 const response=await fetchImpl((process.env.QWEN_URL||'http://127.0.0.1:11434')+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.any([signal,AbortSignal.timeout(90000)]),body:JSON.stringify({model:process.env.QWEN_MODEL||'qwen3.5:9b',stream:false,think:false,options:{temperature:0,num_ctx:8192,num_predict:700},format:{type:'object',properties:{goals:{type:'array',minItems:1,maxItems:12,items:{type:'object',properties:{type:{type:'string',enum:TYPES},item:{type:'string'},design:{type:'string',enum:['',...Object.keys(designs)]},quantity:{type:'integer',minimum:1,maximum:512},reason:{type:'string'},crop:{type:'string',enum:['wheat','carrot','potato','beetroot']},mode:{type:'string'},target:{type:'string'},resource:{type:'string'},resources:{type:'array',items:{type:'string'}}},required:['type','item','design','quantity','reason']}}},required:['goals']},messages:[{role:'system',content:'Convert the Minecraft request into ordered goal objects. Do not invent capabilities or silently replace the requested outcome. type: home=return to the recorded house/base, without constructing another house; 집으로 가/기지로 돌아가 means home. For home use design empty unless explicitly asked for a castle, then castle. item=acquire/craft item and all prerequisites; build=structure; farm=plant/harvest wheat/carrot/potato/beetroot with crop and mode=setup/harvest/continuous; collect=resource collection (resource logs/planks/cobblestone/raw_iron/coal/sand/dirt); hunt=passive animal hunting; fight has optional target and mode once/continuous; explore has optional resources block names; survive=continuously maintain food/equipment and gather supplies; fight=nearby hostile combat; follow=follow player; store/take=chest deposit/withdraw; sleep=nearby bed; recover=death drops; dragon=full Ender Dragon progression; explore=exploration. item must be real Minecraft Java 1.21.1 English registry name. iron weapon means iron_sword. design cabin=small wooden house, house=larger house, warehouse=storage building, tower=lookout shell, bridge=short deck with side walls; castle=15x15 European medieval castle with four corner towers, crenellated walls, gate, courtyard and furnished keep. 성/성을/성곽/성채/캐슬/유럽풍 성/중세 성 means build,design=castle. Only this fixed castle layout is supported, no arbitrary dimensions or palaces. CRITICAL: 상자 만들어 means type=item,item=chest, NOT build/warehouse. 창고 건물 지어 means type=build,design=warehouse. For build/farm/survive/fight/follow/sleep/recover/dragon/explore the item field MUST be empty. Unsupported elaborate structures should have empty goals, not silently become cabin. Generic house request is cabin. quantity defaults 1, only explicitly requested counts. Survival is survive, not stone_pickaxe. Reasons in Korean. Multiple requested outcomes become multiple goals, no additional speculative goals. JSON only.'},{role:'user',content:text}]})});if(!response.ok)throw new Error('Qwen HTTP '+response.status);const parsed=JSON.parse((await response.json()).message?.content||'null');if(Array.isArray(parsed?.goals)&&/상자/.test(text)&&!/창고.*(?:집|건물|지어|짓)/.test(text))for(const g of parsed.goals)if(g.type==='build'&&g.item==='chest'){g.type='item';g.reason='상자를 제작합니다.'}return validateGoals(parsed,registry)
}
function createMissions(bot,hooks,file=path.join(__dirname,'logs/mission.json')){
 const {check,token:currentToken,isBusy,run,acquire,skills,world,structures,endgame,campaign,explore,log}=hooks
 const home=createHome(bot,{check,near:hooks.near,structures,log})
 let saved=null;try{saved=JSON.parse(fs.readFileSync(file))}catch{}
 let needsExplore=false,nextTickAt=0,safetyHold=false
 let state={enabled:false,continuous:saved?.continuous??hooks.continuous??false,autoRequested:saved?.autoRequested===true,phase:saved?'저장된 목표 · 이어가기 가능':'대기',request:saved?.request||'',goals:saved?.goals||[],index:saved?.index||0,steps:0,failures:0,reason:'',lastResult:null,retryAt:0,model:process.env.QWEN_MODEL||'qwen3.5:9b',roadmap:null},running=false,workKind=null,controller=null
 const nutrition=createFoodManager(bot,{check,skills,world,acquire,explore,log,policy:hooks.foodPolicy,planner:hooks.foodPlanner,goal:()=>state.goals[state.index]?.type||'survive',deaths:hooks.deaths,progress:s=>{state.phase='food';state.reason=s.reason}})
 const activity=hooks.activityPolicy?createActivityManager(bot,{...hooks,policy:hooks.activityPolicy,execute,food:(token,target,urgent)=>nutrition.step(token,{target,urgent}),context:()=>({nextTickAt,failures:state.failures})}):null
 const routine=hooks.continuous!==undefined?createRoutine(bot,{...hooks,food:(token,options)=>nutrition.step(token,options)}):null
 const items=()=>bot.inventory.items(),n=name=>items().filter(i=>i.name===name).reduce((a,i)=>a+i.count,0)
 const persist=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify({request:state.request,goals:state.goals,index:state.index,autoRequested:state.autoRequested,continuous:state.continuous}));fs.renameSync(file+'.tmp',file)}
 const snapshot=()=>campaign.snapshot({inventory:items(),equipment:bot.inventory.slots.slice(5,9).filter(Boolean),dimension:bot.game.dimension,difficulty:hooks.difficulty?.()||bot.game.difficulty})
 function view(){return {...state,workKind,routine:routine?.status(),nutrition:nutrition.status(),activity:activity?.view(state.goals[state.index],{nextTickAt,failures:state.failures}),goals:state.goals.map((g,i)=>({...g,status:i<state.index?'done':i===state.index?'active':'pending'})),campaign:bot.entity?snapshot():null,nextTickAt,farming:world.farmStatus?.(),combat:skills.combatStatus?.(),exploration:hooks.explorer?.status(),construction:(state.goals[state.index]||state.goals[state.index-1])?.type==='build'?structures.status((state.goals[state.index]||state.goals[state.index-1]).design):null}}
 function stop({preserveIntent=false,preserveContinuous=false}={}){safetyHold=false;state.enabled=false;if(!preserveIntent){state.autoRequested=false;if(!preserveContinuous)state.continuous=false}state.phase='중지 · 이어가기 가능';controller?.abort();persist()}
 function suspendForThreat(){if(!state.enabled&&!state.continuous&&!running)return null;safetyHold=true;controller?.abort();const checkpoint={request:state.request,index:state.index,enabled:state.enabled,autoRequested:state.autoRequested,continuous:state.continuous};state.phase='작업 중 위험 대응';persist();return checkpoint}
 function resumeAfterThreat(checkpoint){if(!safetyHold)return false;safetyHold=false;if(!checkpoint||state.request!==checkpoint.request||state.index!==checkpoint.index||state.autoRequested!==checkpoint.autoRequested)return false;nextTickAt=0;needsExplore=false;routine?.reset();activity?.resetRecovery();state.phase=state.enabled?'기존 목표 재개':'생활 활동 재개';persist();return state.enabled||state.continuous}
 function setContinuous(value){state.continuous=!!value;if(value){routine?.reset();state.reason='목표 사이에도 생존과 생활 활동을 이어갑니다.'}persist()}
 function deathCheckpoint(){return state.autoRequested&&state.index<state.goals.length?{kind:'mission',request:state.request,index:state.index}:null}
 async function start(text){if(running||isBusy())throw new Error('진행 중인 작업을 먼저 중지해 주세요.');safetyHold=false;state.enabled=false;state.autoRequested=false;controller=new AbortController();state.phase='목표 해석 중';running=true;const token=currentToken();try{const goals=text==='이어가기'&&state.goals.length?state.goals:await interpret(text,bot.registry,controller.signal);check(token);if(text!=='이어가기'){state.goals=goals;state.index=0;state.request=text}hooks.cancelPath?.();state.enabled=true;state.autoRequested=true;if(hooks.continuous===true)state.continuous=true;state.retryAt=0;state.failures=0;needsExplore=false;nextTickAt=0;state.phase='계획 준비';state.reason='관측한 재료와 실제 제작법으로 선행 작업을 계산합니다.';persist();log({type:'goal',request:text,target:goals.map(g=>g.type).join(', '),reason:state.reason})}catch(e){if(!controller.signal.aborted){state.phase='목표 확인 필요';state.reason=e.message;log({type:'message',text:e.message})}}finally{running=false;controller=null}}
 async function food(token,target=16){const result=await nutrition.step(token,{target});if(result.waiting)nextTickAt=result.nextCheck;return result.ready}
 async function campaignStep(token){const c=snapshot(),ach=id=>c.stages.find(s=>s.id===id)?.achieved;
 if(c.complete)return true
 if(!c.stages[0].ready){await acquire('stone_pickaxe',1,token);return false}
 if(c.food<8){await food(token);return false}
 if(c.blocks<64){await acquire('cobblestone',64,token);return false}
 for(const item of ['iron_pickaxe','iron_sword','shield','iron_helmet','iron_chestplate','iron_leggings','iron_boots'])if(!n(item)&&!bot.inventory.slots.slice(5,9).some(i=>i?.name===item||(item==='iron_boots'&&i?.name==='golden_boots'))){state.reason='장비 준비: '+item;await acquire(item,1,token);return false}
 await skills.equip(token)
 if((hooks.difficulty?.()||bot.game.difficulty)==='peaceful')await hooks.ensureDifficulty?.(token)
 if(bot.game.dimension.includes('the_nether')&&n('golden_boots'))await bot.equip(items().find(i=>i.name==='golden_boots'),'feet')
 if(bot.game.dimension.includes('the_end')){if(Object.values(bot.entities).some(e=>e.name==='end_crystal'))await endgame.crystals(token);else await endgame.dragon(token);return false}
 if(!ach('blaze')){if(!bot.game.dimension.includes('the_nether')){await acquire('golden_boots',1,token);await bot.equip(items().find(i=>i.name==='golden_boots'),'feet');await endgame.buildPortal(token);await endgame.travel(token);return false}if((hooks.difficulty?.()||bot.game.difficulty)==='peaceful')throw new Error('평화로움에서는 블레이즈가 나오지 않습니다. 일반 난이도가 필요합니다.');if(!Object.values(bot.entities).some(e=>e.name==='blaze'))await endgame.fortress(token);else await acquire('blaze_rod',8,token);return false}
 if(!ach('pearls')&&n('ender_eye')<16){if(Object.values(bot.entities).some(e=>e.name==='enderman'))await acquire('ender_pearl',16,token);else if(bot.game.dimension.includes('the_nether'))await endgame.barter(token);else await explore(token);return false}
 if(bot.game.dimension.includes('the_nether')){await endgame.travel(token);return false}
 if(!ach('eyes')){await acquire('ender_eye',16,token);return false}
 if(!ach('stronghold')){await endgame.stronghold(token);return false}
 await endgame.enterEnd(token);return false
 }
 async function execute(g,token){switch(g.type){case 'home':await home.go(token,g);return true;case 'item':await acquire(g.item,g.quantity,token);return n(g.item)>=g.quantity;case 'build':return (await structures.build(g.design,token)).complete;case 'farm':{const before=world.farmStatus().farms.find(f=>f.crop===g.crop)?.harvested||0;if(g.harvestStart==null)g.harvestStart=before;const result=await world.farm(token,{crop:g.crop});state.reason=`${result.title}: ${result.planted}/${result.plots} 파종 · 익음 ${result.ripe} · 누적 수확 ${result.harvested}개`;nextTickAt=result.waiting?result.nextCheck:Date.now()+2000;return g.mode==='continuous'?false:g.mode==='harvest'?result.harvested-g.harvestStart>=g.quantity:result.complete}
 case 'fight':{const result=await skills.defend(token,{target:g.target});if(result.waiting){state.reason='주변에 대상이 없어 경계 중입니다.';nextTickAt=result.nextCheck;return false}g.killed=(g.killed||0)+(result.killed?1:0);return g.mode!=='continuous'&&g.killed>=g.quantity}
 case 'hunt':await skills.hunt(token);g.killed=(g.killed||0)+1;return g.mode!=='continuous'&&g.killed>=g.quantity;
 case 'collect':{if(g.resource==='logs'){const names=Object.keys(bot.registry.blocksByName).filter(n=>n.endsWith('_log'));await hooks.collector.collect(names,names,g.quantity,token)}else if(g.resource==='planks')await hooks.planks(g.quantity,token);else await acquire(g.resource,g.quantity,token);return true}case 'follow':await hooks.follow(token);return true;case 'store':case 'take':if(g.type==='store')await acquire(g.item,g.quantity,token);await world.storage(g.type==='take'?'take':'store',g.item,g.quantity,token);return true;case 'sleep':await world.sleepInBed(token);return true;case 'recover':await world.recover(snapshot().lastDeath,token);return true;case 'explore':{const result=await explore(token,{resources:g.resources});const found=result?.resourceLocations?.length>0;state.reason=found?'요청한 자원의 실제 좌표를 확인했습니다.':g.resources.length?'아직 자원을 찾지 못해 미방문 지형을 계속 조사합니다.':'미방문 지형을 조사했습니다.';nextTickAt=Date.now()+2000;return g.mode!=='continuous'&&(!g.resources.length||found)}case 'dragon':return campaignStep(token);case 'survive':await skills.equip(token);if(!(await food(token)))return false;else if(!n('stone_pickaxe')&&!n('iron_pickaxe'))await acquire('stone_pickaxe',1,token);else await explore(token);return false;default:throw new Error('실행할 작업이 없습니다.')}}
 function roadmap(g){if(g.type==='build'&&g.design==='castle'){const build=structures.status(g.design);return {target:'build',summary:'15×15 유럽풍 성: 부지 확인 후 기초·성벽·네 탑·본관·지붕·가구를 짓습니다. 부족한 재료는 제작법을 따라 나눠 확보하고 이미 설치한 부분은 보존합니다.',inventory:items().map(i=>({name:i.name,count:i.count})),steps:build.stages.map(s=>({title:`${s.title} · ${s.built}/${s.total}`,status:s.complete?'done':'pending',materials:Object.entries(s.remainingMaterials).map(([item,need])=>({item,need,have:n(item),missing:Math.max(0,need-n(item))}))})),ironLocations:[],locationNote:build.origin?`(${build.origin.x}, ${build.origin.y}, ${build.origin.z})`: '성 건축에 필요한 15×15 부지를 찾습니다.'}}const tree=g.type==='item'?materialPlan(g.item,g.quantity,items()):null;const steps=[];function visit(node){for(const child of node.children)visit(child);steps.push({title:node.item+' '+node.need+'개 · '+(node.method||'확보'),status:node.missing?'pending':'done',materials:[{item:node.item,have:node.have,need:node.need,missing:node.missing}]})}if(tree)visit(tree);else for(let i=0;i<state.goals.length;i++)steps.push({title:state.goals[i].reason||state.goals[i].type,status:i<state.index?'done':'pending',materials:[]});return {target:g.type,summary:g.reason||'현재 상태를 확인하고 필요한 작업을 순서대로 실행합니다.',inventory:items().map(i=>({name:i.name,count:i.count})),steps,ironLocations:[],locationNote:'관측한 지형만 사용합니다. 자원이 없으면 탐색 후 다시 계획합니다.'}}
 async function tick(){
  if(safetyHold||(!state.enabled&&!state.continuous)||running||isBusy()||hooks.commandPending?.())return
  if(!state.enabled&&state.autoRequested&&state.continuous&&Date.now()>=state.retryAt&&bot.health>=12){state.enabled=true;state.failures=0;needsExplore=true;state.phase='기존 목표 자동 재시도';log({type:'goal_retry',request:state.request,index:state.index});persist()}
  const hungry=bot.food<18,foodState=nutrition.status()
  const active=state.goals[state.index],danger=activity?.supports(active)&&(bot.health<8||dangerous(activity.observe(active,{nextTickAt,failures:state.failures})))
  const growthDecision=!hungry&&activity?.waitNeedsDecision(active,{nextTickAt,failures:state.failures})
  const yielding=state.enabled&&Date.now()<nextTickAt&&!danger&&!growthDecision&&!(hungry&&(foodState.available>0||Date.now()>=foodState.nextCheck))
  if((!state.enabled||yielding)&&state.continuous&&routine){
   running=true;workKind='routine';const token=currentToken(),oldPhase=state.phase
   try{check(token);const result=await run(()=>routine.step(token));check(token);state.phase=oldPhase;if(result.ok&&!['survey','heal'].includes(result.action))activity?.resetRecovery();if(state.autoRequested&&!state.enabled&&!state.retryAt)state.retryAt=Date.now()+15000}
   catch(error){if(token===currentToken())log({type:'routine_error',error:error.message})}finally{running=false;workKind=null}
   return
  }
  if(!state.enabled||yielding)return
  running=true;const token=currentToken();let action,activityReason=null
  try{
   check(token);const g=state.goals[state.index];if(!g){state.enabled=false;state.autoRequested=false;state.phase='목표 완료';persist();return}
   state.roadmap=roadmap(g);const wasRecovery=needsExplore;action=hungry?'food':g.type;state.phase=action;state.steps++
   log({type:'plan',action,reason:state.reason||g.reason,observation:{inventory:items().map(i=>({name:i.name,count:i.count})),position:bot.entity.position,goal:g}})
   await run(async()=>{
    if(hungry&&!(activity?.supports(g)&&dangerous(activity.observe(g,{nextTickAt,failures:state.failures})))){const result=await nutrition.step(token,{target:1,urgent:true});nextTickAt=result.waiting?result.nextCheck:Date.now()+2000;needsExplore=false;return}
    if(activity?.supports(g)){
     const result=await activity.step(g,token,{nextTickAt,failures:state.failures});check(token);needsExplore=false;action=result.action;state.reason=result.reason;activityReason=result.reason
     if(result.nextCheck)nextTickAt=result.nextCheck
     if(result.paused){state.enabled=false;state.phase=state.continuous?'목표 복구 중 · 생활 활동 계속':'복구 대기 · 이어가기 가능';state.retryAt=Date.now()+30000}
     if(result.complete)state.index++
     return
    }
    if(bot.health<8)throw new Error('체력이 낮아 회복과 주변 확인이 필요합니다.')
    if(needsExplore&&!['store','take','sleep','recover','home'].includes(g.type)){state.phase='실패 경로 우회';needsExplore=false;action='explore';await explore(token);return}
    if(await execute(g,token)){check(token);state.index++}
   })
   check(token);persist();state.lastResult=activityReason||(state.phase==='food'?nutrition.status().reason:'작업 단계 실행됨');state.roadmap=roadmap(g)
   if(!wasRecovery||hungry)state.failures=0
   if(state.index>=state.goals.length){state.enabled=false;state.autoRequested=false;state.phase='목표 완료';persist()}
   log({type:'plan_result',action:state.phase==='food'?'food':action,ok:true})
  }catch(e){if(token!==currentToken())return;state.lastResult=e.message;state.reason=e.message;state.failures++;needsExplore=!needsExplore;log({type:'plan_result',action,ok:false,error:e.message});if(e.code==='HOME_UNKNOWN'){state.enabled=false;state.autoRequested=false;state.phase='집 위치 확인 필요';persist()}else if(state.failures>=6||/평화로움|체력이 낮/.test(e.message)){state.enabled=false;state.phase=state.continuous?'목표 복구 중 · 생활 활동 계속':'복구 대기 · 이어가기 가능';state.retryAt=Date.now()+30000;persist()}else state.phase='원인 확인 후 재시도'}finally{running=false}
 }
 return {start,stop,tick,view,setContinuous,deathCheckpoint,suspendForThreat,resumeAfterThreat,recoverFood:token=>nutrition.step(token,{target:1,urgent:true}),isRunning:()=>running,wantsWork:()=>state.enabled||state.continuous||running,isMaintenanceRunning:()=>workKind==='routine',isActive:()=>state.enabled||running,hasGoal:()=>!!state.goals.length}
}
module.exports={createMissions,validateGoals,interpret,TYPES,parseKnownGoals}
