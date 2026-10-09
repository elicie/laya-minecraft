const fs=require('node:fs'),path=require('node:path'),{labels,questions}=require('./survival-policy')
const {log}=require('./decision')
function correctPolicy(id,label,{root=__dirname,reviewer='web-user',logImpl=log}={}){
 if(!Object.hasOwn(labels,label))throw new Error('등록된 상황 판단 행동만 정답으로 저장할 수 있습니다.')
 const entries=fs.readFileSync(path.join(root,'logs/events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
 const event=entries.find(e=>e.id===id&&e.type==='policy_decision')
 if(!event)throw new Error('해당 상황 판단 기록을 찾지 못했습니다.')
 if(!event.allowed.includes(label))throw new Error('당시 관측 상태에서 실행할 수 없는 행동입니다.')
 const file=path.join(root,'training/data/food/eval.jsonl'),evaluation=fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse):[]
 if(evaluation.some(r=>r.state===event.state))throw new Error('고정 평가 상태는 교정 학습에 넣지 않습니다.')
 const row={id:'food-correction-'+id,state:event.state,observation:event.observation,questions,expected:{food_action:label},source:'human_correction',reviewer,reviewed_at:new Date().toISOString(),previous_answer:event.proposed,event_id:id}
 const destination=path.join(root,'training/data/food/corrections.jsonl');fs.mkdirSync(path.dirname(destination),{recursive:true});fs.appendFileSync(destination,JSON.stringify(row)+'\n')
 logImpl({type:'policy_correction',event_id:id,label});return label
}
module.exports={correctPolicy}
