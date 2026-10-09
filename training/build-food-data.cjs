// Authored expert examples for supervised state-to-action learning. These are
// synthetic scenarios, not successful Minecraft episodes or reward training.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {describeObservation,normalizeObservation,allowedActions,questions}=require('../survival-policy')
const root=path.join(__dirname,'data/food');fs.mkdirSync(root,{recursive:true})
const actions=Object.keys(questions.food_action.criteria),seen=new Set()
function random(seed){return ()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296}}
function scenario(action,rng){
 const pick=array=>array[Math.floor(rng()*array.length)],n=(a,b)=>a+Math.floor(rng()*(b-a+1)),coin=()=>rng()>.5
 const s={goal:pick(['dragon','item','build','farm','survive','follow']),health:n(10,20),hunger:n(3,20),urgent:coin(),target:pick([1,8,16,24]),safe:0,raw:0,wheat:n(0,2),prey:0,ripe:0,growing:false,checkDue:false,farmReady:coin(),blocked:[]}
 if(action==='eat'){s.urgent=true;s.hunger=n(3,17);s.safe=n(1,12);s.raw=n(0,8);s.wheat=n(0,12);s.prey=n(0,4);s.ripe=n(0,8)}
 if(action==='cook'){s.raw=n(1,8);s.wheat=n(0,12);s.prey=n(0,4);s.ripe=n(0,8)}
 if(action==='bread'){s.wheat=n(3,15);s.prey=n(0,4);s.ripe=n(0,8);if(coin()){s.raw=n(1,8);s.blocked.push('cook')}}
 if(action==='hunt'){s.prey=n(1,4);s.growing=coin();s.checkDue=false}
 if(action==='farm'){s.ripe=coin()?n(1,8):0;s.farmReady=true;s.growing=coin();s.checkDue=s.growing;if(s.ripe)s.prey=n(0,4)}
 if(action==='explore'){s.farmReady=false;if(coin()){s.raw=n(1,8);s.blocked.push('cook')}if(coin()){s.prey=n(1,4);s.blocked.push('hunt')}if(coin()){s.farmReady=true;s.blocked.push('farm')}}
 if(action==='wait'){s.growing=true;s.checkDue=false}
 if(action==='continue'){s.safe=s.target+n(0,8);s.hunger=n(18,20);s.raw=n(0,8);s.wheat=n(0,12);s.prey=n(0,4);s.ripe=n(0,8)}
 if(action==='stop'){s.health=n(0,7);s.safe=n(0,12);s.raw=n(0,8);s.wheat=n(0,12);s.prey=n(0,4)}
 return normalizeObservation(s)
}
function write(split,perClass,seed){
 const rng=random(seed),rows=[]
 for(const action of actions)for(let i=0;i<perClass;i++){
  let observation,state;do{observation=scenario(action,rng);state=describeObservation(observation)}while(seen.has(state))
  seen.add(state);assert(allowedActions(observation).includes(action))
  rows.push({id:`food-v1-${split}-${action}-${i}`,state,observation,questions,expected:{food_action:action},source:'assistant_authored_synthetic',split})
 }
 fs.writeFileSync(path.join(root,split+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return rows
}
const train=write('train',60,3419),evaluation=write('eval',12,74117)
console.log(`Food state examples: ${train.length} authored training/calibration, ${evaluation.length} separate evaluation; nine balanced actions`)
