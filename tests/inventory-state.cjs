const assert=require('node:assert/strict'),{inventoryState}=require('../inventory-state')
const pick={name:'stone_pickaxe',count:1,maxDurability:131,durabilityUsed:39,slot:37};const slots=Array(46).fill(null);slots[37]=pick
const bot={inventory:{slots},quickBarSlot:1,heldItem:pick};let s=inventoryState(bot);assert.equal(s.selectedSlot,37);assert.equal(s.slots[37].durability,92)
bot.currentWindow={inventoryStart:3,slots:Array(39).fill(null),type:'minecraft:furnace'};bot.currentWindow.slots[3]={name:'iron_ingot',count:2};s=inventoryState(bot);assert.equal(s.slots[9].name,'iron_ingot');assert.equal(s.slots[37],null);assert.equal(s.slots.length,46);console.log('PASS player/container slot mapping and real durability')
