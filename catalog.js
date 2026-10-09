const data=require('minecraft-data')('1.21.1')
function itemInfo(name){
 const item=data.itemsByName[name];if(!item)return null
 const recipes=(data.recipes[item.id]||[]).map(recipe=>{
  const counts=new Map(),ingredients=recipe.inShape?recipe.inShape.flat():recipe.ingredients||[]
  for(const ingredient of ingredients){const id=typeof ingredient==='number'?ingredient:ingredient?.id;if(id==null||id<0)continue;counts.set(id,(counts.get(id)||0)+(typeof ingredient==='number'?1:ingredient.count||1))}
  return {count:recipe.result.count,ingredients:[...counts].map(([id,count])=>({name:data.items[id]?.name||String(id),displayName:data.items[id]?.displayName||String(id),count}))}
 })
 return {name:item.name,displayName:item.displayName,stackSize:item.stackSize,maxDurability:item.maxDurability||null,recipes,version:'1.21.1'}
}
module.exports={itemInfo}
