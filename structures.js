const {Vec3}=require('vec3'),fs=require('node:fs'),path=require('node:path')
const {castleDesign,castleBlueprint,castleFurniture,castleEntrances}=require('./castle')
const designs={cabin:{title:'작은 나무집',width:5,depth:5,height:4,roof:'gable'},house:{title:'넓은 나무집',width:7,depth:7,height:4,roof:'gable'},warehouse:{title:'창고 건물',width:7,depth:5,height:4,roof:'flat'},tower:{title:'전망대',width:5,depth:5,height:7,roof:'flat'},bridge:{title:'짧은 다리',width:3,depth:9,height:1},castle:castleDesign}
const toVec=p=>new Vec3(p.x,p.y,p.z)
function legacyBlueprint(kind,origin={x:0,y:0,z:0}){
 const d={...designs[kind],roof:kind==='cabin'?'flat':designs[kind]?.roof};if(!d.width)throw new Error('알 수 없는 설계');const out=[],mid=Math.floor(d.width/2),middle=Math.floor(d.depth/2)
 const cell=(x,y,z,material,phase,extra={})=>out.push({x:origin.x+x,y:origin.y+y,z:origin.z+z,material,phase,...extra})
 for(let y=0;y<=d.height;y++)for(let x=0;x<d.width;x++)for(let z=0;z<d.depth;z++){
  const edge=x===0||z===0||x===d.width-1||z===d.depth-1,door=x===mid&&z===0&&(y===1||y===2)
  if(kind==='bridge'){if(y===0)cell(x,y,z,'wood','바닥');else if(x===0||x===d.width-1)cell(x,y,z,'fence','난간');continue}
  if(door)continue
  if(y===0||y===d.height||edge){if(kind==='tower'&&y===d.height&&x===1&&z===1)continue
   const window=y===2&&((x===mid&&z===d.depth-1)||((x===0||x===d.width-1)&&z===middle))
   cell(x,y,z,window?'glass_pane':'wood',y===0?'바닥':y===d.height?'지붕':window?'창문':'벽')
  }
 }
 if(d.roof==='gable')for(let level=0;level<=mid;level++)for(let x=level;x<d.width-level;x++)for(let z=0;z<d.depth;z++)cell(x,d.height+1+level,z,'wood','박공지붕')
 if(kind!=='bridge'){cell(mid,1,0,'door','출입문',{part:'lower'});cell(mid,2,0,'door','출입문',{part:'upper',generated:true})}
 return out
}
function blueprint(kind,origin={x:0,y:0,z:0},version=3){
 if(kind==='castle')return castleBlueprint(origin)
 if(version<3||!['cabin','house'].includes(kind))return legacyBlueprint(kind,origin)
 const d=designs[kind],out=[],mid=Math.floor(d.width/2),middle=Math.floor(d.depth/2)
 const cell=(x,y,z,material,phase,extra={})=>out.push({x:origin.x+x,y:origin.y+y,z:origin.z+z,material,phase,...extra})
 for(let x=0;x<d.width;x++)for(let z=0;z<d.depth;z++)cell(x,0,z,x===0||z===0||x===d.width-1||z===d.depth-1?'cobblestone':'wood','기초·실내 바닥')
 for(let x=mid-1;x<=mid+1;x++)cell(x,0,-1,'slab','현관')
 for(let y=1;y<d.height;y++)for(let x=0;x<d.width;x++)for(let z=0;z<d.depth;z++){
  const edge=x===0||x===d.width-1||z===0||z===d.depth-1,corner=(x===0||x===d.width-1)&&(z===0||z===d.depth-1)
  if(!edge||x===mid&&z===0&&y<3)continue
  const window=y===2&&((x===0||x===d.width-1)&&(z===middle-1||z===middle)||z===d.depth-1&&(x===mid-1||x===mid)&&x!==d.width-2)
  cell(x,y,z,corner?'log':window?'glass_pane':'wood',corner?'기둥':window?'창문':'벽')
 }
 for(const x of [-1,d.width])for(let z=0;z<d.depth;z++)cell(x,3,z,'wood','지붕 처마')
 for(let level=0;level<=mid;level++){
  for(const z of [0,d.depth-1])for(let x=level;x<d.width-level;x++)cell(x,d.height+level,z,'wood','박공 벽')
  for(const x of [...new Set([level,d.width-1-level])]){
   for(let z=1;z<d.depth-1;z++)cell(x,d.height+level,z,'wood','경사 지붕')
   for(const z of [-1,d.depth])cell(x,d.height+level,z,'wood','지붕 처마')
  }
 }
 cell(mid,1,0,'door','출입문',{part:'lower'});cell(mid,2,0,'door','출입문',{part:'upper',generated:true})
 return out
}
function furnishingPlan(kind,origin={x:0,y:0,z:0},version=3){const d=designs[kind],p=toVec(origin),out=[];const add=(x,y,z,material,face=new Vec3(0,1,0),ref=null,extra={})=>out.push({p:p.offset(x,y,z),material,face,reference:ref||p.offset(x,y-1,z),...extra})
 if(kind==='castle')return castleFurniture(origin)
 if(kind==='tower'){for(let y=1;y<=d.height;y++)add(1,y,1,'ladder',new Vec3(0,0,1),p.offset(1,y,0));return out}
 if(kind==='bridge')return out
 add(1,1,1,'chest');add(d.width-2,1,1,'crafting_table')
 if(kind==='warehouse'){add(d.width-2,1,d.depth-2,'chest');add(1,1,d.depth-2,'chest')}
 else if(version<3){add(1,1,d.depth-2,'bed',new Vec3(0,1,0),null,{facing:'north',part:'foot'});add(1,1,d.depth-3,'bed',null,null,{generated:true,part:'head'});add(d.width-2,1,d.depth-2,'furnace')}
 else{add(d.width-3,1,d.depth-2,'bed',new Vec3(0,1,0),null,{facing:'east',part:'foot'});add(d.width-2,1,d.depth-2,'bed',null,null,{generated:true,part:'head'});add(1,1,d.depth-2,'furnace')}
 add(1,2,1,'wall_torch',new Vec3(0,0,1),p.offset(1,2,0));add(d.width-2,2,d.depth-2,'wall_torch',new Vec3(0,0,-1),p.offset(d.width-2,2,d.depth-1))
 return out
}
function materialItem(material,wood='oak'){return ({wood:wood+'_planks',log:wood+'_log',slab:wood+'_slab',fence:wood+'_fence',door:wood+'_door',bed:'white_bed',wall_torch:'torch'})[material]||material}
function matches(block,material,part){if(!block)return false;const name=block.name;if(material==='wood')return name.endsWith('_planks');if(material==='log')return name.endsWith('_log')&&block.getProperties().axis==='y';if(material==='slab')return name.endsWith('_slab')&&block.getProperties().type==='bottom';if(material==='door')return name.endsWith('_door')&&(!part||block.getProperties().half===part);if(material==='bed')return name.endsWith('_bed')&&(!part||block.getProperties().part===part);if(material==='fence')return name.endsWith('_fence');return name===material}
function requirements(kind,wood='oak',version=3){const totals={};for(const c of [...blueprint(kind,undefined,version),...furnishingPlan(kind,undefined,version)])if(!c.generated){const name=materialItem(c.material,wood);totals[name]=(totals[name]||0)+1}return totals}
function constructionStand(bot,p){const candidates=[];for(const [dx,dz]of [[-2,0],[2,0],[0,-2],[0,2]])for(const dy of [0,1,-1,2,-2]){const q=p.offset(dx,dy,dz),feet=bot.blockAt(q),head=bot.blockAt(q.offset(0,1,0)),ground=bot.blockAt(q.offset(0,-1,0));if(feet?.boundingBox==='empty'&&head?.boundingBox==='empty'&&ground?.boundingBox==='block'&&!['lava','magma_block','fire','cactus'].includes(ground.name))candidates.push(q)}return candidates.sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position))[0]}
function designPreview(kind){return {...designs[kind],kind,version:3,cells:blueprint(kind),furniture:furnishingPlan(kind).map(({p,material,part,phase})=>({...p,material,part,phase})),requirements:requirements(kind)}}
function createStructures(bot,{check,near:walk,planks,log,acquire,sleep=ms=>new Promise(r=>setTimeout(r,ms))},file=path.join(__dirname,'logs/structures.json')){
 let sites={};try{sites=JSON.parse(fs.readFileSync(file))}catch{}
 let navigating=0,activeRecord=null
 async function near(p,range,token){navigating++;try{return await walk(p,range,token)}finally{navigating--}}
 function trackScaffold(oldBlock,newBlock){if(!navigating||!activeRecord||!newBlock||newBlock.boundingBox!=='block')return;const p=newBlock.position;activeRecord.scaffolds=activeRecord.scaffolds||[];if(!activeRecord.scaffolds.some(q=>p.equals(toVec(q)))){activeRecord.scaffolds.push({x:p.x,y:p.y,z:p.z,name:newBlock.name});save()}}
 const server=`${process.env.MC_HOST||'127.0.0.1'}:${process.env.MC_PORT||25565}`,key=kind=>server+':'+bot.game.dimension+':'+kind
 const save=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(sites));fs.renameSync(file+'.tmp',file)}
 function record(kind){const old=sites[key(kind)],rec=old?.origin?old:old?{origin:old,wood:'oak',version:1}:null;if(rec&&rec.version<3&&['cabin','house'].includes(kind)){const cells=blueprint(kind,rec.origin,rec.version);if(cells.every(c=>bot.blockAt(toVec(c)))&&!cells.some(c=>matches(bot.blockAt(toVec(c)),c.material,c.part))){rec.version=3;sites[key(kind)]=rec;save()}}return rec}
 const protectedCells=new Map()
 function ladderAccess(from,to){const rec=record('castle');if(!rec)return null;const p=toVec(rec.origin);if(from.y>=p.y+4||to.y<p.y+4||to.x<p.x||to.x>p.x+14||to.z<p.z||to.z>p.z+14)return null;return furnitureRoutes().filter(r=>{for(let y=1;y<=5;y++)if(bot.blockAt(r.bottom.offset(0,y-1,0))?.name!=='ladder')return false;return true}).sort((a,b)=>a.bottom.distanceTo(from)+a.top.distanceTo(to)-b.bottom.distanceTo(from)-b.top.distanceTo(to))[0]||null
  function furnitureRoutes(){return require('./castle').towers.map(t=>({bottom:p.offset(t.x+1,1,t.z+1),entry:p.offset(t.x+1,1,t.z+t.entry),wall:p.offset(t.x,1,t.z+1),top:p.offset(t.x,6,t.z+1)}))}}
 function doorCrossing(from,to){for(const kind of Object.keys(designs)){const rec=record(kind);if(!rec||kind==='bridge')continue;const p=toVec(rec.origin),d=designs[kind],routes=kind==='castle'?castleEntrances(rec.origin):[{inside:q=>q.x>=p.x+1&&q.x<p.x+d.width-1&&q.z>=p.z+1&&q.z<p.z+d.depth-1&&q.y>=p.y+1&&q.y<p.y+d.height,door:p.offset(Math.floor(d.width/2),1,0),outside:p.offset(Math.floor(d.width/2),0,-2),interior:p.offset(Math.floor(d.width/2),1,2)}];const crossing=routes.filter(r=>r.inside(to)!==r.inside(from)&&bot.blockAt(r.door)?.name.endsWith('_door'));const route=crossing.find(r=>r.inside(from))||crossing.at(-1);if(route){const enter=route.inside(to);return {door:route.door,from:enter?route.outside:route.interior,to:enter?route.interior:route.outside}}}return null}
 function protects(position){return Object.keys(designs).some(kind=>{const rec=record(kind);if(!rec)return false;const id=key(kind)+':'+rec.version+':'+JSON.stringify(rec.origin);if(!protectedCells.has(id))protectedCells.set(id,new Set([...blueprint(kind,rec.origin,rec.version),...furnishingPlan(kind,rec.origin,rec.version).map(f=>({...f.p}))].map(p=>`${p.x},${p.y},${p.z}`)));return protectedCells.get(id).has(`${position.x},${position.y},${position.z}`)})}
 function status(kind){const rec=record(kind),origin=rec?.origin,cells=blueprint(kind,origin,rec?.version),furniture=origin?furnishingPlan(kind,origin,rec.version):kind==='castle'?furnishingPlan(kind):[],built=origin?cells.filter(c=>matches(bot.blockAt(toVec(c)),c.material,c.part)).length:0,furnished=origin?furniture.filter(f=>matches(bot.blockAt(f.p),f.material,f.part)).length:0;const unloaded=origin?cells.filter(c=>!bot.blockAt(toVec(c))).length:0;const pending=origin?(cells.find(c=>!c.generated&&c.material!=='door'&&!matches(bot.blockAt(toVec(c)),c.material,c.part))||(furnished===furniture.length?cells.find(c=>!matches(bot.blockAt(toVec(c)),c.material,c.part)):null)):null;const stages=(designs[kind].stages||[]).map(title=>{const blocks=[...cells.filter(c=>c.phase===title),...(title==='가구·조명'?furniture:[])],done=origin?blocks.filter(c=>matches(bot.blockAt(c.p||toVec(c)),c.material,c.part)).length:0,needs={};for(const c of blocks)if(!c.generated){const name=materialItem(c.material,rec?.wood||'oak');needs[name]=(needs[name]||0)+1}return {title,total:blocks.length,built:done,complete:!!origin&&done===blocks.length,requirements:needs,remainingMaterials:blocks.filter(c=>!c.generated&&(!origin||!matches(bot.blockAt(c.p||toVec(c)),c.material,c.part))).reduce((out,c)=>{const name=materialItem(c.material,rec?.wood||'oak');out[name]=(out[name]||0)+1;return out},{})}});return {stages,kind,title:designs[kind].title,origin,wood:rec?.wood||'oak',version:rec?.version||3,unloaded,phase:unloaded?'청크 관측 대기':origin&&built===0?'재료 준비 · 미완성':pending?.phase||(!origin?'부지 조사':furnished<furniture.length?'가구·조명':'완료'),total:cells.length,built,remaining:cells.length-built,furnitureTotal:furniture.length,furnitureBuilt:furnished,requirements:requirements(kind,rec?.wood||'oak',rec?.version),complete:!!origin&&built===cells.length&&furnished===furniture.length}}
 function pendingMaterials(kind){
  const rec=record(kind);if(!rec||status(kind).unloaded)return []
  const cells=blueprint(kind,rec.origin,rec.version),pending=cells.filter(c=>!c.generated&&c.material!=='door'&&!matches(bot.blockAt(toVec(c)),c.material,c.part))
  if(!pending.length){pending.push(...furnishingPlan(kind,rec.origin,rec.version).filter(f=>!f.generated&&!matches(bot.blockAt(f.p),f.material,f.part)));pending.push(...cells.filter(c=>c.material==='door'&&!c.generated&&!matches(bot.blockAt(toVec(c)),c.material,c.part)))}
  if(!pending.length)return []
  const totals={};if(pending[0].y>rec.origin.y+3)totals.cobblestone=8;for(const c of pending.slice(0,12)){const name=materialItem(c.material,rec.wood);totals[name]=(totals[name]||0)+1}
  return Object.entries(totals).map(([item,need])=>{const have=bot.inventory.items().filter(i=>i.name===item).reduce((sum,i)=>sum+i.count,0);return {item,need,have,missing:Math.max(0,need-have)}})
 }
 const removable=b=>b&&(['short_grass','tall_grass','fern','large_fern','dandelion','poppy','snow','vine','dirt','grass_block','sand','gravel'].includes(b.name)||b.name.endsWith('_leaves')||b.name.endsWith('_log'))
 function siteCost(p,d){let cost=0,earth=0,fill=0;const top=d.height+(d.roof==='gable'?Math.floor(d.width/2)+1:0),margin=d.roof==='gable'?1:0
  for(let x=-margin;x<d.width+margin;x++)for(let z=-margin;z<d.depth+margin;z++){
   if(protects(p.offset(x,0,z)))return null
   const ground=bot.blockAt(p.offset(x,-1,z));if(d===designs.bridge&&z>0&&z<d.depth-1){if(!ground||ground.name==='lava')return null}
   else if(ground?.boundingBox!=='block'){if(!ground||ground.name!=='air'||bot.blockAt(p.offset(x,-2,z))?.boundingBox!=='block')return null;if(++fill>12)return null}
   else if(/leaves|log|planks/.test(ground.name))return null
   for(let y=0;y<=top;y++){const b=bot.blockAt(p.offset(x,y,z));if(!b)return null;if(['air','cave_air'].includes(b.name))continue;if(!removable(b))return null;if(['dirt','grass_block','sand','gravel'].includes(b.name)&&++earth>16)return null;cost+=b.name.endsWith('_log')?4:1}
  }return cost+fill*2
 }
 async function placeAt(p,material,token,reference=null,face=null,facing=null){
  check(token);if(matches(bot.blockAt(p),material))return
  // Thin ladders can be placed from inside their shaft. Standing outside a
  // three-wide tower leaves its wall between the player and the attachment.
  if(material==='ladder')await near(bot.blockAt(p.offset(0,-1,0))?.name==='ladder'?p.offset(0,-1,0):p,0,token)
  else await near(p,3,token)
  if(material==='ladder'){
   // A pathfinding goal accepts any point in the target cell. Center the body
   // so it does not intersect the thin ladder attached to the shaft wall.
   const sneaking=bot.getControlState('sneak');bot.setControlState('sneak',true)
   try{const until=Date.now()+1800;while(Math.hypot(p.x+.5-bot.entity.position.x,p.z+.5-bot.entity.position.z)>.045&&Date.now()<until){check(token);await bot.lookAt(new Vec3(p.x+.5,bot.entity.position.y+1.62,p.z+.5),true);bot.setControlState('forward',true);await sleep(40)}}finally{bot.setControlState('forward',false);bot.setControlState('sneak',sneaking)}
  }
  if(facing){let stand=facing==='east'?p.offset(-1,0,0):p.offset(0,0,1);if(bot.blockAt(stand)?.boundingBox==='block')stand=stand.offset(0,1,0);await near(stand,0,token)}
  if(material!=='ladder'&&(bot.entity.position.floored().equals(p)||bot.entity.position.floored().offset(0,1,0).equals(p))){const stand=constructionStand(bot,p);if(!stand)throw new Error('설치할 칸에서 비켜설 발판이 없습니다.');await near(stand,0,token)}
  const itemName=materialItem(material,activeWood),needed=bot.inventory.items().find(i=>i.name===itemName)||material==='wood'&&bot.inventory.items().find(i=>i.name.endsWith('_planks'))
  if(!needed)await acquire(itemName,1,token)
  const item=bot.inventory.items().find(i=>i.name===itemName)||material==='wood'&&bot.inventory.items().find(i=>i.name.endsWith('_planks'))
  if(!item)throw new Error('설치 재료가 없습니다: '+itemName)
  const options=reference?[{ref:reference,face}]:[new Vec3(0,-1,0),new Vec3(-1,0,0),new Vec3(1,0,0),new Vec3(0,0,-1),new Vec3(0,0,1)].map(off=>({ref:p.plus(off),face:off.scaled(-1)}))
  let placementError=''
  for(const option of options){check(token);const ref=bot.blockAt(option.ref);if(ref?.boundingBox!=='block')continue
   const sneaking=bot.getControlState('sneak')
   try{await bot.equip(item,'hand');bot.setControlState('sneak',true);await bot.placeBlock(ref,option.face);await sleep(150);check(token);if(matches(bot.blockAt(p),material))return}catch(e){check(token);placementError=e.message}finally{bot.setControlState('sneak',sneaking)}
  }throw new Error(`설치 위치 (${p.x}, ${p.y}, ${p.z})에 접근하지 못했습니다: ${material}${placementError?' · '+placementError:''}`)
 }
 let activeWood='oak'
 async function removeScaffold(p,token){const q=activeRecord?.scaffolds?.find(q=>p.equals(toVec(q)));if(!q||bot.blockAt(p)?.name!==q.name)return false;await near(p,3,token);check(token);const b=bot.blockAt(p);if(b?.name!==q.name)return false;const tool=bot.pathfinder.bestHarvestTool(b);if(tool)await bot.equip(tool,'hand');else await bot.unequip('hand');await bot.dig(b);check(token);activeRecord.scaffolds=activeRecord.scaffolds.filter(s=>!p.equals(toVec(s)));save();return true}
 async function clearSite(p,d,token){let removed=0;const top=d.height+(d.roof==='gable'?Math.floor(d.width/2)+1:0),margin=d.roof==='gable'?1:0;for(let y=top;y>=0;y--)for(let x=-margin;x<d.width+margin;x++)for(let z=-margin;z<d.depth+margin;z++){
  check(token);let b=bot.blockAt(p.offset(x,y,z));if(['air','cave_air'].includes(b?.name))continue;if(!removable(b))throw new Error('부지에 보호할 건물 블록이 있습니다.');await near(b.position,3,token);b=bot.blockAt(b.position);if(!removable(b))continue;const tool=bot.pathfinder.bestHarvestTool(b);if(tool)await bot.equip(tool,'hand');else await bot.unequip('hand');await bot.dig(b);if(++removed>=120)throw new Error('부지 정리 작업 한도입니다. 이어서 정리합니다.')}
  for(let x=0;x<d.width;x++)for(let z=0;z<d.depth;z++){const q=p.offset(x,-1,z);if(d===designs.bridge&&z>0&&z<d.depth-1)continue;if(bot.blockAt(q)?.name==='air')await placeAt(q,'dirt',token)}
 }
 async function site(kind,token,options={}){const existing=record(kind);
  if(options.origin){
   const origin=options.origin;if(!designs[kind]||!['x','y','z'].every(k=>Number.isInteger(origin[k])))throw new Error('배정 건축 부지 오류')
   if(existing){if(['x','y','z'].some(k=>existing.origin[k]!==origin[k]))throw new Error('저장된 건축 부지와 배정 부지가 다릅니다.');return}
   const p=toVec(origin),d=designs[kind];check(token);if(siteCost(p,d)===null)throw new Error('배정 부지가 평탄하지 않거나 보호할 블록이 있습니다.')
   await near(p.offset(-1,0,0),1,token);await clearSite(p,d,token);check(token)
   const logItem=bot.inventory.items().find(i=>i.name.endsWith('_log')),plank=bot.inventory.items().find(i=>i.name.endsWith('_planks'))
   const wood=plank?.name.replace('_planks','')||logItem?.name.replace('_log','')||'oak';sites[key(kind)]={origin:{...origin},wood,version:3};save();log({type:'message',text:d.title+' 마을 배정 부지 확정: '+p});return
  }
if(existing){const cells=blueprint(kind,existing.origin,existing.version);if(existing.version<3&&cells.every(c=>bot.blockAt(toVec(c)))&&!cells.some(c=>matches(bot.blockAt(toVec(c)),c.material,c.part))){existing.version=3;sites[key(kind)]=existing;save()}return;}const d=designs[kind],start=bot.entity.position.floored(),candidates=[];for(const radius of [4,8,14,20])for(let x=-radius;x<=radius;x+=3)for(let z=-radius;z<=radius;z+=3)for(let y=-6;y<=2;y++){check(token);const p=start.offset(x,y,z),cost=siteCost(p,d);if(cost!==null)candidates.push({p,cost:cost+p.distanceTo(start)})}candidates.sort((a,b)=>a.cost-b.cost)
  for(const {p} of candidates.slice(0,4)){try{await near(p.offset(-1,0,0),1,token);await clearSite(p,d,token)}catch(e){check(token);log({type:'message',text:'부지 정리: '+e.message});continue}
   const logItem=bot.inventory.items().find(i=>i.name.endsWith('_log')),plank=bot.inventory.items().find(i=>i.name.endsWith('_planks')),tree=bot.findBlock({matching:b=>b.name.endsWith('_log'),maxDistance:40})
   const wood=(plank?.name.replace('_planks','')||logItem?.name.replace('_log','')||tree?.name.replace('_log','')||'oak')
   sites[key(kind)]={origin:{x:p.x,y:p.y,z:p.z},wood,version:3};save();log({type:'message',text:`${d.title} 부지·설계 확정: ${p} · 문/창문/조명/가구 포함`});return
  }throw new Error(`${d.width}×${d.depth} 부지에 접근하지 못했습니다. 다른 지형을 탐색합니다.`)
 }
 async function build(kind,token){const movement=bot.pathfinder.movements,previous=movement.allow1by1towers;movement.allow1by1towers=true;try{
  await site(kind,token);const rec=record(kind);activeRecord=rec;bot.on('blockPlaced',trackScaffold);activeWood=rec.wood;let current=status(kind);if(current.unloaded){await near(toVec(rec.origin).offset(-2,0,-2),3,token);current=status(kind)}if(current.complete)return current
  if(pendingMaterials(kind).some(m=>m.item==='cobblestone'&&m.missing>0))await acquire('cobblestone',pendingMaterials(kind).find(m=>m.item==='cobblestone').need,token);let placed=0
  for(const c of blueprint(kind,rec.origin,rec.version)){check(token);const p=toVec(c);let block=bot.blockAt(p);if(matches(block,c.material,c.part)||c.generated||c.material==='door')continue
   if(!['air','cave_air'].includes(block?.name)){
    if(await removeScaffold(p,token))block=bot.blockAt(p)
    // Upgrade only the bot's recorded wooden wall cells into windows.
    if(c.material==='glass_pane'&&block?.name.endsWith('_planks')){await near(p,3,token);await bot.dig(block)}else if(!['air','cave_air'].includes(block?.name))throw new Error(`설계 위치에 다른 블록이 있습니다: ${block?.name||'미관측'}`)
   }
   if(c.material==='wood'&&!bot.inventory.items().some(i=>i.name.endsWith('_planks')))await planks(Math.min(24,current.remaining),token)
   await placeAt(p,c.material,token);if(++placed>=12)return status(kind)
  }
  const cells=blueprint(kind,rec.origin,rec.version),furniture=furnishingPlan(kind,rec.origin,rec.version)
  // Install tower ladders before removing temporary construction access.
  if(kind==='castle')for(const f of furniture.filter(f=>f.material==='ladder').sort((a,b)=>b.p.y-a.p.y)){if(!matches(bot.blockAt(f.p),'ladder'))await removeScaffold(f.p,token)}
  if(kind==='castle')for(const f of furniture.filter(f=>f.material==='ladder')){check(token);if(matches(bot.blockAt(f.p),f.material))continue;await placeAt(f.p,f.material,token,f.reference,f.face);if(++placed>=12)return status(kind)}
  // Keep the entrance open while moving materials and furniture inside.
  movement.allow1by1towers=false
  for(const q of [...(rec.scaffolds||[])].sort((a,b)=>b.y-a.y)){check(token);const p=toVec(q);if(cells.some(c=>p.equals(toVec(c))&&matches(bot.blockAt(p),c.material,c.part)))continue;await removeScaffold(p,token)}
  for(const f of furniture){check(token);if(matches(bot.blockAt(f.p),f.material,f.part)||f.generated)continue;if(!['air','cave_air'].includes(bot.blockAt(f.p)?.name))throw new Error(`가구 설치 위치 ${f.p}에 다른 블록이 있습니다: ${bot.blockAt(f.p)?.name}`);await placeAt(f.p,f.material,token,f.reference,f.face,f.facing);if(++placed>=12)return status(kind)}
  for(const c of cells.filter(c=>c.material==='door'&&!c.generated)){check(token);await placeAt(toVec(c),'door',token)}
  return status(kind)
 }finally{bot.removeListener('blockPlaced',trackScaffold);activeRecord=null;movement.allow1by1towers=previous}}
 return {status,site,build,pendingMaterials,protects,doorCrossing,ladderAccess,allStatus:()=>Object.keys(designs).filter(kind=>record(kind)).map(status)}
}
module.exports={constructionStand,designPreview,designs,blueprint,furnishingPlan,requirements,materialItem,matches,createStructures}
