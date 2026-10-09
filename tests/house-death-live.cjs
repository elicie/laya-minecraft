// Production bot, isolated state and disposable server only; all fixture
// materials are given before the goal. No fixture touches the user's world.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync,fork}=require('node:child_process')
const {designs,requirements,blueprint,furnishingPlan}=require('../structures')
const kind=process.env.HOUSE_TEST_DESIGN||'house',design=designs[kind];assert(['house','cabin'].includes(kind))
assert.equal(Number(process.env.MC_TEST_PORT||25566),25566)
const rcon=cmd=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',cmd],{encoding:'utf8',timeout:10000}),sleep=ms=>new Promise(r=>setTimeout(r,ms)),temp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-house-live-'))
const origin={x:4,y:65,z:4},recordKey='127.0.0.1:25566:overworld:'+kind;let child,state,output='',beforeDeath,afterDeath
async function wait(predicate,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(predicate())return;if(child?.exitCode!=null)throw Error('Bot exited: '+output.slice(-2000));if(state?.auto?.failures>=6)throw Error('Mission stopped: '+state.auto.reason);await sleep(200)}throw Error('Timeout: '+JSON.stringify({auto:state?.auto?.phase,reason:state?.auto?.reason,build:state?.buildings,recovery:state?.recovery,position:state?.position})+'\n'+output.slice(-2500))}
async function main(){
 for(const cmd of ['gamerule doMobSpawning false','gamerule doDaylightCycle false','gamerule keepInventory false','gamerule spawnRadius 0','time set 1000','kill @e[type=!minecraft:player]','forceload add -32 -32 32 32','fill -24 65 -24 0 82 24 minecraft:air','fill 1 65 -24 24 82 24 minecraft:air','fill -24 64 -24 24 64 24 minecraft:grass_block','setworldspawn -8 65 -8'])rcon(cmd)
 fs.writeFileSync(path.join(temp,'structures.json'),JSON.stringify({[recordKey]:{origin,wood:'oak',version:3}}))
 child=fork(path.resolve('bot.js'),[],{execArgv:['--env-file-if-exists=.env'],env:{...process.env,MC_HOST:'127.0.0.1',MC_PORT:'25566',MC_USERNAME:'LayaHouseTest',MC_AUTH:'offline',BOT_LOG_DIR:temp,WEB_VIEWER:'0'},stdio:['ignore','pipe','pipe','ipc']})
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b.toString()).slice(-30000)})
 let last='';child.on('message',m=>{if(m.type==='state'){state=m;const b=m.buildings?.[0],line=[m.job,m.auto?.phase,b?.built,b?.furnitureBuilt,m.recovery?.phase].join(' ');if(last!==line){console.log(line);last=line}}})
 await wait(()=>state?.ready);await sleep(1200);rcon('clear LayaHouseTest');rcon('spawnpoint LayaHouseTest -8 65 -8');rcon('tp LayaHouseTest -8.5 65 -8.5')
 for(const [name,n]of Object.entries({...requirements(kind),cobblestone:96,cooked_beef:32,stone_pickaxe:1}))rcon(`give LayaHouseTest minecraft:${name} ${n}`)
 await sleep(600);child.send({type:'command',text:kind==='house'?'!auto 넓은 나무집 지어줘':'!auto 작은 나무집 지어줘'})
 await wait(()=>state?.buildings?.[0]?.built>=24,60000);beforeDeath=structuredClone(state)
 rcon('damage LayaHouseTest 16 minecraft:generic');await wait(()=>state.health<6&&!state.auto.enabled);rcon('damage LayaHouseTest 1 minecraft:generic');await sleep(300);rcon('kill LayaHouseTest')
 await wait(()=>state?.recovery?.phase==='기존 목표 재개'&&state.auto.enabled,50000);afterDeath=structuredClone(state)
 assert.equal(afterDeath.auto.request,beforeDeath.auto.request);assert.equal(afterDeath.auto.index,beforeDeath.auto.index);assert.deepEqual(afterDeath.buildings[0].origin,origin);assert(afterDeath.buildings[0].built>=beforeDeath.buildings[0].built,'preserve actual placed blocks')
 await wait(()=>state?.auto?.phase==='목표 완료'&&state.buildings[0].complete,480000)
 const b=state.buildings[0];assert.equal(b.built,blueprint(kind,origin).length);assert.equal(b.furnitureBuilt,furnishingPlan(kind,origin).length)
 // Inspect actual server blocks rather than trusting only the dashboard count.
 const mid=origin.x+Math.floor(design.width/2),back=origin.z+design.depth-2
 for(const [p,block]of [[{x:mid,y:66,z:4},'oak_door[half=lower]'],[{x:mid,y:67,z:4},'oak_door[half=upper]'],[{x:mid,y:69,z:origin.z+Math.floor(design.depth/2)},'air'],[{x:origin.x+design.width-3,y:66,z:back},'white_bed[part=foot,facing=east]'],[{x:origin.x+design.width-2,y:66,z:back},'white_bed[part=head,facing=east]'],[{x:4,y:67,z:origin.z+Math.floor(design.depth/2)-1},'glass_pane']])assert(rcon(`execute if block ${p.x} ${p.y} ${p.z} minecraft:${block}`).includes('Test passed'),`actual block ${block} at ${JSON.stringify(p)}`)
 fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/'+kind+'-death-live.json',JSON.stringify({scope:'Production bot.js, provided materials before play, disposable port 25566. Real death and automatic same-goal recovery, followed by furnished house completion and server block checks. Does not prove full survival material acquisition.',beforeDeath:{goal:beforeDeath.auto.request,index:beforeDeath.auto.index,building:beforeDeath.buildings[0]},afterDeath:{goal:afterDeath.auto.request,index:afterDeath.auto.index,building:afterDeath.buildings[0],recovery:afterDeath.recovery},complete:b},null,2)+'\n')
 console.log('PASS real death -> same house/origin/progress -> hollow pitched roof, windows, usable doorway, east-facing bed and all furniture completed')
}
main().catch(e=>{console.error(e);fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/'+kind+'-death-live-failure.json',JSON.stringify({error:e.message,state,output},null,2));process.exitCode=1}).finally(async()=>{child?.kill('SIGTERM');await sleep(800);fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0)})
