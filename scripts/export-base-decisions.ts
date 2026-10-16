import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {renderQwenBaseState,BASE_DECISION_QUESTION,type ChoiceCandidate} from '../packages/models/src';
const [database,output,after='0',before=String(Date.now()),startAge]=process.argv.slice(2);
if(!database||!output)throw Error('Usage: export-base-decisions.ts DATABASE NEW_OUTPUT_JSONL AFTER_MS BEFORE_MS [RUN_START_WORLD_AGE]');
if(existsSync(output))throw Error('Refusing to overwrite an existing decision artifact');
const db=new DatabaseSync(resolve(database),{readOnly:true}),hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
try{
 const checkpoint=JSON.parse(String(db.prepare("select value from state where key='checkpoint'").get()!.value)),tasks=new Map(checkpoint.tasks.map((t:any)=>[t.id,t]));
 const events=db.prepare("select seq,payload from events where time>=? and time<=? and json_extract(payload,'$.type')='scheduler.decision' order by seq").all(Number(after),Number(before));
 const result:unknown[]=[];
 for(const event of events){
  const row=JSON.parse(String(event.payload)),observation=row.data?.observation;if(!observation||!Array.isArray(observation.candidates))continue;
  const selected=observation.candidates.find((c:any)=>c.id===row.data.selectedTaskId);if(!selected)continue;
  const priority=Math.max(...observation.candidates.map((c:any)=>Number(c.priority))),candidates:ChoiceCandidate[]=observation.candidates.filter((c:any)=>c.priority===priority&&c.action in BASE_DECISION_QUESTION.criteria).map((c:any)=>({id:c.id,action:c.action,description:c.action}));
  if(!candidates.length||!candidates.some(c=>c.id===selected.id))continue;
  const state=renderQwenBaseState({state:JSON.stringify(observation),candidates}),task=tasks.get(row.taskId) as any,age=Number(observation.worldAge),day=startAge&&Number.isFinite(age)?Math.floor((age-Number(startAge))/24000)+1:null;
  result.push({id:row.id,task:'base_action',state,state_sha256:hash(state),episode_id:`${row.botId}:${task?.goalId??row.taskId}:${task?.generation??'unknown'}`,source:observation.world==='infra:25565'?'production':observation.world==='127.0.0.1:25566'?'validation':'unknown',world:observation.world,recorded_at:row.time,world_age:Number.isFinite(age)?age:null,run_day:day,proposal:selected.action,expected:null,allowed:[],reviewed:false,reviewer:null,rationale:null,evidence:{event_seq:event.seq,event_sha256:hash(String(event.payload)),task_id:row.taskId,attempt_id:row.attemptId,observation},question_sha256:hash(readFileSync(resolve(__dirname,'../packages/contracts/src/base-decisions.json')))});
 }
 mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,result.map(row=>JSON.stringify(row)).join('\n')+(result.length?'\n':''));console.log(JSON.stringify({output:resolve(output),records:result.length,reviewed:false,trained:false}));
}finally{db.close();}
