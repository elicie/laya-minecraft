const assert = require('node:assert/strict')
const { classify } = require('./decision')
const cases = [['따라와','follow'],['이리 와','come'],['나무 캐 줘','wood'],['나무곡괭이 만들어','wooden_pickaxe'],['돌곡괭이 만들어','stone_pickaxe'],['철곡괭이 만들어 줘','iron_pickaxe'],['인벤토리 보여줘','status']]
;(async()=>{
  for(const [command,expected] of cases) {
    const answer=await classify(command)
    assert.equal(answer.choice,expected,command)
    assert.ok(answer.probabilities[expected]>=(['come','status'].includes(expected)?0.5:0.65),command+' below action threshold')
    console.log(`PASS ${command} -> ${expected} (${answer.probabilities[expected]})`)
  }
})().catch(e=>{console.error(e);process.exitCode=1})
