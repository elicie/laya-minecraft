const fs=require('node:fs'),path=require('node:path'),{Vec3}=require('vec3')
const CROPS={wheat:{title:'밀',block:'wheat',seed:'wheat_seeds',produce:'wheat',age:7},carrot:{title:'당근',block:'carrots',seed:'carrot',produce:'carrot',age:7},potato:{title:'감자',block:'potatoes',seed:'potato',produce:'potato',age:7},beetroot:{title:'비트',block:'beetroots',seed:'beetroot_seeds',produce:'beetroot',age:3}}
const point=p=>new Vec3(p.x,p.y,p.z)
function mature(block,crop){return block?.name===crop.block&&Number(block.getProperties().age)===crop.age}
function createFarming(bot,{check,near,acquire,sleep,log,area=()=>null},file=path.join(__dirname,'logs/farms.json')){
 let saved={farms:[]};try{saved=JSON.parse(fs.readFileSync(file))}catch{}
 let phase='대기',nextCheck=null
 const items=()=> (bot.currentWindow||bot.inventory).items(),count=n=>items().filter(i=>i.name===n).reduce((sum,i)=>sum+i.count,0)
 const dimension=()=>bot.game.dimension,server=`${process.env.MC_HOST||'127.0.0.1'}:${process.env.MC_PORT||25565}`
 const inArea=p=>{const a=area();return !a||p.x>=a.minX&&p.x<=a.maxX&&p.z>=a.minZ&&p.z<=a.maxZ&&p.y===a.y}
 const persist=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(saved));fs.renameSync(file+'.tmp',file)}
 function hydrated(p){for(let x=-4;x<=4;x++)for(let z=-4;z<=4;z++)for(let y=0;y<=1;y++)if(bot.blockAt(p.offset(x,y,z))?.name==='water')return true;return false}
 function inspect(farm){const crop=CROPS[farm.crop];let planted=0,ripe=0,wet=0,unloaded=0,light=0;for(const pos of farm.plots){const p=point(pos),soil=bot.blockAt(p),plant=bot.blockAt(p.offset(0,1,0));if(!soil||!plant){unloaded++;continue}if(soil.name==='farmland'&&(Number(soil.getProperties().moisture)>0||hydrated(p)))wet++;if(plant.name===crop.block){planted++;if(mature(plant,crop))ripe++}if(Math.max(plant.light||0,plant.skyLight||0)>=9)light++}return {id:farm.id,crop:farm.crop,title:crop.title,dimension:farm.dimension,plots:farm.plots.length,origin:farm.plots[0],planted,ripe,hydrated:wet,lit:light,unloaded,harvested:farm.harvested||0,cycles:farm.cycles||0,lastWork:farm.lastWork,complete:!unloaded&&planted===farm.plots.length}}
 function status(){return {phase,nextCheck,farms:saved.farms.filter(f=>f.server===server&&f.dimension===dimension()).map(inspect)}}
 async function pickup(p,token){for(const e of Object.values(bot.entities||{}).filter(e=>e.name==='item'&&e.position.distanceTo(p)<5)){check(token);try{await near(require('./pickup-navigation').pickupStand(bot,e.position),0,token);await sleep(300)}catch(e){check(token)}}}
 async function seedStock(crop,token,desired){if(count(crop.seed)>=desired)return
  const natural=bot.findBlocks({matching:b=>mature(b,crop),useExtraInfo:b=>inArea(b.position.offset(0,-1,0)),maxDistance:40,count:16})
  for(const p of natural){check(token);await near(p,2,token);const b=bot.blockAt(p);if(!mature(b,crop))continue;await bot.dig(b);await sleep(300);await pickup(p,token);if(count(crop.seed)>=desired)return}
  if(crop.seed==='wheat_seeds')await acquire(crop.seed,desired,token)
  else if(!count(crop.seed))throw new Error(`${crop.title} 종자 또는 익은 작물을 찾지 못했습니다. 종자를 확보해야 합니다.`)
 }
 async function select(cropKey,token){const crop=CROPS[cropKey];phase='농지·물 조사'
  const assignedArea=area()
  const searchPoint=assignedArea?new Vec3(Math.floor((assignedArea.minX+assignedArea.maxX)/2),assignedArea.y,Math.floor((assignedArea.minZ+assignedArea.maxZ)/2)):bot.entity.position
  const soils=bot.findBlocks({matching:b=>['farmland','dirt','grass_block'].includes(b.name),useExtraInfo:b=>inArea(b.position),point:searchPoint,maxDistance:40,count:1200})
   .filter(p=>inArea(p)&&hydrated(p)&&['air','short_grass','tall_grass',crop.block].includes(bot.blockAt(p.offset(0,1,0))?.name))
   .sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position))
  const origin=soils[0],plots=origin?soils.filter(p=>p.y===origin.y&&p.distanceTo(origin)<=5).slice(0,24):[]
  if(plots.length>=8)return plots
  // A compact 5×5 field needs one central source; protect existing structures.
  const assigned=area(),start=assigned?new Vec3(Math.floor((assigned.minX+assigned.maxX)/2),assigned.y+1,Math.floor((assigned.minZ+assigned.maxZ)/2)):bot.entity.position.floored();let site=null
  outer:for(const radius of [5,10,16])for(let x=-radius;x<=radius;x+=2)for(let z=-radius;z<=radius;z+=2)for(let dy=-5;dy<=1;dy++){
   check(token);const p=start.offset(x,dy,z),bottom=bot.blockAt(p.offset(0,-1,0));let safe=inArea(p)&&bottom?.boundingBox==='block'&&!['magma_block','lava','fire'].includes(bottom.name)
   for(let xx=-2;xx<=2&&safe;xx++)for(let zz=-2;zz<=2;zz++){const ground=bot.blockAt(p.offset(xx,0,zz)),above=bot.blockAt(p.offset(xx,1,zz));if(!inArea(p.offset(xx,0,zz))||!['dirt','grass_block','farmland'].includes(ground?.name)||!['air','short_grass','tall_grass'].includes(above?.name))safe=false}
   if(safe){site=p;break outer}
  }
  if(!site)throw new Error('물가 농지 또는 5×5 크기의 흙 부지가 없습니다. 물과 평지를 탐색합니다.')
  phase='관개 준비';await acquire('bucket',1,token)
  const water=bot.findBlock({matching:b=>b.name==='water'&&Number(b.getProperties().level)===0,maxDistance:48});if(!water)throw new Error('물 양동이에 채울 수원이 없습니다.')
  await near(water.position,2,token);await bot.equip(items().find(i=>i.name==='bucket'),'hand');await bot.lookAt(water.position.offset(0.5,0.5,0.5),true);await sleep(100);bot.activateItem();await sleep(400);check(token);if(!count('water_bucket'))throw new Error('물 양동이 채우기를 확인하지 못했습니다.')
  await near(site,2,token);const center=bot.blockAt(site);await bot.dig(center);check(token)
  // Enter the one-block irrigation hole so the bucket ray hits its bottom,
  // instead of the surrounding grass rim and placing water outside the field.
  await near(site,0,token);await bot.equip(items().find(i=>i.name==='water_bucket'),'hand');await bot.lookAt(site.offset(0.5,0,0.5),true);await sleep(100);bot.activateItem();await sleep(700);check(token);if(bot.blockAt(site)?.name!=='water')throw new Error(`중앙 수원 ${site} 설치를 확인하지 못했습니다. 손에 든 아이템: ${bot.heldItem?.name}`)
  const result=[];for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++)if(x||z)result.push(site.offset(x,0,z));return result
 }
 async function work(token,options={}){
  const cropKey=options.crop||'wheat',crop=CROPS[cropKey];if(!crop)throw new Error('지원 작물: 밀·당근·감자·비트')
  check(token);let farm=saved.farms.find(f=>f.server===server&&f.dimension===dimension()&&f.crop===cropKey)
  if(farm&&farm.plots.some(p=>!inArea(p)))throw new Error('저장된 농지가 배정된 마을 부지와 다릅니다.')
  const mealHarvest=()=>options.harvestOnly||options.forFood&&bot.food<18&&count(crop.produce)>=(options.produceTarget||1)
  const usableHoe=()=>items().find(i=>i.name.endsWith('_hoe')&&require('./resource-collector').toolLife(i)>2)
  if(options.harvestOnly&&!farm)throw new Error('수확할 기존 농장이 없습니다.')
  if(!farm){await seedStock(crop,token,8);const plots=await select(cropKey,token);farm={id:dimension()+':'+cropKey+':'+plots[0].toString(),server,dimension:dimension(),crop:cropKey,plots:plots.map(p=>({x:p.x,y:p.y,z:p.z})),harvested:0,cycles:0};saved.farms.push(farm);persist()}
  const first=point(farm.plots[0]);await near(first.offset(0,1,0),3,token)
  let harvested=0,planted=0
  phase='익은 작물 수확'
  for(const pos of farm.plots){check(token);if(mealHarvest()&&count(crop.produce)>=(options.produceTarget||1))break;const p=point(pos),plant=bot.blockAt(p.offset(0,1,0));if(!mature(plant,crop))continue;await near(plant.position,2,token);const before=count(crop.produce);await bot.dig(plant);await sleep(300);await pickup(plant.position,token);const gained=Math.max(0,count(crop.produce)-before);farm.harvested+=gained;harvested+=gained;persist()}
  if(mealHarvest()){farm.lastWork=new Date().toISOString();if(harvested)farm.cycles++;persist();const observation=inspect(farm);phase='식사용 수확 완료';nextCheck=Date.now()+2000;return {...observation,harvestedNow:harvested,plantedNow:0,waiting:!observation.ripe&&!harvested,nextCheck}}
  phase='경작·재파종'
  for(const pos of farm.plots){check(token);const p=point(pos),above=bot.blockAt(p.offset(0,1,0));if(above?.name===crop.block)continue;if(!above)continue
   if(['short_grass','tall_grass'].includes(above.name)){await near(above.position,2,token);await bot.dig(above)}else if(above.name!=='air')continue
   if(!hydrated(p))continue
   if(!count(crop.seed)){await seedStock(crop,token,Math.min(8,farm.plots.length));if(!count(crop.seed))break}
   await near(p.offset(0,1,0),2,token);const soil=bot.blockAt(p)
   if(soil?.name!=='farmland'){if(!['dirt','grass_block'].includes(soil?.name))continue;if(options.forFood&&!usableHoe())continue;if(!usableHoe())await acquire('stone_hoe',count('stone_hoe')+1,token);await bot.equip(usableHoe(),'hand');await bot.activateBlock(soil);await sleep(250);check(token);if(bot.blockAt(p)?.name!=='farmland')throw new Error('경작 상태를 확인하지 못했습니다.')}
   let placementError
   for(let attempt=0;attempt<3;attempt++){check(token);if(bot.blockAt(p.offset(0,1,0))?.name===crop.block)break
    try{await bot.equip(items().find(i=>i.name===crop.seed),'hand');await sleep(100);await bot._placeBlockWithOptions(bot.blockAt(p),new Vec3(0,1,0),{delta:new Vec3(0.5,0.9375,0.5),forceLook:true,swingArm:'right'});await sleep(150)}catch(e){check(token);placementError=e;await sleep(300)}
   }
   check(token);if(bot.blockAt(p.offset(0,1,0))?.name!==crop.block)throw new Error('재파종을 확인하지 못했습니다: '+(placementError?.message||p));planted++
  }
  farm.lastWork=new Date().toISOString();if(harvested)farm.cycles++;persist()
  const observation=inspect(farm);phase=observation.complete?'성장 대기':'농지 보강 필요';nextCheck=Date.now()+30000
  log({type:'message',text:`${crop.title} 농장: ${observation.planted}/${observation.plots} 파종 · 익음 ${observation.ripe} · 누적 수확 ${farm.harvested}개`})
  return {...observation,harvestedNow:harvested,plantedNow:planted,waiting:(options.forFood?observation.planted>0:observation.complete)&&!observation.ripe,nextCheck}
 }
 return {work,status,CROPS}
}
module.exports={createFarming,CROPS,mature}
