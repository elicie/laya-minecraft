const fs=require('node:fs'),path=require('node:path'),{labels,questions}=require('./activity-policy'),{log}=require('./decision')
function correctActivity(id,label,{root=__dirname,reviewer='web-user',logImpl=log}={}){
 if(!Object.hasOwn(labels,label))throw new Error('등록된 행동만 정답으로 저장할 수 있습니다.')
 const events=fs.readFileSync(path.join(root,'logs/events.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse),event=events.find(e=>e.type==='activity_decision'&&e.id===id)
 if(!event)throw new Error('해당 행동 판단 기록을 찾지 못했습니다.')
 if(!event.allowed.includes(label))throw new Error('당시 관측 상태에서 실행할 수 없는 행동입니다.')
 const directory=path.join(root,'training/data/activity'),evaluation=path.join(directory,'eval.jsonl')
 if(fs.existsSync(evaluation)&&fs.readFileSync(evaluation,'utf8').split('\n').filter(Boolean).map(JSON.parse).some(e=>e.state===event.state))throw new Error('고정 평가 상태는 교정 학습에 넣지 않습니다.')
 const row={id:'activity-correction-'+id,state:event.state,observation:event.observation,questions,expected:{activity_action:label},source:'human_correction',reviewer,reviewed_at:new Date().toISOString(),previous_answer:event.proposed,event_id:id}
 fs.mkdirSync(directory,{recursive:true});fs.appendFileSync(path.join(directory,'corrections.jsonl'),JSON.stringify(row)+'\n');logImpl({type:'activity_correction',event_id:id,label});return label
}
module.exports={correctActivity}
