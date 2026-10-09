const {pickupStand}=require('./pickup-navigation')
const {goals}=require('mineflayer-pathfinder')
const HAZARDS=new Set(['lava','fire','soul_fire','magma_block'])
function toolLife(item){return item?.maxDurability?item.maxDurability-(item.durabilityUsed||0):Infinity}
function capacity(bot,names){const slots=(bot.currentWindow||bot.inventory).slots;const window=bot.currentWindow||bot.inventory;let space=0;for(let i=window.inventoryStart;i<window.inventoryEnd;i++){const item=slots[i];if(!item)space+=64;else if(names.includes(item.name))space+=item.stackSize-item.count}return space}
function createCollector(bot,{check,near,sleep,log,onResource,protects=()=>false}) {
 const failures=new Map();let state={phase:'대기',items:[],target:0,collected:0,blocked:0}
 const items=()=> (bot.currentWindow||bot.inventory).items()
 const amount=names=>items().filter(i=>names.includes(i.name)).reduce((n,i)=>n+i.count,0)
 async function drops(names,token,around=bot.entity.position){
  for(const e of Object.values(bot.entities||{}).filter(e=>e.name==='item'&&e.position.distanceTo(around)<8).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position)).slice(0,8)) {
   const item=e.getDroppedItem?.();if(item&&!names.includes(item.name))continue
   try{check(token);await near(pickupStand(bot,e.position),0,token);await sleep(350)}catch(e){check(token)}
  }
 }
 async function collect(blockNames,itemNames,target,token){
  check(token);state={phase:'수집 위치 조사',items:itemNames,target,collected:amount(itemNames),blocked:0};onResource?.(blockNames)
  const randomYield=itemNames.includes('wheat_seeds')&&blockNames.some(n=>['short_grass','tall_grass','fern','large_fern'].includes(n))
  const minimumY=blockNames.some(n=>['stone','cobblestone','deepslate','cobbled_deepslate'].includes(n))?Math.floor(bot.entity.position.y)-1:-Infinity
  const until=Date.now()+180000;let attempts=0,empty=0
  while(amount(itemNames)<target&&attempts++<(randomYield?160:60)&&Date.now()<until){
   check(token);await drops(itemNames,token)
   if(amount(itemNames)>=target)break
   if(capacity(bot,itemNames)<1)throw new Error('가방이 가득 찼습니다. 상자에 보관한 후 이어가기를 실행해 주세요.')
   const positions=bot.findBlocks({matching:b=>blockNames.includes(b.name),maxDistance:48,count:64})
    .filter(p=>!protects(p))
    .filter(p=>p.y>=minimumY)
    .filter(p=>(failures.get(bot.game.dimension+':'+p.toString())||0)<Date.now())
    .filter(p=>!(p.y<bot.entity.position.y&&Math.hypot(p.x+.5-bot.entity.position.x,p.z+.5-bot.entity.position.z)<.9))
    .filter(p=>!Object.values(bot.entities||{}).some(e=>e.name==='creeper'&&e.position.distanceTo(p)<6))
    .filter(p=>!blockNames.some(n=>n.endsWith('_log'))||p.y<=bot.entity.position.y+4)
    .sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position))
   if(!positions.length)throw new Error('주변 수집 후보가 없습니다. 해당 자원을 기준으로 탐색합니다.')
   let mined=false
   for(const p of positions.slice(0,5)){
    try{
     check(token);const timer=setTimeout(()=>bot.pathfinder.setGoal(null),12000)
     try{if(!bot.canDigBlock?.(bot.blockAt(p)))await bot.pathfinder.goto(blockNames.some(n=>n.endsWith('_log'))?new goals.GoalNearXZ(p.x,p.z,1):new goals.GoalGetToBlock(p.x,p.y,p.z))}finally{clearTimeout(timer)}
     check(token);if(amount(itemNames)>=target)break
     const block=bot.blockAt(p);if(!block||!blockNames.includes(block.name)||protects(p))continue
     if(bot.canDigBlock&&!bot.canDigBlock(block))throw new Error('블록이 손이 닿는 높이 밖에 있습니다. 낮은 자원 후보를 확인합니다.')
     let hazardous=false;for(const [x,y,z] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]])if(HAZARDS.has(bot.blockAt(p.offset(x,y,z))?.name))hazardous=true
     if(hazardous)throw new Error('수집 블록 주변에 용암이나 화염이 있습니다.')
     const tools=items().filter(i=>toolLife(i)>2&&block.canHarvest(i.type)).sort((a,b)=>block.digTime(a.type)-block.digTime(b.type)||toolLife(b)-toolLife(a))
     const tool=tools[0];if(tool)await bot.equip(tool,'hand');else if(block.canHarvest(null))await bot.unequip('hand');else throw new Error('채굴 가능한 도구가 없거나 내구도가 부족합니다.')
     const before=amount(itemNames);state.phase='채굴·드롭 회수';log({type:'message',text:`수집: ${block.name} (${p.x}, ${p.y}, ${p.z})`})
     await bot.dig(block);check(token);await sleep(300);await drops(itemNames,token,p);await sleep(500)
     state.collected=amount(itemNames);empty=state.collected>before?0:empty+1;mined=true;break
    }catch(e){check(token);failures.set(bot.game.dimension+':'+p.toString(),Date.now()+180000);state.blocked++;log({type:'message',text:'수집 후보 변경: '+e.message})}
   }
   if(!mined)throw new Error('자원 후보에 접근하지 못했습니다. 실패 위치를 제외하고 탐색해야 합니다.')
   if(!randomYield&&empty>=5)throw new Error('드롭을 다섯 번 회수하지 못했습니다. 가방 또는 접근로를 확인합니다.')
  }
  state.collected=amount(itemNames);state.phase=state.collected>=target?'수집 완료':'추가 수집 필요'
  if(state.collected<target){const error=new Error(`수집 진행 ${state.collected}/${target}개. 탐색 후 남은 수량을 모읍니다.`);if(state.collected>0)error.code='COLLECTION_PROGRESS';throw error}
  return {...state}
 }
 return {collect,status:()=>state}
}
module.exports={createCollector,capacity,toolLife}
