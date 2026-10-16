import {z} from 'zod';
import question from '../../contracts/src/base-decisions.json';
import type {ChoiceCandidate,ModelChoice} from './laya';
export const BASE_DECISION_QUESTION=question;
export type BaseDecisionAction=keyof typeof question.criteria;
const actions=Object.keys(question.criteria),probabilities=z.record(z.string(),z.number().finite().min(0).max(1));
const responseSchema=z.object({backend:z.literal('qwen'),model:z.string().min(1),state_truncated:z.literal(false),calibrated:z.literal(true),answers:z.object({base_action:z.object({choice:z.string(),probabilities})})});

/** Shared by runtime scoring and the reviewed-record exporter. Unknown stock
 * remains unknown; volatile IDs and timestamps are provenance, not features. */
export function renderQwenBaseState(input:{state:string;candidates:ChoiceCandidate[]}):string{
 const raw=z.record(z.string(),z.unknown()).parse(JSON.parse(input.state)),object=(v:unknown):Record<string,unknown>|undefined=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
 const counts=(value:unknown)=>{if(!Array.isArray(value))return'unknown';const result:Record<string,number>={};for(const rawItem of value){const item=z.object({name:z.string(),count:z.number().int().nonnegative()}).parse(rawItem);result[item.name]=(result[item.name]??0)+item.count;}return JSON.stringify(Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b))));};
 const warehouse=object(raw.warehouse),farm=object(raw.farm),targets=object(raw.targets),base=object(raw.base),outside=object(base?.outside),p=object(raw.position),numeric=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:undefined;
 const distance=p&&outside&&['x','y','z'].every(k=>numeric(p[k])!==undefined&&numeric(outside[k])!==undefined)?Math.round(Math.hypot(Number(p.x)-Number(outside.x),Number(p.y)-Number(outside.y),Number(p.z)-Number(outside.z))):'unknown';
 const age=(v:unknown)=>numeric(raw.observedAt)!==undefined&&numeric(v)!==undefined?Math.max(0,Number(raw.observedAt)-Number(v)):'unknown',ids=new Set(input.candidates.map(c=>c.id));
 const choices=Array.isArray(raw.candidates)?raw.candidates.map(object).filter(c=>c&&typeof c.id==='string'&&ids.has(c.id)).map(c=>({action:c!.action,kind:c!.kind,item:c!.item,goalItem:c!.goalItem,mode:c!.mode,priority:c!.priority,target:c!.targetQuantity})):[];
 return[`health=${numeric(raw.health)??'unknown'}`,`food=${numeric(raw.food)??'unknown'}`,`time_of_day=${numeric(raw.timeOfDay)??'unknown'}`,`role=${JSON.stringify(raw.role??'unknown')}`,`distance_to_base=${distance}`,`nearby_threats_clear=${typeof raw.nearbyThreatsClear==='boolean'?raw.nearbyThreatsClear:'unknown'}`,`inventory=${counts(raw.inventory)}`,`warehouse_known=${!!warehouse}`,`warehouse=${counts(warehouse?.items)}`,`warehouse_age_ms=${age(warehouse?.observedAt)}`,`seed_target=${targets?.seeds??'unknown'}`,`wood_target=${targets?.wood??'unknown'}`,`bread_target=${targets?.bread??'unknown'}`,`farm=${farm?JSON.stringify({plots:farm.plots,planted:farm.planted,watered:farm.watered,ripe:farm.ripe,harvested:farm.harvested,age_ms:age(farm.observedAt)}):'unknown'}`,`candidates=${JSON.stringify(choices)}`,`available_actions=${[...new Set(input.candidates.map(c=>c.action))].join(',')}`].join('; ');
}

/** Fixed trained labels are mapped back only to the current executable task IDs. */
export async function chooseQwenBase(options:{url:string;timeoutMs?:number;fetchImpl?:typeof fetch;minConfidence?:number},input:{state:string;candidates:ChoiceCandidate[];signal?:AbortSignal}):Promise<ModelChoice>{
 const fallback=(reason:string):ModelChoice=>({id:input.candidates[0]!.id,source:'code',reason});
 if(input.candidates.some(c=>!c.action||!actions.includes(c.action)))return fallback('Qwen의 학습된 거점 행동에 해당하지 않아 검증한 작업 순서를 사용합니다.');
 try{
  if(input.state.length>6000)return fallback('관측이 Qwen 입력 한도를 초과해 자르지 않고 코드 판단을 사용합니다.');
  const state=renderQwenBaseState(input);
  if(state.length>6000)return fallback('관측이 Qwen 입력 한도를 초과해 자르지 않고 코드 판단을 사용합니다.');
  const timeout=AbortSignal.timeout(options.timeoutMs??3000),signal=input.signal?AbortSignal.any([input.signal,timeout]):timeout;
  const response=await(options.fetchImpl??fetch)(`${options.url.replace(/\/$/,'')}/api/decide`,{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({task:'base_action',state,questions:{base_action:question}})});
  if(!response.ok)return fallback(`Qwen 점수 응답 실패 (${response.status}); 검증한 작업 순서를 사용합니다.`);
  const result=responseSchema.parse(await response.json()),answer=result.answers.base_action,p=answer.probabilities;
  if(Object.keys(p).length!==actions.length||actions.some(k=>p[k]===undefined)||Math.abs(Object.values(p).reduce((a,b)=>a+b,0)-1)>.001)return fallback('Qwen의 전체 행동 확률을 검증하지 못해 코드 판단을 사용합니다.');
  const selected=input.candidates.find(c=>c.action===answer.choice),confidence=p[answer.choice];
  if(!selected||confidence===undefined||confidence<(options.minConfidence??.55)||actions.some(k=>p[k]>confidence+.000001))return fallback('Qwen 선택의 실행 가능성과 신뢰도를 확인하지 못해 코드 판단을 사용합니다.');
  return{id:selected.id,source:'laya',model:result.model,confidence,reason:'Qwen3.5의 학습된 거점 행동 점수를 현재 허용된 작업에 연결했습니다.'};
 }catch(error){if(input.signal?.aborted)throw input.signal.reason;return fallback(`Qwen 점수를 사용할 수 없어 코드 판단을 사용합니다: ${error instanceof Error?error.message:'응답 검증 실패'}`);}
}
