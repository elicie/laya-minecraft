// Application-owned crafting. Mineflayer stays unmodified: use only public
// window/click APIs and observe the server-produced result before taking it.
function createCrafting(bot,{check,sleep}){
 const count=id=>(bot.currentWindow||bot.inventory).items().filter(i=>i.type===id).reduce((sum,i)=>sum+i.count,0)
 async function waitFor(predicate,token,message,timeout=5000){
  const deadline=Date.now()+timeout
  while(!predicate()){check(token);if(Date.now()>=deadline)throw new Error(message);await sleep(50)}
  check(token)
 }
 async function craft(name,batches,table,token){
  check(token);if(!Number.isInteger(batches)||batches<1)throw new Error('제작 횟수는 양의 정수여야 합니다.')
  const item=bot.registry.itemsByName[name],recipe=item&&bot.recipesFor(item.id,null,1,table).find(r=>r.delta.every(d=>d.count>=0||bot.inventory.count(d.id,d.metadata)+d.count*batches>=0))
  if(!recipe)throw new Error(`${name} 제작 재료가 부족해요.`)
  const before=count(item.id);let window
  try{
   window=table?await bot.openBlock(table):bot.inventory;check(token)
   if(table&&!window.type.startsWith('minecraft:crafting'))throw new Error('작업대 제작 창을 열지 못했습니다.')
   const width=table?3:2,pending=[]
   async function click(slot,button=0){
    check(token);const started=Date.now(),operation=bot.clickWindow(slot,button,0);pending.push(operation)
    // This library version waits for a changed output slot even for partial
    // ingredients. Allow the next input after a short interval; all pending
    // clicks are checked once the server reports the complete recipe result.
    await Promise.race([operation,sleep(200)]);await sleep(Math.max(0,200-(Date.now()-started)));check(token)
   }
   async function putCursorAway(){
    if(!window.selectedItem)return
    const cursor=window.selectedItem
    const room=window.slots.slice(window.inventoryStart,window.inventoryEnd).reduce((sum,slot)=>sum+(!slot?cursor.stackSize:slot.type===cursor.type?Math.max(0,slot.stackSize-slot.count):0),0)
    if(room<cursor.count)throw new Error('제작물을 넣을 인벤토리 공간이 부족합니다.')
    await bot.putSelectedItemRange(window.inventoryStart,window.inventoryEnd,window,null);await sleep(200);check(token)
   }
   async function clearGrid(){
    await putCursorAway()
    for(let slot=1;slot<=width*width;slot++)if(window.slots[slot]){await click(slot);await putCursorAway()}
    await waitFor(()=>!window.selectedItem&&window.slots.slice(1,width*width+1).every(i=>!i),token,'제작 재료 회수 시간 초과')
   }
   await clearGrid()
   const inputs=[]
   if(recipe.inShape){
    if(recipe.inShape.length>width||recipe.inShape.some(row=>row.length>width))throw new Error('제작 격자 크기가 맞지 않습니다.')
    recipe.inShape.forEach((row,y)=>row.forEach((ingredient,x)=>{if(ingredient.id!==-1)inputs.push({slot:1+x+y*width,ingredient})}))
   }else for(const ingredient of recipe.ingredients||[])for(let n=0;n<Math.abs(ingredient.count||1);n++)inputs.push({slot:inputs.length+1,ingredient})
   if(!inputs.length||inputs.length>width*width)throw new Error('제작 재료 배열을 처리할 수 없습니다.')
   for(let batch=0;batch<batches;batch++){
    for(const {slot,ingredient}of inputs){
     check(token)
     if(window.selectedItem?.type!==ingredient.id||ingredient.metadata!=null&&window.selectedItem.metadata!==ingredient.metadata){
      await putCursorAway();const source=window.findInventoryItem(ingredient.id,ingredient.metadata)
      if(!source)throw new Error(`${name} 제작 중 재료가 부족해졌습니다.`)
      await click(source.slot)
     }
     await click(slot,1)
    }
    await putCursorAway()
    await waitFor(()=>window.slots[0]?.type===recipe.result.id&&window.slots[0].count===recipe.result.count,token,'서버에서 제작 결과를 확인하지 못했습니다.')
    let timer
    try{await Promise.race([Promise.all(pending),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('제작 입력 확인 시간 초과')),5000)})])}finally{clearTimeout(timer)}
    check(token);pending.length=0
    await click(0);await putCursorAway();await clearGrid()
    await waitFor(()=>count(item.id)>=before+recipe.result.count*(batch+1),token,'제작 결과가 인벤토리에 없습니다.')
   }
  }finally{
   // Closing returns any remaining inputs/cursor through the server, including
   // cancellation. No fake slot events, model edits, or private sync calls.
   if(window)await bot.closeWindow(window)
  }
  await sleep(200);check(token)
  if(count(item.id)<before+recipe.result.count*batches)throw new Error('제작 창을 닫은 뒤 결과 수량이 맞지 않습니다.')
 }
 return {craft}
}
module.exports={createCrafting}
