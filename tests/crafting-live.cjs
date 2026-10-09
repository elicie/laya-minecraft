// Test only on the disposable validation server; ingredients are fixtures.
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process')
const mineflayer=require('mineflayer'),{createCrafting}=require('../crafting')
const PORT=Number(process.env.MC_TEST_PORT||25566);assert.equal(PORT,25566,'Never supply fixtures to the main server')
const rcon=command=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',command],{encoding:'utf8',timeout:10000})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const bot=mineflayer.createBot({host:'127.0.0.1',port:PORT,version:'1.21.1',username:'LayaCraftTest',auth:'offline'})
let generation=0
const check=token=>assert.equal(token,generation,'cancelled'),crafting=createCrafting(bot,{check,sleep})
const count=name=>bot.inventory.items().filter(i=>i.name===name).reduce((sum,i)=>sum+i.count,0)
async function main(){
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('spawn timeout')),15000);bot.once('spawn',()=>{clearTimeout(timer);resolve()});bot.once('error',reject);bot.once('kicked',reason=>reject(new Error(JSON.stringify(reason))))})
 rcon('gamerule doMobSpawning false');rcon('time set day');rcon('clear LayaCraftTest');rcon('fill -3 63 -3 3 63 3 minecraft:dirt');rcon('fill -3 64 -3 3 64 3 minecraft:grass_block');rcon('fill -3 65 -3 3 70 3 minecraft:air');rcon('setblock 2 65 0 minecraft:crafting_table');rcon('tp LayaCraftTest 0.5 65 0.5')
 for(const [name,n]of [['oak_log',16],['cobblestone',32],['iron_ingot',12],['wheat',9],['milk_bucket',3],['sugar',2],['egg',1]])rcon(`give LayaCraftTest minecraft:${name} ${n}`)
 await sleep(800);const table=bot.findBlock({matching:b=>b.name==='crafting_table',maxDistance:5});assert(table)
 await crafting.craft('oak_planks',8,null,0);assert.equal(count('oak_planks'),32);assert.equal(count('oak_log'),8);console.log('PASS actual repeated shapeless 2x2 crafting')
 await crafting.craft('stick',2,null,0);assert.equal(count('stick'),8);await crafting.craft('crafting_table',1,null,0);assert.equal(count('crafting_table'),1);console.log('PASS actual repeated shaped 2x2 crafting')
 for(const [name,n]of [['wooden_pickaxe',1],['stone_pickaxe',1],['iron_pickaxe',1],['iron_sword',1],['bread',2],['furnace',1],['chest',1]]){await crafting.craft(name,n,table,0);assert.equal(count(name),n);assert(!bot.currentWindow);console.log('PASS actual 3x3',name,n)}
 await crafting.craft('cake',1,table,0);assert.equal(count('cake'),1);assert.equal(count('bucket'),3);assert.equal(count('milk_bucket'),0);console.log('PASS server-returned ingredient containers recovered')
 const inventory=rcon('data get entity LayaCraftTest Inventory');for(const name of ['iron_pickaxe','iron_sword','bread','furnace','chest','cake','bucket'])assert(inventory.includes('minecraft:'+name),`server missing ${name}`)
 generation++;await assert.rejects(()=>crafting.craft('chest',1,table,0),/cancelled/);assert.equal(count('chest'),1);console.log('PASS cancellation before crafting mutation; server inventory confirms results')
 execFileSync('/home/elicie/tools/node22/bin/node',['tests/library-integrity.cjs'],{stdio:'inherit'})
}
const deadline=setTimeout(()=>{console.error('crafting live test timeout');process.exit(1)},120000)
main().then(()=>console.log('CRAFTING LIVE PASS')).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{clearTimeout(deadline);bot.quit();setTimeout(()=>process.exit(process.exitCode||0),300)})
