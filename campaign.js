const fs=require('node:fs'),path=require('node:path')
const stages=[
 {id:'tools',title:'기본 채굴 도구',description:'돌곡괭이 이상을 확보합니다.',capabilities:['collect','craft']},
 {id:'supplies',title:'식량과 이동 자재',description:'먹을 수 있는 식량 16개와 설치용 블록 64개를 준비합니다.',capabilities:['hunt','cook','eat','collect']},
 {id:'equipment',title:'철 장비와 방어 준비',description:'철 방어구 4종, 철검, 방패, 철곡괭이를 갖춥니다.',capabilities:['craft','smelt','equip']},
 {id:'nether_kit',title:'네더 진입 준비',description:'점화 도구와 포털 재료, 금 장비를 준비합니다.',capabilities:['mine_obsidian','build_portal']},
 {id:'nether',title:'네더 진입',description:'완성한 포털을 통해 네더로 이동합니다.',capabilities:['dimension_travel']},
 {id:'blaze',title:'블레이즈 막대 확보',description:'네더 요새를 찾아 블레이즈 막대 8개를 확보합니다.',capabilities:['find_fortress','combat']},
 {id:'pearls',title:'엔더 진주 확보',description:'엔더 진주 16개를 확보합니다.',capabilities:['combat','barter']},
 {id:'eyes',title:'엔더의 눈 제작',description:'블레이즈 가루와 엔더 진주로 엔더의 눈 16개를 준비합니다.',capabilities:['craft']},
 {id:'stronghold',title:'요새와 엔드 포털 탐색',description:'엔더의 눈 방향을 추적하고 포털방을 확인합니다.',capabilities:['eye_tracking','find_stronghold']},
 {id:'end',title:'엔드 진입',description:'포털을 활성화한 뒤 엔드로 이동합니다.',capabilities:['activate_end_portal','dimension_travel']},
 {id:'crystals',title:'엔드 수정 제거',description:'발견한 수정과 철창을 제거해 드래곤의 회복을 끊습니다.',capabilities:['ranged_combat','climb','combat']},
 {id:'dragon',title:'엔더드래곤 처치',description:'전투 후 서버의 드래곤 사망 이벤트로 처치를 확인합니다.',capabilities:['dragon_combat']}
]
const availability={collect:'available',craft:'available',smelt:'available',equip:'available',eat:'available',hunt:'experimental',cook:'experimental',mine_obsidian:'experimental',build_portal:'experimental',dimension_travel:'experimental',find_fortress:'experimental',combat:'experimental',barter:'experimental',eye_tracking:'experimental',find_stronghold:'experimental',activate_end_portal:'experimental',ranged_combat:'experimental',climb:'experimental',dragon_combat:'experimental'}
const safeFoods=new Set(['bread','cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton','cooked_rabbit','cooked_cod','cooked_salmon','baked_potato','carrot','apple','golden_carrot','golden_apple'])
function evaluate(snapshot,evidence={}){
 const inv=snapshot.inventory||[],n=name=>inv.filter(i=>i.name===name).reduce((a,i)=>a+i.count,0)
 const any=names=>names.some(name=>n(name)>0)
 const food=inv.filter(i=>safeFoods.has(i.name)).reduce((a,i)=>a+i.count,0)
 const blocks=inv.filter(i=>['_planks','_log'].some(s=>i.name.endsWith(s))||['cobblestone','dirt','netherrack','cobbled_deepslate'].includes(i.name)).reduce((a,i)=>a+i.count,0)
 const equipped=[...(snapshot.equipment||[]),...inv]
 const hasGear=name=>equipped.some(i=>i.name===name)
 const nether=snapshot.dimension==='the_nether'||snapshot.dimension==='minecraft:the_nether'
 const end=snapshot.dimension==='the_end'||snapshot.dimension==='minecraft:the_end'
 const ready={tools:any(['stone_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe']),supplies:food>=16&&blocks>=64,equipment:['iron_helmet','iron_chestplate','iron_leggings','iron_boots','iron_sword','shield','iron_pickaxe'].every(hasGear),nether_kit:n('obsidian')>=10&&n('flint_and_steel')>0&&equipped.some(i=>i.name.startsWith('golden_')),nether,blaze:n('blaze_rod')>=8||n('blaze_powder')>=16,pearls:n('ender_pearl')>=16,eyes:n('ender_eye')>=16,stronghold:!!evidence.stronghold,end,crystals:!!evidence.crystals,dragon:!!evidence.dragon}
 return {food,blocks,ready,nether,end}
}
function createCampaign(file=path.join(__dirname,'logs/campaign.json')){
 let saved={version:1,goal:'ender_dragon',achievements:{},lastDeath:null};try{const parsed=JSON.parse(fs.readFileSync(file));if(parsed.version===1&&parsed.goal==='ender_dragon')saved=parsed}catch{}
 function persist(){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(saved,null,2));fs.renameSync(file+'.tmp',file)}
 function record(kind,details={}){if(!['stronghold','crystals','dragon','death'].includes(kind))throw new Error('Unknown campaign evidence');if(kind==='death')saved.lastDeath={time:new Date().toISOString(),...details};else saved.achievements[kind]={time:new Date().toISOString(),...details};persist()}
 function snapshot(state){const result=evaluate(state,saved.achievements);let changed=false;for(const [id,done]of Object.entries(result.ready)){if(done&&!saved.achievements[id]){saved.achievements[id]={time:new Date().toISOString(),source:'observed_game_state'};changed=true}}if(changed)persist()
 const list=stages.map(stage=>({...stage,achieved:!!saved.achievements[stage.id],ready:result.ready[stage.id],missingCapabilities:stage.capabilities.filter(c=>availability[c]==='pending')}))
 return {goal:'ender_dragon',title:'엔더드래곤까지 생존 진행',stages:list,current:list.find(s=>!s.achieved)?.id||'dragon',complete:!!saved.achievements.dragon,food:result.food,blocks:result.blocks,difficulty:state.difficulty||'unknown',difficultyIssue:state.difficulty==='peaceful'?'평화로움에서는 필수 몹 재료를 얻을 수 없습니다. 전투 준비와 일반 난이도 전환이 필요합니다.':null,lastDeath:saved.lastDeath,capabilities:availability,limitations:['네더·엔드 전체 완주는 아직 실제 게임에서 검증하지 않았습니다.','요새 탐색은 불러온 지형과 엔더의 눈 관측에 의존합니다.','철창 수정 접근, 높은 건축 발판, 복잡한 지형은 수동 보조가 필요할 수 있습니다.']}
 }
 return {snapshot,record}
}
module.exports={createCampaign,evaluate,stages,safeFoods}
