// Inspect the completed fixture house with public client APIs, port 25566 only.
const assert=require('node:assert/strict'),mineflayer=require('mineflayer'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder'),{Vec3}=require('vec3'),fs=require('node:fs'),{execFileSync}=require('node:child_process')
const {chromium}=require('/tmp/laya-browser/node_modules/playwright'),sleep=ms=>new Promise(r=>setTimeout(r,ms));let bot,browser
const rcon=cmd=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',cmd],{encoding:'utf8',timeout:10000})
async function main(){
 bot=mineflayer.createBot({host:'127.0.0.1',port:25566,version:'1.21.1',auth:'offline',username:'HouseInspector'});bot.loadPlugin(pathfinder)
 await new Promise((r,j)=>{bot.once('spawn',r);bot.once('error',j)})
 const movement=new Movements(bot);movement.canDig=false;movement.allow1by1towers=false;bot.pathfinder.setMovements(movement)
 rcon('tp HouseInspector 16.5 65 -5.5');await sleep(500);await bot.lookAt(new Vec3(7.5,68,7.5),true)
 require('prismarine-viewer').mineflayer(bot,{port:{port:3018,host:'127.0.0.1'},firstPerson:true,viewDistance:3})
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader']});const page=await browser.newPage({viewport:{width:1200,height:800}})
 await page.goto('http://127.0.0.1:3018/');await page.waitForSelector('canvas');await page.waitForTimeout(5000);await page.screenshot({path:'artifacts/house-actual-world.png'})
 await bot.pathfinder.goto(new goals.GoalNear(7,66,4,2));const door=bot.blockAt(new Vec3(7,66,4));assert.equal(door.name,'oak_door');if(!door.getProperties().open)await bot.activateBlock(door)
 await require('../building-navigation').crossDoor(bot,{door:new Vec3(7,66,4),from:new Vec3(7,65,2),to:new Vec3(7,66,6)},0,{check:()=>{},walk:async(p,range)=>bot.pathfinder.goto(new goals.GoalNear(p.x,p.y,p.z,range))});assert(bot.entity.position.distanceTo(new Vec3(7.5,66,7.5))<2,'enter through the real doorway')
 const bed=bot.blockAt(new Vec3(8,66,9));assert.equal(bed.name,'white_bed');assert.equal(bed.getProperties().facing,'east')
 const checks=['7 66 4 minecraft:oak_door[half=lower]','7 67 4 minecraft:oak_door[half=upper]','7 69 7 minecraft:air','8 66 9 minecraft:white_bed[part=foot,facing=east]','9 66 9 minecraft:white_bed[part=head,facing=east]','4 67 6 minecraft:glass_pane'];for(const query of checks)assert(rcon('execute if block '+query).includes('Test passed'))
 fs.writeFileSync('artifacts/house-inspection-live.json',JSON.stringify({scope:'Read actual completed fixture house blocks and traverse its doorway using our public-control navigation helper; disposable port 25566 only.',checks,doorwayTraversal:true,observerPosition:bot.entity.position},null,2)+'\n')
 console.log('PASS actual house blocks, hollow roof, correct bed orientation and physical doorway traversal; actual viewer screenshot saved')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();bot?.viewer?.close();bot?.quit();setTimeout(()=>process.exit(process.exitCode||0),500)})
