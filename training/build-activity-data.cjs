// Human-readable authored scenarios. No gameplay outcome is its own correct label.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {domains,questions,normalizeObservation,describeObservation,allowedActions}=require('../activity-policy')
const root=path.join(__dirname,'data/activity');fs.mkdirSync(root,{recursive:true});const seen=new Set()
function random(seed){return ()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296}}
function scenario(action,rng){
 const n=(a,b)=>a+Math.floor(rng()*(b-a+1)),pick=a=>a[n(0,a.length-1)],coin=()=>rng()>.5
 const s={domain:pick(domains),mode:'once',health:n(10,20),hunger:n(18,20),bagFull:false,goalDone:false,siteKnown:coin(),suppliesMissing:false,farmPlaceKnown:true,seedAvailable:true,ripe:0,growing:false,checkDue:coin(),have:n(0,4),target:n(8,64),sources:n(0,6),toolReady:true,found:false,threats:0,closeThreats:0,creeperClose:false,bowReady:coin(),weaponReady:coin(),built:n(0,120),harvested:n(0,48),visited:n(0,40),kills:n(0,8),failures:n(0,2),blocked:[]}
 if(action==='food'){s.hunger=n(2,17);s.goalDone=coin();s.threats=n(0,1);s.weaponReady=true}
 if(action==='farm'){s.domain='farm';s.mode=pick(['setup','harvest','continuous']);s.ripe=n(0,24);s.growing=coin();s.checkDue=true}
 if(action==='wait'){s.domain=pick(['farm','fight']);if(s.domain==='farm'){s.mode=pick(['harvest','continuous']);s.growing=true;s.checkDue=false}else s.mode='continuous'}
 if(action==='survey'){s.domain='build';s.siteKnown=false;s.suppliesMissing=coin()}
 if(action==='gather'){s.domain=pick(['farm','build','collect','fight']);s.siteKnown=true;s.suppliesMissing=['farm','build'].includes(s.domain);s.toolReady=s.domain!=='collect';if(s.domain==='fight'){s.threats=n(1,2);s.weaponReady=false}}
 if(action==='build'){s.domain='build';s.siteKnown=true}
 if(action==='collect'){s.domain='collect';s.sources=n(1,16)}
 if(action==='search'){
  s.domain=pick(['build','farm','collect','explore']);s.failures=n(0,6)
  if(s.domain==='build'){s.siteKnown=coin();s.suppliesMissing=s.siteKnown&&coin();s.blocked=[s.siteKnown?s.suppliesMissing?'gather':'build':'survey']}
  if(s.domain==='farm'){s.farmPlaceKnown=coin();s.seedAvailable=!s.farmPlaceKnown;if(coin()){s.farmPlaceKnown=true;s.seedAvailable=true;s.blocked=['farm']}}
  if(s.domain==='collect'){s.sources=coin()?0:n(1,12);if(s.sources)s.blocked=['collect']}
 }
 if(action==='fight'){s.domain='fight';s.health=n(12,20);s.threats=n(1,2);s.closeThreats=n(0,2);s.weaponReady=true}
 if(action==='retreat'){s.threats=n(1,6);s.closeThreats=n(1,s.threats);const reason=pick(['health','many','creeper']);if(reason==='health')s.health=n(1,9);if(reason==='many')s.closeThreats=n(3,6);if(reason==='creeper'){s.creeperClose=true;s.bowReady=false}s.goalDone=coin();s.hunger=n(2,20)}
 if(action==='finish'){s.goalDone=true;s.bagFull=coin();s.mode=pick(['once','setup','harvest'])}
 if(action==='pause'){if(coin())s.health=n(0,7);else{s.bagFull=true;s.domain=pick(['build','collect','explore']);s.siteKnown=true;s.suppliesMissing=coin();s.sources=n(1,12)}}
 return normalizeObservation(s)
}
function write(split,count,seed){
 const rng=random(seed),rows=[]
 for(const action of Object.keys(questions.activity_action.criteria))for(let i=0;i<count;i++){
  let observation,state;do{observation=scenario(action,rng);state=describeObservation(observation)}while(seen.has(state))
  seen.add(state);assert(allowedActions(observation).includes(action),JSON.stringify({action,observation}))
  rows.push({id:`activity-v1-${split}-${action}-${i}`,state,observation,questions,expected:{activity_action:action},source:'assistant_authored_synthetic',split})
 }
 fs.writeFileSync(path.join(root,split+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return rows.length
}
console.log('Activity examples:',write('train',60,75313),'training/calibration,',write('eval',15,99713),'separate evaluation; five goal domains, twelve actions')
