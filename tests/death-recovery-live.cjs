const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync,fork}=require('node:child_process')
assert.equal(Number(process.env.MC_TEST_PORT||25566),25566,'Administrative fixtures must use the disposable server')
const rcon=cmd=>execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',cmd],{encoding:'utf8',timeout:10000}),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),temp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-death-live-'))
let child,state,output='',stopOnDeath=false;const states=[]
async function wait(predicate,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(predicate())return;if(child?.exitCode!=null)throw new Error('Bot exited: '+output.slice(-2000));await sleep(100)}throw new Error('Timeout. Latest state: '+JSON.stringify({ready:state?.ready,job:state?.job,auto:state?.auto,recovery:state?.recovery})+'\n'+output.slice(-2000))}
async function main(){
 for(let i=0;i<60;i++){try{if(rcon('list').includes('players'))break}catch{}await sleep(500);if(i===59)throw new Error('Disposable server not ready')}
 for(const cmd of ['gamerule doMobSpawning false','gamerule keepInventory false','gamerule spawnRadius 0','time set 1000','forceload add -32 -32 32 32','fill -24 65 -24 24 71 24 minecraft:air','fill -24 64 -24 24 64 24 minecraft:grass_block','kill @e[type=minecraft:item]','setworldspawn 0 65 0'])rcon(cmd)
 child=fork(path.resolve('bot.js'),[],{execArgv:['--env-file-if-exists=.env'],env:{...process.env,MC_HOST:'127.0.0.1',MC_PORT:'25566',MC_USERNAME:'LayaDeathTest',MC_AUTH:'offline',BOT_LOG_DIR:temp,WEB_VIEWER:'0'},stdio:['ignore','pipe','pipe','ipc']})
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b.toString()).slice(-20000)})
 child.on('message',m=>{if(m.type==='state'){state=m;states.push({time:Date.now(),ready:m.ready,phase:m.recovery?.phase,enabled:m.auto?.enabled,request:m.auto?.request,index:m.auto?.index,inventory:m.inventory});if(stopOnDeath&&m.recovery?.phase==='리스폰 대기'){stopOnDeath=false;child.send({type:'command',text:'!stop'})}}})
 await wait(()=>state?.ready);await sleep(1500)
 rcon('clear LayaDeathTest');rcon('spawnpoint LayaDeathTest 0 65 0');rcon('give LayaDeathTest minecraft:apple 5');rcon('give LayaDeathTest minecraft:stone_pickaxe 1');rcon('tp LayaDeathTest 8.5 65 0.5')
 child.send({type:'command',text:'!auto 주변 경비해줘'});await wait(()=>state?.auto?.enabled);await sleep(700)
 const goal=state.auto.request,index=state.auto.index
 rcon('damage LayaDeathTest 16 minecraft:generic');await wait(()=>state?.health<6&&!state.auto.enabled)
 rcon('damage LayaDeathTest 1 minecraft:generic');await sleep(300);rcon('kill LayaDeathTest')
 await wait(()=>state?.recovery?.phase==='기존 목표 재개'&&state.auto.enabled,35000)
 const resumed=JSON.parse(JSON.stringify(state));assert.equal(resumed.auto.request,goal);assert.equal(resumed.auto.index,index)
 assert.equal(resumed.inventory.filter(i=>i.name==='apple').reduce((n,i)=>n+i.count,0),5,'actual death drops must be collected')
 assert.equal(resumed.inventory.filter(i=>i.name==='stone_pickaxe').reduce((n,i)=>n+i.count,0),1)
 assert(states.some(s=>s.phase==='리스폰 대기'&&!s.ready),'dead state must invalidate readiness')
 const events=fs.readFileSync(path.join(temp,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s))
 assert(events.some(e=>e.type==='death_recovery'&&e.phase==='사망 아이템 회수'))
 assert(events.some(e=>e.type==='death_recovery'&&e.phase==='목표 재개 준비'&&e.reason.includes('6개')))
 // A stop sent during the actual death interval must remain stopped after spawn.
 stopOnDeath=true;rcon('kill LayaDeathTest');await wait(()=>state?.ready&&state.recovery?.phase==='복구 중지'&&!state.auto.enabled);await sleep(3000);assert(!state.auto.enabled)
 fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/death-recovery-live.json',JSON.stringify({scope:'Production bot.js on disposable port 25566; isolated BOT_LOG_DIR; real death, normal Mineflayer respawn, public pathfinding pickup, exact saved goal and manual stop',firstDeath:{goal,index,returnedInventory:resumed.inventory,recovery:resumed.recovery},stopAfterDeath:{enabled:state.auto.enabled,recovery:state.recovery},events},null,2)+'\n')
 console.log('PASS production bot: low-health pause -> real death -> automatic respawn -> recover 5 apples and stone pickaxe -> resume same goal/index; stop during death cancels recovery and resumption')
}
main().catch(error=>{console.error(error);fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/death-recovery-live-failure.json',JSON.stringify({error:error.message,state,output},null,2));process.exitCode=1}).finally(async()=>{child?.kill('SIGTERM');await sleep(1000);fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0)})
