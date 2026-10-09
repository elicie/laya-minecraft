const fs=require('node:fs'),path=require('node:path')
const root=__dirname
const questions=require('./training/questions.json')
const aliases={'따라오기':'follow','이리와':'come','나무':'wood','나무곡괭이':'wooden_pickaxe','돌곡괭이':'stone_pickaxe','철곡괭이':'iron_pickaxe','상태':'status','중지':'stop','기타':'unknown'}
function correct(id,label,reviewer='local-terminal') {
 label=aliases[label]||label
 if(!(label in questions.action.criteria)) throw new Error('정답: '+Object.keys(aliases).join(', '))
 const events=fs.readFileSync(path.join(root,'logs/events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
 const event=events.find(e=>e.id===id && e.type==='decision')
 if(!event) throw new Error('해당 판단 기록을 찾을 수 없어요.')
 const heldout=fs.readFileSync(path.join(root,'training/data/eval.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
 if(heldout.some(r=>r.state===event.command)) throw new Error('고정 평가 문장은 학습에 넣지 않습니다.')
 const row={id:'correction-'+id,state:event.command,questions,expected:{action:label},source:'human_correction',reviewer,reviewed_at:new Date().toISOString(),previous_answer:event.answer.choice,event_id:id}
 fs.appendFileSync(path.join(root,'training/data/corrections.jsonl'),JSON.stringify(row)+'\n')
 return label
}
module.exports={correct}
if(require.main===module){try{console.log('정답 저장:',correct(process.argv[2],process.argv[3]))}catch(e){console.error(e.message);process.exitCode=1}}
