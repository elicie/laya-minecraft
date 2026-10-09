// Bounded survival preparation. This is an explicit planner, not a trained policy.
function nextTask(inventory,target='stone_pickaxe') {
 const count=name=>inventory.filter(i=>i.name===name).reduce((a,i)=>a+i.count,0)
 if(count(target))return null
 if(!inventory.some(i=>i.name.endsWith('_pickaxe'))) {
  const timber=inventory.filter(i=>i.name.endsWith('_log')||i.name.endsWith('_planks')).reduce((a,i)=>a+i.count,0)
  return timber<3?'wood':'wooden_pickaxe'
 }
 if(target==='wooden_pickaxe')return 'wooden_pickaxe'
 if(!count('stone_pickaxe')&&!count('iron_pickaxe'))return 'stone_pickaxe'
 return target
}
module.exports={nextTask}
