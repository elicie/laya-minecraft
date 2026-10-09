// Isolated empty-world fixture checks browser renderer, not Minecraft gameplay.
const {EventEmitter}=require('node:events'),{Vec3}=require('vec3'),assert=require('node:assert/strict')
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'/tmp/laya-browser/node_modules/playwright')
const bot=new EventEmitter();bot.version='1.21.1';bot.username='RendererTest';bot.entities={};bot.entity={position:new Vec3(0,65,0),yaw:0,pitch:0};bot.world={getColumnAt:async()=>null}
require('prismarine-viewer').mineflayer(bot,{port:{port:3008,host:'127.0.0.1'},prefix:'/view',firstPerson:true,viewDistance:1})
const ticker=setInterval(()=>bot.emit('move'),100)
;(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader']});try{const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:3000/view/');await page.waitForSelector('canvas');await page.waitForFunction(()=>document.querySelector('canvas').width>0);await page.waitForTimeout(2000);assert.deepEqual(errors,[]);console.log('PASS WebGL viewer loads at /view/ with no browser JS errors (empty-world fixture)')}finally{await browser.close();clearInterval(ticker);bot.viewer.close()}})().catch(e=>{console.error(e);process.exit(1)})
