const fs = require('node:fs')
const path = require('node:path')
const {randomUUID}=require('node:crypto')
const questions=require('./training/questions.json')
const actions=questions.action.criteria
// Explicit language adapter for the initial untuned Korean model. Logged separately.
function normalize(command) {
  if (/철\s*곡괭/.test(command)) return 'Craft an iron pickaxe'
  if (/돌\s*곡괭/.test(command)) return 'Craft a stone pickaxe'
  if (/나무\s*곡괭/.test(command)) return 'Craft a wooden pickaxe'
  if (/나무|목재/.test(command) && /캐|모아|수집|구해/.test(command)) return 'Gather wood logs'
  if (/따라/.test(command)) return 'Follow the player continuously'
  if (/이리|여기로|내게/.test(command)) return 'Come here to the player once'
  if (/상태|인벤|소지품/.test(command)) return 'Report inventory or status'
  return command
}
function log(data) {
  const directory=process.env.BOT_LOG_DIR||path.join(__dirname,'logs')
  fs.mkdirSync(directory, { recursive: true })
  const id=randomUUID()
  fs.appendFileSync(path.join(directory,'events.jsonl'), JSON.stringify({id,time:new Date().toISOString(), ...data})+'\n')
  return id
}
async function classify(command, state = {}) {
  const start = performance.now()
  const input = process.env.LAYA_NORMALIZE === '0' ? command : normalize(command)
  const endpoint=process.env.LAYA_ENDPOINT || (process.env.OLLAYA_URL || 'http://127.0.0.1:8081')+'/api/decide'
  const response = await fetch(endpoint, {
    method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(15000),
    body:JSON.stringify({model:process.env.LAYA_MODEL || 'laya:multilingual', keep_alive:-1,
      state:input, questions})
  })
  if (!response.ok) throw new Error(`Ollaya ${response.status}: ${await response.text()}`)
  const result = await response.json()
  const answer = result.answers?.action
  if (!answer || !(answer.choice in actions) || result.state_truncated) throw new Error('Invalid or truncated Laya decision')
  const id=log({type:'decision', command, normalized:input, state, answer, model:result.model, endpoint, latency_ms:Math.round(performance.now()-start)})
  answer.decision_id=id
  return answer
}
module.exports = {classify, log, actions}
if (require.main === module) classify(process.argv.slice(2).join(' ')).then(console.log).catch(e=>{console.error(e);process.exitCode=1})
