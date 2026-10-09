const names={wood:'목재 준비',wooden_pickaxe:'나무곡괭이 준비',stone_pickaxe:'돌곡괭이 준비',gather_stone:'조약돌 수집',prepare_furnace:'화로 준비',gather_iron:'철 원석 수집',smelt_iron:'철 제련',iron_sword:'철검 제작',iron_pickaxe:'철곡괭이 제작'}
const count=(s,n)=>s.inventory.filter(i=>i.name===n).reduce((a,i)=>a+i.count,0)
function buildRoadmap(s){
 if(s.target==='shelter'){
  const house=s.shelter||{site:null,built:0,total:66,remaining:66,complete:false}
  const planks=s.inventory.filter(i=>i.name.endsWith('_planks')).reduce((a,i)=>a+i.count,0)
  const steps=[{id:'site',action:'find_site',title:'비어 있는 평평한 4×4 부지 확보',status:house.site?'done':'pending',materials:[]},{id:'materials',action:'building_materials',title:'건축용 판자 준비',status:planks>=house.remaining?'done':'pending',materials:[{item:'planks',have:planks,need:house.remaining,missing:Math.max(0,house.remaining-planks)}]},{id:'build',action:'build_shelter',title:`바닥·벽·지붕 설치 (${house.built}/${house.total})`,status:house.complete?'done':'pending',materials:[]}]
  if(house.complete)steps.forEach(s=>s.status='done')
  return {target:s.target,inventory:s.inventory,steps,next:steps.find(s=>s.status==='pending')?.action||'done',ironLocations:[],locationNote:house.site?`대피소 부지 (${house.site.x}, ${house.site.y}, ${house.site.z})`:'부지는 아직 모릅니다. 주변의 빈 4×4 공간을 조사하고, 없으면 넓은 공간으로 이동합니다.',building:house}
 }
 const n=name=>count(s,name),iron=s.target.startsWith('iron_'),needed=s.target==='iron_sword'?2:3
 const timber=s.inventory.filter(i=>i.name.endsWith('_log')).reduce((a,i)=>a+i.count*4,0)+s.inventory.filter(i=>i.name.endsWith('_planks')).reduce((a,i)=>a+i.count,0)
 const strong=n('stone_pickaxe')+n('iron_pickaxe')+n('diamond_pickaxe')+n('netherite_pickaxe')>0
 const furnace=n('furnace')>0||(s.nearby||[]).some(b=>b.name==='furnace')
 const steps=[]
 const add=(action,done,materials=[])=>steps.push({action,title:names[action],status:done?'done':'pending',materials:materials.map(([item,have,need])=>({item,have,need,missing:Math.max(0,need-have)}))})
 add('wood',timber>=9||n(s.target)>0,[['planks_equivalent',timber,9]])
 add('wooden_pickaxe',strong||n('wooden_pickaxe')>0,[['planks_equivalent',timber,3],['stick',n('stick'),2]])
 if(s.target!=='wooden_pickaxe'){
  add('gather_stone',strong||n('cobblestone')>=3,[['cobblestone',n('cobblestone'),3]])
  add('stone_pickaxe',strong,[['cobblestone',n('cobblestone'),3],['stick',n('stick'),2]])
 }
 if(iron){
  add('gather_stone',furnace||n('iron_ingot')>=needed||n('cobblestone')>=8,[['cobblestone',n('cobblestone'),8]])
  add('prepare_furnace',furnace||n('iron_ingot')>=needed,[['cobblestone',n('cobblestone'),8]])
  add('gather_iron',n('raw_iron')+n('iron_ingot')>=needed,[['raw_iron_or_ingot',n('raw_iron')+n('iron_ingot'),needed]])
  add('smelt_iron',n('iron_ingot')>=needed,[['iron_ingot',n('iron_ingot'),needed],['fuel_planks',timber,Math.ceil(Math.max(0,needed-n('iron_ingot'))/1.5)]])
  add(s.target,n(s.target)>0,[['iron_ingot',n('iron_ingot'),needed],['stick',n('stick'),s.target==='iron_sword'?1:2]])
 }
 if(n(s.target))for(const step of steps)step.status='done'
 steps.forEach((step,i)=>step.id=`step-${i+1}`)
 const next=steps.find(step=>step.status==='pending')
 const ore=(s.nearby||[]).filter(b=>['iron_ore','deepslate_iron_ore'].includes(b.name))
 return {target:s.target,inventory:s.inventory,steps,next:next?.action||'done',stoneNeeded:next?.action==='gather_stone'?next.materials[0].need:3,ironNeeded:needed,ironLocations:ore,ironKnowledge:ore.length?'observed':'unknown',locationNote:ore.length?'주변 청크에서 철광석을 확인했습니다. 실제 접근 경로는 이동하면서 검증합니다.':'현재 확인한 주변 40블록 안에서는 철광석을 찾지 못했습니다. 위치는 아직 모르며, 탐색 후 다시 조사합니다.'}
}
module.exports={buildRoadmap,names}
