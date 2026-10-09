// Administrative fixtures are restricted to the disposable validation world.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const {spawn, execFileSync} = require('node:child_process')
const {members, loadVillageConfig, assignment} = require('../village-config')
const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-village-live-'))
const roster = members(), config = loadVillageConfig(path.join(root,'config/village.json'))
const rcon = cmd => execFileSync('docker',['exec','minecraft-laya-validation','rcon-cli',cmd],{encoding:'utf8',timeout:15000})
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms))
let fleet, output = '', latest
const read = () => {try {return JSON.parse(fs.readFileSync(path.join(directory,'status.json'),'utf8'))} catch {return null}}
async function wait(test, label, limit=120000) {
  const deadline = Date.now()+limit
  while(Date.now()<deadline) {
    if(fleet?.exitCode!==null&&fleet?.exitCode!==undefined)throw new Error('fleet exited: '+output.slice(-3000))
    latest=read()
    if(test(latest))return
    await sleep(300)
  }
  throw new Error(label+': '+JSON.stringify(latest?.bots.map(b=>({name:b.username,ready:b.ready,village:b.village})))+'\n'+output.slice(-1500))
}
async function main() {
  assert.equal(process.env.MC_TEST_PORT||'25566','25566')
  rcon('gamerule doMobSpawning false');rcon('gamerule doDaylightCycle false');rcon('gamerule spawnRadius 0');rcon('time set day')
  rcon('kill @e[type=!minecraft:player]')
  rcon('forceload add -64 -64 64 64');await sleep(2000)
  rcon('fill -60 63 -60 60 63 60 minecraft:stone')
  const filled=rcon('fill -60 64 -60 60 64 60 minecraft:grass_block');assert(!/not loaded|outside|too many/i.test(filled),filled)
  for(let y=65;y<79;y+=2)rcon(`fill -60 ${y} -60 60 ${y+1} 60 minecraft:air`)
  rcon('setworldspawn 0 65 0')
  fleet=spawn(process.execPath,['--env-file-if-exists=.env','fleet.js','--village','config/village.json'],{cwd:root,env:{...process.env,MC_HOST:'127.0.0.1',MC_PORT:'25566',MC_AUTH:'offline',MC_OWNERS:'',BOT_ONCE:'',BOT_COUNT:String(roster.length),BOT_VILLAGE_AUTOSTART:'0',FLEET_LOG_DIR:directory,OLLAYA_URL:'http://127.0.0.1:8091'},stdio:['pipe','pipe','pipe']})
  for(const stream of [fleet.stdout,fleet.stderr])stream.on('data',b=>{output+=b.toString();if(output.length>10000)output=output.slice(-10000)})
  await wait(s=>s?.ready===roster.length&&s.village?.center,'twelve roles connected and manager center observed',60000)
  const center=latest.village.center
  assert.equal(latest.village.dimension,'overworld')
  console.log('Twelve village roles connected; manager center '+JSON.stringify(center))
  for(const member of roster) {
    rcon(`clear ${member.username}`)
    rcon(`tp ${member.username} ${center.x+0.5} ${center.y} ${center.z+0.5}`)
    rcon(`give ${member.username} minecraft:bread 16`)
    if((member.role==='guard'||member.role==='hunter'))rcon(`give ${member.username} minecraft:stone_sword 1`)
    if(member.role==='builder')for(const [item,count]of Object.entries({oak_planks:128,oak_log:32,cobblestone:128,glass_pane:64,white_wool:12,torch:32,oak_door:8,white_bed:1,chest:3,crafting_table:1,furnace:1,ladder:16,oak_slab:32,stone_pickaxe:1}))rcon(`give ${member.username} minecraft:${item} ${count}`)
    if(member.role==='farmer') {
      rcon(`give ${member.username} minecraft:wheat_seeds 64`);rcon(`give ${member.username} minecraft:stone_hoe 1`)
      const plot=assignment(config,member,center,latest.village.dimension).plot.origin
      rcon(`setblock ${plot.x} ${plot.y} ${plot.z} minecraft:water`)
    }
    if(member.role==='rancher')rcon(`give ${member.username} minecraft:wheat 8`)
  }
  // A small test pen keeps the two real AI cows available for the breeding check.
  for(let n=-4;n<=0;n++)for(const [x,z]of [[n,-4],[n,0],[-4,n],[0,n]])rcon(`setblock ${center.x+x} ${center.y} ${center.z+z} minecraft:oak_fence`)
  rcon(`summon minecraft:cow ${center.x-2.5} ${center.y} ${center.z-2.5} {PersistenceRequired:1b}`)
  rcon(`summon minecraft:cow ${center.x-1.5} ${center.y} ${center.z-2.5} {PersistenceRequired:1b}`)
  const origins=Object.fromEntries(latest.bots.map(b=>[b.username,{...center}]))
  fleet.stdin.write('all 마을 시작\n')
  await wait(s=>s?.bots.every(b=>b.village?.assigned&&b.village.steps>0),'all twelve perform role actions')
  console.log('All twelve performed a role action')
  await wait(s=>s?.bots.filter(b=>b.village.role==='rancher').every(b=>b.village.livestock.births>=1),'actual calf born',90000)
  console.log('Actual calf birth observed by rancher')
  await wait(s=>s?.bots.filter(b=>b.village.role==='builder').every(b=>{
    const f=path.join(directory,b.username,'structures.json')
    if(!fs.existsSync(f))return false
    return Object.values(JSON.parse(fs.readFileSync(f))).some(r=>r.origin)
  }),'four assigned construction sites reserved')
  await wait(s=>s?.bots.filter(b=>b.village.role==='farmer').every(b=>{
    const f=path.join(directory,b.username,'farms.json')
    return fs.existsSync(f)&&JSON.parse(fs.readFileSync(f)).farms.length>0
  }),'two assigned farms created')
  await wait(s=>s?.bots.filter(b=>b.village.role==='guard').every(b=>b.village.action==='patrol'&&b.village.steps>=2),'guards patrolled',90000)
  await wait(s=>s?.bots.filter(b=>b.village.role==='builder').every(b=>{
    const events=fs.readFileSync(path.join(directory,b.username,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    return events.some(e=>e.type==='village_result'&&e.action==='build'&&e.ok)
  }),'four builders placed actual blocks')
  const evidence=[]
  for(const member of roster) {
    const events=fs.readFileSync(path.join(directory,member.username,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    assert(events.some(e=>e.type==='village_decision'&&e.source==='laya'&&e.model==='laya:multilingual'),member.username+' used native Laya role decisions')
    const expected=assignment(config,member,center,latest.village.dimension)
    if(member.role==='builder') {
      const records=Object.values(JSON.parse(fs.readFileSync(path.join(directory,member.username,'structures.json'))))
      assert(records.some(r=>JSON.stringify(r.origin)===JSON.stringify(expected.plot.origin)),'builder uses exclusive plot')
      assert(events.some(e=>e.type==='village_result'&&e.action==='build'&&e.ok),'builder placed actual blocks')
    }
    if(member.role==='farmer') {
      const farm=JSON.parse(fs.readFileSync(path.join(directory,member.username,'farms.json'))).farms[0]
      assert(farm.plots.every(p=>p.x>=expected.area.minX&&p.x<=expected.area.maxX&&p.z>=expected.area.minZ&&p.z<=expected.area.maxZ),'farmer stays inside allocated field')
      const plants=rcon(`execute if block ${farm.plots[0].x} ${farm.plots[0].y+1} ${farm.plots[0].z} minecraft:wheat`)
      assert.match(plants,/passed/i,'actual planted crop')
    }
    evidence.push({username:member.username,role:member.role,status:latest.bots.find(b=>b.username===member.username).village,decisions:events.filter(e=>e.type==='village_decision').map(e=>({action:e.action,source:e.source,model:e.model})),origin:origins[member.username]})
  }
  assert.match(rcon('list'),new RegExp(roster.length+' of a max of 16'))
  fleet.stdin.write('all !stop\n')
  await wait(s=>s?.bots.every(b=>b.village?.active===false&&!b.village.running),'all twelve manual stops respected',20000)
  const result={scope:'Disposable validation world on port 25566; flat prepared terrain, supplied building materials, seeds, food and two penned cows. Twelve production bot.js processes, native shared Laya GPU role decisions, manager-derived center, distinct construction sites and actual placement, actual crops, guard patrols, hunter role choices and confirmed calf birth. Hunter kills are not verified by this scenario. Does not test resource acquisition from an empty world, hostile-defense battles, full village completion or long campaigns.',center,roles:config.roles,errors:[],bots:evidence}
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/village-live.json'),JSON.stringify(result,null,2)+'\n')
  console.log('PASS twelve village roles; actual native Laya decisions; reserved plots and placed blocks; crops; patrols; confirmed calf; manual stop')
}
main().catch(error=>{console.error(error);for(const m of roster){const p=path.join(directory,m.username,'process.log');if(fs.existsSync(p))console.error(m.username+' '+fs.readFileSync(p,'utf8').slice(-700))}process.exitCode=1}).finally(async()=>{
  if(fleet?.exitCode===null){fleet.kill('SIGTERM');await sleep(4000);if(fleet.exitCode===null)fleet.kill('SIGKILL')}
  try{rcon('forceload remove -64 -64 64 64')}catch{}
  fs.rmSync(directory,{recursive:true,force:true})
})
