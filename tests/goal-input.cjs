const assert=require('node:assert/strict'),{resolveGoal,validateGoal}=require('../qwen-planner')
;(async()=>{
 assert.throws(()=>validateGoal({target:'build_house',reason:'yes'}))
 assert.throws(()=>validateGoal({target:'stone_pickaxe',reason:''}))
 await assert.rejects(resolveGoal(' '))
 await assert.rejects(resolveGoal('x'.repeat(501)))
 let request
 const result=await resolveGoal('철 도구 준비해',{fetchImpl:async(url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({message:{content:'{"target":"iron_pickaxe","reason":"철곡괭이 준비"}'}})}}})
 assert.equal(result.target,'iron_pickaxe');assert.equal(request.messages.at(-1).content,'철 도구 준비해')
 await assert.rejects(resolveGoal('집 지어줘',{fetchImpl:async()=>({ok:true,json:async()=>({message:{content:'{"target":"house","reason":"build"}'}})})}))
 const c=new AbortController();c.abort();await assert.rejects(resolveGoal('돌곡괭이',{signal:c.signal}))
 console.log('PASS goal validation, exact input forwarding, unsupported action rejection, cancellation')
})().catch(e=>{console.error(e);process.exitCode=1})
