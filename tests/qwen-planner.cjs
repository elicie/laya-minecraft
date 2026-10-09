const assert=require('node:assert/strict')
const {allowedActions,validatePlan,planNext}=require('../qwen-planner')
const state={target:'stone_pickaxe',health:20,inventory:[]}
assert(!allowedActions(state).includes('stone_pickaxe'))
assert(!allowedActions(state).includes('done'))
state.inventory=[{name:'wooden_pickaxe',count:1},{name:'oak_log',count:3}]
assert(allowedActions(state).includes('gather_stone'))
state.inventory.push({name:'cobblestone',count:3})
assert(allowedActions(state).includes('stone_pickaxe'))
assert(!allowedActions(state).includes('gather_stone'))
assert.throws(()=>validatePlan({action:'eval',reason:'run code'},allowedActions(state)))
assert.throws(()=>validatePlan({action:'done',reason:'pretend success'},allowedActions(state)))
state.inventory.push({name:'stone_pickaxe',count:1})
assert.deepEqual(allowedActions(state),['done'])
state.health=5
assert.deepEqual(allowedActions(state),['stop'])
;(async()=>{
 await assert.rejects(planNext(state,{fetchImpl:async()=>({ok:true,json:async()=>({message:{content:'{"action":"wood","reason":"unsafe"}'}})})}),/허용되지/)
 const controller=new AbortController();controller.abort()
 await assert.rejects(planNext(state,{signal:controller.signal}))
 console.log('PASS prerequisites, false completion, invalid action, low health, cancellation')
})().catch(e=>{console.error(e);process.exitCode=1})
