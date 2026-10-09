const $=id=>document.getElementById(id)
const labels={defend:'위험 대응',food:'식량 확보·섭취',collect:'자원 채집',hunt:'동물 사냥',item:'재료 확보·제작',build:'건축',farm:'농사',survive:'생존 관리',fight:'전투',store:'상자 보관',take:'상자 꺼내기',sleep:'수면',recover:'아이템 회수',dragon:'드래곤 진행',mission:'목표 실행',follow:'따라오기',come:'이리 오기',wood:'나무 수집',wooden_pickaxe:'나무곡괭이',stone_pickaxe:'돌곡괭이',iron_pickaxe:'철곡괭이',status:'상태 확인',stop:'중지',unknown:'기타 / 미지원',idle:'작업 사이 · 상황 확인',explore:'주변 탐색',gather_stone:'돌 수집',planning:'Qwen 판단 중',iron_sword:'철검 제작',prepare_furnace:'화로 준비',gather_iron:'철 원석 수집',smelt_iron:'철 제련',shelter:'작은 나무 대피소',find_site:'건축 부지 조사',building_materials:'건축 재료 준비',build_shelter:'대피소 건축'}
let currentId=null,viewerActive=false,lastEventId=null,requestBusy=false
const policyLabels={eat:'식량 섭취',cook:'조리',bread:'빵 제작',hunt:'사냥',farm:'농사·수확',explore:'식량 탐색',wait:'작물 성장 대기',continue:'기존 목표 진행',stop:'회복 대기'}
const activityLabels={food:'식량 회복',farm:'농사·수확',wait:'성장·대상 대기',survey:'건축 부지 조사',gather:'부족한 준비물 확보',build:'건축 진행',collect:'목표 자원 채집',search:'지형·자원 탐색',fight:'적대 몹 전투',retreat:'안전한 곳으로 퇴각',finish:'목표 달성 확인',pause:'중지·상태 확인'}
let activityId=null,activityPinned=false,activityRequestBusy=false
function renderActivity(event){
 if(!event||activityPinned&&activityId!==event.id)return
 activityId=event.id;const s=event.observation
 $('activitySource').textContent=(event.preview?'상황 미리보기 · ':'자동 진행 · ')+(labels[s.domain]||s.domain)+(event.source==='laya'?' · 학습된 Laya':' · 기본 복구 경로')
 $('activityAction').textContent=activityLabels[event.action]||event.action;$('activityProbability').textContent=event.source==='laya'&&Number.isFinite(event.confidence)?(event.confidence*100).toFixed(1)+'%':'—'
 $('activityLatency').textContent=event.latency_ms+' ms'
 let detail=`체력 ${s.health}/20 · 허기 ${s.hunger}/20`
 if(s.domain==='build')detail+=` · ${s.siteKnown?'부지 확보':'부지 조사 필요'} · ${s.suppliesMissing?'준비물 부족':'다음 작업 재료 준비됨'} · 설치 ${s.built}블록`
 if(s.domain==='farm')detail+=` · 익은 작물 ${s.ripe} · 누적 수확 ${s.harvested}`+(s.growing?' · 작물 성장 중':'')+(s.suppliesMissing?' · 준비물 부족':'')
 if(s.domain==='collect')detail+=` · 보유 ${s.have}/${s.target}개 · 자원 후보 ${s.sources}곳 · ${s.toolReady?'도구 사용 가능':'도구 준비 필요'}`
 if(s.domain==='explore')detail+=` · ${s.found?'요청 자원 발견':'자원 미발견'} · 방문 ${s.visited}구역`
 if(s.domain==='fight')detail+=` · 대상 적 ${s.threats}마리 · 가까운 적 ${s.closeThreats}마리 · ${s.weaponReady?'무기 준비됨':'무기 필요'}`
 if(s.blocked?.length)detail+=' · 실패 경로: '+s.blocked.map(a=>activityLabels[a]||a).join(', ')
 if(event.error)detail+=' · '+event.error
 $('activityObservation').textContent=detail;$('activityLabel').replaceChildren()
 for(const action of event.allowed||[])$('activityLabel').append(new Option(activityLabels[action]||action,action))
 $('activityLabel').value=event.action;$('activityLabel').disabled=false;$('activityCorrect').disabled=activityRequestBusy||!$('activityLabel').value
}
$('activityLabel').onfocus=()=>{activityPinned=true}
$('activityTest').onclick=async()=>{
 activityRequestBusy=true;$('activityTest').disabled=true;$('activityCorrect').disabled=true
 try{const result=await post('activity/analyze',{domain:$('activityDomain').value});activityPinned=false;renderActivity(result.decision);$('activityNotice').textContent='현재 관측 상태로 선택한 목표를 판단했습니다. 실제 행동은 실행하지 않았습니다.'}
 catch(e){$('activityNotice').textContent=e.message}
 finally{activityRequestBusy=false;await refresh()}
}
$('activityCorrect').onclick=async()=>{
 if(!activityId||!$('activityLabel').value)return
 activityRequestBusy=true;$('activityCorrect').disabled=true
 try{await post('activity/correct',{id:activityId,label:$('activityLabel').value});activityPinned=false;$('activityNotice').textContent='상황과 교정 정답을 저장했습니다. 다음 지도학습에 반영됩니다.'}
 catch(e){$('activityNotice').textContent=e.message}
 finally{activityRequestBusy=false;await refresh()}
}
let currentPolicyId=null,policyReviewPinned=false,policyRequestBusy=false
function renderPolicy(event){
 if(!event||policyReviewPinned&&currentPolicyId!==event.id)return
 currentPolicyId=event.id
 $('policySource').textContent=event.source==='qwen'?'Qwen 식량 계획 · '+(event.plan?.reason||''):event.source==='laya'?'학습된 Laya의 선택':'기본 복구 경로 · '+(event.error||'모델 판단을 검증하지 못했습니다.')
 $('policyAction').textContent=policyLabels[event.action]||event.action
 $('policyProbability').textContent=event.source==='laya'&&Number.isFinite(event.confidence)?(event.confidence*100).toFixed(1)+'%':'—'
 $('policyLatency').textContent=event.latency_ms+' ms'
 const s=event.observation||{}
 $('policyObservation').textContent=`판단 당시: 체력 ${s.health}/20 · 허기 ${s.hunger}/20 · 먹을 식량 ${s.safe}개 · 생재료 ${s.raw}개 · 밀 ${s.wheat}개 · 주변 동물 ${s.prey}마리 · 익은 작물 ${s.ripe}개`+(s.growing?' · 작물 성장 중':'')
 $('policyLabel').replaceChildren()
 for(const action of event.allowed||[])$('policyLabel').append(new Option(policyLabels[action]||action,action))
 $('policyLabel').value=event.action;$('policyLabel').disabled=false;$('policyCorrect').disabled=policyRequestBusy||!$('policyLabel').value
}
$('policyLabel').onfocus=()=>{policyReviewPinned=true}
$('policyTest').onclick=async()=>{
 policyRequestBusy=true;$('policyTest').disabled=true;$('policyCorrect').disabled=true
 try{const result=await post('policy/analyze');policyReviewPinned=false;renderPolicy(result.decision);$('policyNotice').textContent='현재 관측 상태의 판단입니다. 게임 행동은 실행하지 않았습니다.'}
 catch(e){$('policyNotice').textContent=e.message}
 finally{policyRequestBusy=false;await refresh()}
}
$('policyCorrect').onclick=async()=>{
 if(!currentPolicyId||!$('policyLabel').value)return
 policyRequestBusy=true;$('policyCorrect').disabled=true
 try{await post('policy/correct',{id:currentPolicyId,label:$('policyLabel').value});policyReviewPinned=false;$('policyNotice').textContent='교정 정답을 저장했습니다. 다음 학습에 반영됩니다.'}
 catch(e){$('policyNotice').textContent=e.message}
 finally{policyRequestBusy=false;await refresh()}
}
for(const [value,label] of Object.entries(labels)){if(['food','collect','hunt','item','build','farm','survive','fight','store','take','sleep','recover','dragon','mission'].includes(value))continue;if(['idle','explore','gather_stone','planning','iron_sword','prepare_furnace','gather_iron','smelt_iron','shelter','find_site','building_materials','build_shelter'].includes(value))continue;const o=document.createElement('option');o.value=value;o.textContent=label;$('label').append(o)}
function notice(text,error=false){$('notice').textContent=text;$('notice').style.color=error?'#ffb3ad':'#b8d797'}
async function post(route,data={}){const r=await fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Laya-Control':'1'},body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});const result=await r.json();if(!r.ok)throw new Error(result.error||'요청 실패');return result}
function renderDecision(event){
 if(!event)return
 currentId=event.id;$('utterance').textContent=event.command;$('choice').textContent=labels[event.answer.choice]||event.answer.choice
 $('probability').textContent=((event.answer.probabilities[event.answer.choice]||0)*100).toFixed(1)+'%'
 $('latency').textContent=event.latency_ms+' ms';$('label').value=event.answer.choice;$('correct').disabled=false
 $('probabilities').replaceChildren()
 for(const [label,p] of Object.entries(event.answer.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,4)){
  const row=document.createElement('div');row.className='prob-row';const title=document.createElement('label'),name=document.createElement('span'),value=document.createElement('span');name.textContent=labels[label]||label;value.textContent=(p*100).toFixed(1)+'%';title.append(name,value);const track=document.createElement('div'),fill=document.createElement('div');track.className='track';fill.className='fill';fill.style.width=Math.max(0,Math.min(100,p*100))+'%';track.append(fill);row.append(title,track);$('probabilities').append(row)
 }
}
function renderEvents(events){
 const last=events.at(-1)?.id||events.at(-1)?.time
 if(last===lastEventId)return;lastEventId=last
 $('events').replaceChildren()
 for(const event of events.filter(e=>['threat_response','death_recovery','decision','activity_decision','activity_outcome','activity_correction','policy_decision','policy_outcome','policy_correction','message','task_start','task_result','correction','error','kicked','plan','plan_result','goal','routine_action','routine_result','routine_error','goal_retry'].includes(e.type)).slice(-18).reverse()){
  const row=document.createElement('div');row.className='event';const time=document.createElement('time');time.textContent=new Date(event.time).toLocaleTimeString('en-GB',{hour12:false});const content=document.createElement('div');
  const title=document.createElement('div'),detail=document.createElement('div');detail.className='detail'
  if(event.type==='threat_response'){title.textContent='작업 중 위험 대응 · '+event.phase;detail.textContent=event.reason}
  else if(event.type==='death_recovery'){title.textContent='사망 후 복구 · '+event.phase;detail.textContent=event.reason}
  else if(event.type==='routine_action'){title.textContent='자율생활 · '+event.action;detail.textContent=event.reason}
  else if(event.type==='routine_result'){title.textContent=event.ok?'생활 활동 수행':'다른 생활 경로 선택';detail.textContent=event.error||`${event.action} · ${(event.elapsed_ms/1000).toFixed(1)}초`}
  else if(event.type==='goal_retry'){title.textContent='저장된 목표 자동 재시도';detail.textContent=event.request}
  else if(event.type==='goal'){title.textContent='목표 해석 · '+(labels[event.target]||event.target);detail.textContent=event.request+' → '+event.reason}
  else if(event.type==='plan'){title.textContent='다음 작업 · '+(labels[event.action]||event.action);detail.textContent=event.reason}
  else if(event.type==='plan_result'){title.textContent=event.ok?'작업 단계 성공':'작업 단계 실패';detail.textContent=event.error||labels[event.action]||event.action}
  else if(event.type==='decision'){title.textContent='판단 · '+(labels[event.answer.choice]||event.answer.choice);detail.textContent=event.command}
  else if(event.type==='activity_decision'){title.textContent=(event.preview?'행동 미리보기':event.source==='laya'?'Laya 다음 행동':'기본 복구 판단')+' · '+(activityLabels[event.action]||event.action);detail.textContent=(labels[event.observation.domain]||event.observation.domain)+(event.error?' · '+event.error:'')}
  else if(event.type==='activity_outcome'){title.textContent=(event.ok?'행동 완료':'행동 중단')+' · '+(activityLabels[event.action]||event.action);detail.textContent=event.error||`설치 ${event.observation.built} → ${event.after.built} · 수확 ${event.observation.harvested} → ${event.after.harvested} · 보유 ${event.observation.have} → ${event.after.have}`}
  else if(event.type==='activity_correction'){title.textContent='다음 행동 정답 교정';detail.textContent=activityLabels[event.label]||event.label}
  else if(event.type==='policy_decision'){title.textContent=(event.source==='laya'?'Laya 상황 판단':'기본 복구 판단')+' · '+(policyLabels[event.action]||event.action);detail.textContent=`허기 ${event.observation.hunger}/20 · 식량 ${event.observation.safe}개`+(event.error?' · '+event.error:'')}
  else if(event.type==='policy_outcome'){title.textContent=(event.ok?'식량 행동 완료':'식량 행동 중단')+' · '+(policyLabels[event.action]||event.action);detail.textContent=event.error||`허기 ${event.observation.hunger} → ${event.after.hunger} · 식량 ${event.observation.safe} → ${event.after.safe}개`}
  else if(event.type==='policy_correction'){title.textContent='상황 판단 정답 교정';detail.textContent=policyLabels[event.label]||event.label}
  else if(event.type==='task_start'){title.textContent='작업 시작 · '+(labels[event.action]||event.action);detail.textContent=event.text}
  else if(event.type==='task_result'){title.textContent=event.ok?'작업 완료':'작업 중단';detail.textContent=event.error||`${(event.elapsed_ms/1000).toFixed(1)}초`}
  else if(event.type==='correction'){title.textContent='정답 교정 저장';detail.textContent=labels[event.label]||event.label}
  else{title.textContent=event.type==='error'?'연결 / 실행 알림':'라야';detail.textContent=event.text||event.error||JSON.stringify(event.reason)}
  content.append(title,detail);row.append(time,content);$('events').append(row)
 }
}
const itemLabels={planks_equivalent:'판자로 바꿀 수 있는 목재',planks:'판자',stick:'막대기',cobblestone:'조약돌',raw_iron_or_ingot:'철 원석 또는 주괴',raw_iron:'철 원석',iron_ingot:'철 주괴',fuel_planks:'연료용 판자',furnace:'화로',dark_oak_log:'짙은 참나무 원목',dark_oak_planks:'짙은 참나무 판자',dirt:'흙',wooden_pickaxe:'나무곡괭이',stone_pickaxe:'돌곡괭이',iron_pickaxe:'철곡괭이',iron_sword:'철검'}
let lastRoadmap=''
function renderRoadmap(plan){
 const key=JSON.stringify(plan);if(key===lastRoadmap)return;lastRoadmap=key
 const root=$('roadmap');root.replaceChildren();if(!plan)return
 const heading=document.createElement('b');heading.textContent='실행 계획 · '+(labels[plan.target]||plan.target);root.append(heading)
 const summary=document.createElement('p');summary.textContent=plan.summary||(plan.steps.every(s=>s.status==='done')?'목표 아이템이 인벤토리에 있어 계획을 완료했습니다.':'현재 재료와 제작 순서를 확인하고 있어요.');root.append(summary)
 const inventory=document.createElement('p');inventory.textContent='현재 소지품: '+(plan.inventory.map(i=>`${itemLabels[i.name]||i.name} × ${i.count}`).join(', ')||'없음');root.append(inventory)
 const location=document.createElement('p');location.textContent=(['shelter','build'].includes(plan.target)?'건축 위치: ':plan.target==='item'?'자원 위치: ':'주변 환경: ')+plan.locationNote+(plan.ironLocations.length?' '+plan.ironLocations.map(b=>`(${b.position.x}, ${b.position.y}, ${b.position.z}) · ${b.distance}블록`).join(' / '):'');root.append(location)
 const list=document.createElement('ol');for(const step of plan.steps){const row=document.createElement('li');row.className=step.status;row.textContent=(step.status==='done'?'✓ ':'')+step.title;if(step.status!=='done'){const detail=document.createElement('small');detail.textContent=step.materials.map(m=>`${itemLabels[m.item]||m.item}: 보유 ${m.have} / 필요 ${m.need} (부족 ${m.missing})`).join(' · ');row.append(detail)}list.append(row)}root.append(list)
}
async function refresh(){
 try{
  const r=await fetch('/api/state',{signal:AbortSignal.timeout(4000)});if(!r.ok)throw new Error('상태 확인 실패');const s=await r.json()
  $('modelStatus').textContent=s.model.ready?'● 모델 실행 중':'모델 연결 대기';$('modelStatus').classList.toggle('online',s.model.ready)
  $('botStatus').textContent=s.ready?'● 봇 접속 중':s.wanted?'봇 재접속 대기':'봇 미접속';$('botStatus').classList.toggle('online',s.ready)
  $('connect').disabled=s.wanted;$('disconnect').disabled=!s.wanted
  $('execute').disabled=!s.ready||(s.busy&&s.auto?.workKind!=='routine')||requestBusy;$('stop').disabled=!s.wanted
  $('analyze').disabled=!s.model.ready||requestBusy
  $('routineStatus').textContent=s.auto?.continuous?'생활 활동 켜짐':'생활 활동 꺼짐';$('routineToggle').textContent=s.auto?.continuous?'자율생활 끄기':'자율생활 켜기';$('routineToggle').dataset.enabled=String(!!s.auto?.continuous);$('routineToggle').disabled=!s.ready;$('routineDetails').textContent=s.auto?.routine?`${s.auto.routine.phase} · ${s.auto.routine.reason} · 수행 ${s.auto.routine.steps}회`:'목표가 끝나거나 잠시 막혀도 식량·도구·농장·주변 탐색을 이어갑니다.';
  $('autoStatus').textContent=s.threatResponse?.active?'위험 대응 · '+s.threatResponse.phase:s.recovery?.active?'사망 후 복구 · '+s.recovery.phase:s.auto?.workKind==='routine'?'생활 활동 · '+s.auto.routine.phase:s.auto?.enabled?'진행 중 · '+(labels[s.auto.phase]||s.auto.phase):s.auto?.continuous?'자율생활 진행 중 · '+(s.auto.routine?.phase||'상황 확인'):(s.auto?.phase||'꺼짐');$('autoStart').disabled=!s.ready||(s.busy&&s.auto?.workKind!=='routine')||(s.auto?.enabled&&s.auto?.workKind!=='routine')||s.recovery?.active;$('autoStop').disabled=!s.wanted||(!s.auto?.enabled&&!s.auto?.continuous&&!s.recovery?.active&&s.auto?.phase!=='목표 해석 중');
  $('activeGoal').textContent=s.auto?.request?'요청한 목표: '+s.auto.request:'아직 지정한 목표가 없어요.';
  renderRoadmap(s.auto?.roadmap);renderMission(s);renderActivities(s);window.renderMinimap?.(s);
  const threat=s.threatResponse,held=threat?.checkpoint?.mission;$('threatStatus').textContent=threat?`${threat.phase} · ${threat.reason}${held?.request?' · 보존된 목표: '+held.request+' / '+(held.index+1)+'번째 단계':''} · 자동 재개 ${threat.resumptions||0}회`:'작업 중 위험 감시';
  const recovery=s.recovery;$('recoveryStatus').textContent=recovery?.phase||'대기';$('recoveryReason').textContent=recovery?.reason||'사망하면 리스폰 후 위험을 확인하고 아이템 회수와 기존 목표 재개를 시도합니다.'
  const death=recovery?.death,p=death?.position;$('recoveryDetails').textContent=death?`사망 위치: ${death.dimension} (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}) · 회수 시도 ${recovery.attempts}회 · ${recovery.resumeRequested?`재개할 목표: ${recovery.resume?.request||'기존 목표'} · ${(recovery.resume?.index||0)+1}번째 작업`:'자동 재개 없음'}`:''
  $('planReason').textContent=s.auto?.reason||'목표·상황 판단 대기';$('planResult').textContent=`목표 단계 ${s.auto?.steps||0}회 · 최근 결과: ${s.auto?.lastResult||'—'}`;
  $('health').textContent=s.ready?`${s.health??'—'} / 20`:'—';$('food').textContent=s.ready?`${s.food??'—'} / 20`:'—';$('job').textContent=labels[s.job]||s.job
  $('coords').textContent=s.ready&&s.position?`X ${s.position.x.toFixed(1)}  Y ${s.position.y.toFixed(1)}  Z ${s.position.z.toFixed(1)}`:'연결 대기'
  $('waitingTitle').textContent=s.wanted?'마크 서버에 연결하는 중':'세계에 들어갈 준비 중'
  $('waitingText').textContent=s.wanted?'서버가 켜지면 자동으로 다시 접속합니다.':'마크 서버를 켜고 ‘봇 연결’을 누르면 라야가 보는 풍경이 여기에 나타납니다.'
  if(s.ready&&s.viewerReady&&!viewerActive){$('viewer').src='/view/';viewerActive=true}
  if((!s.ready||!s.viewerReady)&&viewerActive){$('viewer').removeAttribute('src');viewerActive=false}
  $('viewer').hidden=!viewerActive;$('waiting').hidden=viewerActive
  const players=JSON.stringify(s.players||[])
  if($('player').dataset.list!==players){const selected=$('player').value;$('player').replaceChildren(new Option('근처 플레이어',''));for(const p of s.players||[])$('player').append(new Option(p,p));$('player').value=(s.players||[]).includes(selected)?selected:'';$('player').dataset.list=players}
  renderInventory(s)
  if(s.report){$('before').textContent=(s.report.before_accuracy*100).toFixed(1)+'%';$('after').textContent=(s.report.after_accuracy*100).toFixed(1)+'%'}
  $('correctionCount').textContent=s.corrections+'개';renderEvents(s.events)
  $('policyTest').disabled=!s.ready||policyRequestBusy
  $('policyCorrect').disabled=policyRequestBusy||!currentPolicyId||!$('policyLabel').value
  if(s.policyReport){const p=s.policyReport;$('policyTraining').textContent=`지도학습 · 별도 합성 상태 ${p.eval_rows}개: ${(p.before_accuracy*100).toFixed(1)}% → ${(p.after_accuracy*100).toFixed(1)}% · 교정 ${s.policyCorrections||0}개. 실제 게임 성공률과는 다릅니다.`}
  const policy=s.events.filter(e=>e.type==='policy_decision'&&e.id).at(-1);if(policy&&policy.id!==currentPolicyId)renderPolicy(policy)
  $('activityTest').disabled=!s.ready||!s.activityModel?.ready||activityRequestBusy
  $('activityCorrect').disabled=activityRequestBusy||!activityId||!$('activityLabel').value
  if(s.activityReport){const p=s.activityReport;$('activityTraining').textContent=`지도학습 · 별도 합성 상태 ${p.eval_rows}개: ${(p.before_accuracy*100).toFixed(1)}% → ${(p.after_accuracy*100).toFixed(1)}% · 교정 ${s.activityCorrections||0}개 · 검토 예시 ${s.activityReviewed||0}개. 실제 게임 성공률과는 다릅니다.`}
  const activity=s.events.filter(e=>e.type==='activity_decision'&&e.id).at(-1);if(activity&&activity.id!==activityId)renderActivity(activity)
  const decision=s.events.filter(e=>e.type==='decision'&&e.id).at(-1);if(decision&&decision.id!==currentId)renderDecision(decision)
 }catch(e){$('botStatus').textContent='웹 연결 확인 중';$('execute').disabled=true;$('stop').disabled=true;$('analyze').disabled=true;$('policyTest').disabled=true;$('policyCorrect').disabled=true;$('activityTest').disabled=true;$('activityCorrect').disabled=true}
}
async function act(route,data,message){try{await post(route,data);notice(message);await refresh()}catch(e){notice(e.message,true)}}
$('autoForm').onsubmit=e=>{e.preventDefault();const text=$('autoGoal').value.trim();if(!text)return notice('자동 진행 목표를 입력해 주세요.',true);void act('command',{text:'!auto '+text},'목표를 해석하고 현재 상황을 확인합니다. 아래 진행 상태를 확인해 주세요.')}
for(const button of document.querySelectorAll('[data-goal]'))button.onclick=()=>{$('autoGoal').value=button.dataset.goal;$('autoGoal').focus()}
$('autoStop').onclick=()=>act('command',{text:'!stop'},'자동 진행을 중지합니다.')
$('connect').onclick=()=>act('connect',{},'봇 연결을 시작했습니다. 서버가 꺼져 있으면 15초마다 재시도합니다.')
$('disconnect').onclick=()=>act('disconnect',{},'봇 연결을 해제했습니다.')
$('stop').onclick=()=>act('command',{text:'!stop'},'중지 요청을 보냈습니다.')
async function submit(analyze){const text=$('command').value.trim();if(!text)return notice('명령을 입력해 주세요.',true);requestBusy=true;await refresh();try{await post(analyze?'analyze':'command',{text,player:$('player').value});notice(analyze?'판단 완료. 게임 행동은 실행하지 않았습니다.':'명령을 보냈습니다. 활동 기록을 확인해 주세요.')}catch(e){notice(e.message,true)}finally{requestBusy=false;await refresh()}}
$('commandForm').onsubmit=e=>{e.preventDefault();void submit(false)}
$('analyze').onclick=()=>submit(true)
$('correct').disabled=true;$('correct').onclick=()=>{if(currentId)void act('correct',{id:currentId,label:$('label').value},'정답을 저장했습니다. 다음 학습 때 반영됩니다.')}
for(const button of document.querySelectorAll('[data-command]'))button.onclick=()=>{$('command').value=button.dataset.command;$('command').focus()}
async function poll(){await refresh();setTimeout(poll,1500)}poll()

let inventoryKey='',selectedItemSlot=null,lastInventoryState=null,detailRequest=0
function itemName(item){return itemLabels[item.name]||item.displayName||item.name}
async function showItem(slot){
 const requestId=++detailRequest
 selectedItemSlot=slot;const item=lastInventoryState?.slots?.[slot]
 $('itemDetail').textContent=item?`${itemName(item)} · ${item.count}개${item.maxDurability?` · 내구도 ${item.durability??'?'} / ${item.maxDurability}`:''}`:'빈 슬롯'
 for(const el of document.querySelectorAll('.mc-slot'))el.classList.toggle('inspected',Number(el.dataset.slot)===slot)
 if(item){try{const r=await fetch('/api/items/'+item.name);if(!r.ok)return;const info=await r.json();if(requestId!==detailRequest||selectedItemSlot!==slot||lastInventoryState?.slots?.[slot]?.name!==item.name)return;const line=document.createElement('small');line.className='recipe-detail';line.textContent=info.recipes.length?'제작법: '+info.recipes[0].ingredients.map(i=>`${itemName(i)} ${i.count}`).join(' + ')+` → ${info.recipes[0].count}개`:'제작대 조합법 없음 · 채집/제련 등으로 획득';$('itemDetail').append(line)}catch{}}

}
function slotElement(item,slot,caption=''){
 const button=document.createElement('button');button.type='button';button.className='mc-slot';button.dataset.slot=slot;button.classList.toggle('equipped',slot===lastInventoryState.selectedSlot);button.classList.toggle('inspected',slot===selectedItemSlot)
 const title=item?`${itemName(item)} ${item.count}개${item.maxDurability?` · 내구도 ${item.durability??'?'} / ${item.maxDurability}`:''}`:caption||'빈 슬롯'
 button.title=title;button.setAttribute('aria-label',title);button.onclick=()=>showItem(slot)
 if(item){const img=document.createElement('img');img.src='/item-icons/'+item.name+'.png';img.alt='';img.draggable=false;img.onerror=()=>{img.remove();const fallback=document.createElement('span');fallback.className='item-fallback';fallback.textContent=itemName(item).slice(0,2);button.prepend(fallback)};button.append(img);if(item.count>1){const count=document.createElement('b');count.className='stack-count';count.textContent=item.count;button.append(count)}if(item.maxDurability&&item.durability!==null){const track=document.createElement('span');track.className='durability';const bar=document.createElement('i');const fraction=item.durability/item.maxDurability;bar.style.width=Math.max(0,Math.min(1,fraction))*100+'%';bar.style.background=`hsl(${Math.round(fraction*120)} 75% 50%)`;track.append(bar);button.append(track)}}else if(caption){const label=document.createElement('small');label.textContent=caption;button.append(label)}
 return button
}
function renderMeter(id,value,icon){const el=$(id);el.replaceChildren();el.setAttribute('aria-label',value==null?'연결 대기':`${value} / 20`);for(let i=0;i<10;i++){const unit=document.createElement('span');unit.textContent=icon;const fill=Math.max(0,Math.min(1,((value||0)-i*2)/2));unit.style.setProperty('--fill',fill*100+'%');el.append(unit)}}
function renderInventory(s){
 renderMeter('heartMeter',s.ready?s.health:null,'♥');renderMeter('foodMeter',s.ready?s.food:null,'◆')
 const t=s.world?.timeOfDay;const hour=t==null?null:Math.floor((t/1000+6)%24),minute=t==null?null:Math.floor((t%1000)*60/1000)
 $('worldTime').textContent=s.ready&&hour!=null?`${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} · ${t<13000?'낮':'밤'}`:'연결 대기'
 $('dimension').textContent=({'minecraft:overworld':'오버월드',overworld:'오버월드','minecraft:the_nether':'네더','minecraft:the_end':'엔드'})[s.world?.dimension]||s.world?.dimension||'—'
 $('biome').textContent=s.world?.biome||'';$('xp').textContent=`경험치 Lv. ${s.experience?.level??'—'}`
 const view=s.ready?s:{slots:[],inventory:[],selectedSlot:null};lastInventoryState=view
 $('heldItem').textContent='손에 든 아이템: '+(view.heldItem?itemName(view.heldItem):'없음')
 $('containerState').textContent=view.cursorItem?`옮기는 중: ${itemName(view.cursorItem)} ${view.cursorItem.count}개`:view.container?'작업 중인 보관함: '+view.container:''
 const key=JSON.stringify([view.slots,view.selectedSlot]);if(key===inventoryKey)return;inventoryKey=key
 for(const id of ['inventory','hotbar','equipment'])$(id).replaceChildren()
 for(let i=9;i<36;i++)$('inventory').append(slotElement(view.slots?.[i],i))
 for(let i=36;i<45;i++)$('hotbar').append(slotElement(view.slots?.[i],i,String(i-35)))
 for(const [slot,label]of [[5,'머리'],[6,'몸통'],[7,'다리'],[8,'발'],[45,'보조손']]){const wrap=document.createElement('div');const name=document.createElement('span');name.textContent=label;wrap.append(slotElement(view.slots?.[slot],slot),name);$('equipment').append(wrap)}
 $('itemCount').textContent=`${(view.slots||[]).slice(9,45).filter(Boolean).length} / 36칸`
 if(selectedItemSlot!==null)showItem(selectedItemSlot)
}

let campaignKey='',missionKey=''
function renderMission(s){
 const auto=s.auto||{},queue=$('missionQueue'),key=JSON.stringify(auto.goals||[])
 if(key!==missionKey){missionKey=key;queue.replaceChildren();for(const [index,goal] of (auto.goals||[]).entries()){const row=document.createElement('p');row.textContent=`${goal.status==='done'?'✓':goal.status==='active'?'▶':'○'} ${index+1}. ${goal.reason||goal.type}${goal.item?' · '+goal.item+' × '+goal.quantity:''}`;queue.append(row)}}
 const build=auto.construction;$('constructionProgress').textContent=build?`${build.title} (${build.complete?"완공":"미완성"}): ${build.phase||'건축'} · 블록 ${build.built}/${build.total} · 가구 ${build.furnitureBuilt||0}/${build.furnitureTotal||0} · ${build.origin?`(${build.origin.x}, ${build.origin.y}, ${build.origin.z})`:'부지 탐색 필요'}${build.stages?.length?' · '+build.stages.map(p=>`${p.title} ${p.built}/${p.total}`).join(' · '):''}`:''
 const campaign=s.campaign||auto.campaign,cKey=JSON.stringify(campaign);if(cKey===campaignKey)return;campaignKey=cKey;const root=$('campaign');root.replaceChildren();if(!campaign){root.textContent='봇을 연결하면 생존 진행을 확인합니다.';return}
 const note=document.createElement('p');note.textContent='현재 월드에서 관측한 준비물과 달성 기록을 표시합니다. 네더·엔드 전체 완주는 시험 단계입니다.';root.append(note)
 if(campaign.difficultyIssue){const issue=document.createElement('p');issue.className='campaign-warning';issue.textContent=campaign.difficultyIssue;root.append(issue)}
 const list=document.createElement('ol');for(const stage of campaign.stages){const row=document.createElement('li');row.className=stage.achieved?'done':'pending';row.textContent=(stage.achieved?'✓ ':'○ ')+stage.title;const detail=document.createElement('small');detail.textContent=stage.achieved&&!stage.ready?'과거 달성 · 현재 준비물은 다시 확인합니다.':stage.description;row.append(detail);list.append(row)}root.append(list)
 const limits=document.createElement('details'),title=document.createElement('summary');title.textContent='시험 기능의 현재 제한';limits.append(title);for(const text of campaign.limitations||[]){const p=document.createElement('p');p.textContent=text;limits.append(p)}root.append(limits)
 if(campaign.lastDeath){const death=document.createElement('p');const p=campaign.lastDeath.position;death.textContent=`최근 사망: ${campaign.lastDeath.dimension} (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}) · 목표에 “사망 아이템 회수해줘” 입력`;root.append(death)}
}

function renderActivities(s){
 const nutrition=s.auto?.nutrition||{};$('nutritionStatus').textContent=(nutrition.phase||'대기')+` · 먹을 식량 ${nutrition.available||0}개`+(nutrition.target?` / 준비 목표 ${nutrition.target}개`:'')+(nutrition.source?' · 재료 '+nutrition.source:'')+(nutrition.plan?.selected?' · 확보할 음식: '+(itemLabels[nutrition.plan.selected.meal]||nutrition.plan.selected.meal)+' · '+nutrition.plan.selected.steps.join(' → ')+' · '+nutrition.plan.selected.reason:nutrition.plan?.pending?' · Qwen 식량 계획 중':'');
 const farming=s.farming||{},farms=farming.farms||[];
 $('farmStatus').textContent=farms.length?farms.map(f=>`${f.title}: 파종 ${f.planted}/${f.plots}, 익음 ${f.ripe}, 수확 ${f.harvested}개 · 물 ${f.hydrated}/${f.plots} · 조도 ${f.lit}/${f.plots}`).join(' / ')+' · '+farming.phase+(s.auto?.enabled&&farming.nextCheck>Date.now()?` · 다음 확인 ${Math.ceil((farming.nextCheck-Date.now())/1000)}초`:''):'등록된 농장 없음';
 const combat=s.combat||{},threats=combat.threats||[];$('combatStatus').textContent=(combat.phase||'대기')+(combat.weapon?' · 무기 '+(itemLabels[combat.weapon]||combat.weapon):'')+' · 처치 '+(combat.kills||0)+' · 퇴각 '+(combat.retreats||0)+(threats.length?' · '+threats.map(e=>`${e.name} ${e.distance}m`).join(', '):' · 주변 적대 몹 없음');
 const collection=s.collection||{};$('collectionStatus').textContent=(collection.phase||'대기')+(collection.target?` · ${(collection.items||[]).map(n=>itemLabels[n]||n).join('/')} ${collection.collected}/${collection.target}`:'');
 const exploration=s.exploration||{};$('explorationStatus').textContent=(exploration.phase||'대기')+` · 방문 구역 ${exploration.visited||0} · 막힌 후보 ${exploration.blocked||0}`+((exploration.focus||[]).length?' · 찾는 자원 '+exploration.focus.join(', '):'')+((exploration.resources||[]).length?' · 발견 '+exploration.resources.slice(0,3).map(p=>`${p.name} (${p.x}, ${p.y}, ${p.z})`).join(' / '):'');
 const buildings=s.buildings||[];$('buildingStatus').textContent=buildings.length?buildings.map(b=>`${b.title}${b.unloaded?` (미관측 ${b.unloaded}블록)`:""} · ${b.complete?"완공":"미완성"} · ${b.phase} · 블록 ${b.built}/${b.total}, 가구 ${b.furnitureBuilt}/${b.furnitureTotal}`).join(' / '):'등록된 건물 없음';
}

$('routineToggle').addEventListener('click',async()=>{try{await post('command',{text:$('routineToggle').dataset.enabled==='true'?'자율생활 끄기':'자율생활 켜기'})}catch(e){$('notice').textContent=e.message}})
