const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const DIRECTIONS = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]]
const HAZARDS = new Set(['lava','fire','soul_fire','magma_block','cactus','powder_snow'])
function sector(position) { return `${Math.floor(position.x/8)},${Math.floor(position.z/8)}` }
function createExplorer(bot, { check, near, log }, file = path.join(__dirname,'logs/exploration.json')) {
  let saved = { visits: {}, failures: {}, resources: {} }
  try { saved = { ...saved, ...JSON.parse(fs.readFileSync(file)) } } catch {}
  let focus = [], last = null, phase = '대기'
  const prefix = () => `${process.env.MC_HOST||'127.0.0.1'}:${process.env.MC_PORT||25565}:${bot.game.dimension}:`
  const persist = () => { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file+'.tmp',JSON.stringify(saved)); fs.renameSync(file+'.tmp',file) }
  function observe(names=focus) {
    for (const name of names) {
      const positions = bot.findBlocks({matching:b=>b.name===name,maxDistance:48,count:16})
      saved.resources[prefix()+name] = positions.map(p=>({x:p.x,y:p.y,z:p.z,seen:Date.now()}))
    }
  }
  function safe(p) {
    const ground=bot.blockAt(p.offset(0,-1,0)), feet=bot.blockAt(p), head=bot.blockAt(p.offset(0,1,0))
    if (!ground||!feet||!head||ground.boundingBox!=='block'||ground.name.endsWith('_leaves')) return false
    if ([ground,feet,head].some(b=>HAZARDS.has(b.name)||b.name==='water')) return false
    const passable=b=>b.boundingBox==='empty'||bot.pathfinder.movements.safeToBreak(b)
    if (!passable(feet)||!passable(head)) return false
    return !Object.values(bot.entities||{}).some(e=>['creeper','zombie','skeleton','blaze','wither_skeleton'].includes(e.name)&&e.position.distanceTo(p)<6)
  }
  async function explore(token, options={}) {
    check(token); phase='경로 조사'
    const mode=options.mode||'surface', names=options.resources||focus
    if(options.resources)focus=[...names]
    observe(names)
    const observed=()=>names.flatMap(name=>(saved.resources[prefix()+name]||[]).map(p=>({name,...p})))
    if(options.resources?.length&&observed().length){persist();phase='자원 발견';return {position:bot.entity.position,resourceLocations:observed(),visited:Object.keys(saved.visits).filter(k=>k.startsWith(prefix())).length}}
    const origin=bot.entity.position.floored(), known=names.flatMap(name=>saved.resources[prefix()+name]||[])
      .filter(p=>Date.now()-p.seen<10*60*1000).map(p=>new Vec3(p.x,p.y,p.z))
    const candidates=[]
    for (const radius of [8,16,24].filter(r=>r<=(options.maxRadius||24))) for (const [dx,dz] of DIRECTIONS) {
      const length=Math.hypot(dx,dz)
      for(let dy=-8;dy<=6;dy++) {
        const p=origin.offset(Math.round(dx/length*radius),dy,Math.round(dz/length*radius))
        if(!safe(p)||(saved.failures[prefix()+p.toString()]||0)>Date.now())continue
        const visits=saved.visits[prefix()+sector(p)]||0
        const objective=known.length?Math.min(...known.map(q=>q.distanceTo(p))):0
        const score=objective*1.5+visits*24+Math.abs(dy)+(mode==='surface'?-dy*0.7:dy*0.4)+radius*0.08
        candidates.push({p,score})
      }
    }
    candidates.sort((a,b)=>a.score-b.score)
    const unique=[]
    for(const c of candidates)if(!unique.some(v=>v.p.distanceTo(c.p)<5))unique.push(c)
    for(const {p} of unique.slice(0,6)) {
      check(token);phase='탐색 이동';last={x:p.x,y:p.y,z:p.z}
      log({type:'message',text:`탐색: (${p.x}, ${p.y}, ${p.z}) · ${names.length?names.join(', '):'미방문 지형'}`})
      try {
        await near(p,1,token);check(token)
        const key=prefix()+sector(bot.entity.position);saved.visits[key]=(saved.visits[key]||0)+1
        observe(names);persist();phase=observed().length?'자원 발견':'관측 완료';return {position:last,resourceLocations:observed(),visited:Object.keys(saved.visits).filter(k=>k.startsWith(prefix())).length}
      } catch(e) { check(token);saved.failures[prefix()+p.toString()]=Date.now()+180000;log({type:'message',text:'탐색 경로 우회: '+e.message}) }
    }
    persist();phase='접근로 필요';throw new Error('미방문 경로 후보를 확인했지만 이동할 수 없습니다. 발판 또는 다른 출발 위치가 필요합니다.')
  }
  return {explore,setFocus:names=>{focus=[...names]},observe,status:()=>({phase,focus,last,visited:Object.keys(saved.visits).filter(k=>k.startsWith(prefix())).length,blocked:Object.entries(saved.failures).filter(([k,t])=>k.startsWith(prefix())&&t>Date.now()).length,resources:focus.flatMap(name=>(saved.resources[prefix()+name]||[]).map(p=>({name,...p})))})}
}
module.exports={createExplorer,sector,HAZARDS}
