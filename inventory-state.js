function serializeItem(item,slot=item?.slot){
 if(!item)return null
 let used=null;try{used=item.durabilityUsed}catch{}
 const max=item.maxDurability||null
 return {slot,name:item.name,displayName:item.displayName,count:item.count,stackSize:item.stackSize,maxDurability:max,durability:max&&Number.isFinite(used)?Math.max(0,max-used):null}
}
function inventoryState(bot){
 const slots=Array.from({length:46},(_,i)=>serializeItem(bot.inventory?.slots[i],i))
 if(bot.currentWindow){const w=bot.currentWindow;for(let i=0;i<36;i++)slots[9+i]=serializeItem(w.slots[w.inventoryStart+i],9+i)}
 return {slots,inventory:slots.slice(9,45).filter(Boolean),selectedSlot:36+(bot.quickBarSlot||0),heldItem:serializeItem(bot.heldItem),cursorItem:serializeItem((bot.currentWindow||bot.inventory)?.selectedItem),container:bot.currentWindow?.type||null}
}
module.exports={serializeItem,inventoryState}
