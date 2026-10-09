// User-requested world setup: inspect natural terrain, then configure spawn.
// Does not place blocks, grant items, or run gameplay test fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process'),mineflayer=require('mineflayer'),{Vec3}=require('vec3')
const center={x:240,z:256},rcon=cmd=>execFileSync('docker',['exec','minecraft-laya-server','rcon-cli',cmd],{encoding:'utf8',timeout:10000}),sleep=ms=>new Promise(r=>setTimeout(r,ms))
const bot=mineflayer.createBot({host:'127.0.0.1',port:25565,version:'1.21.1',username:'LayaSpawnSurvey',auth:'offline'})
const bounds=[center.x-64,center.z-64,center.x+64,center.z+64],candidate=[]
function ground(x,z){for(let y=110;y>=50;y--){const b=bot.blockAt(new Vec3(x,y,z));if(!b)continue;if(b.boundingBox==='block'){if(!['grass_block','dirt'].includes(b.name))return null;const feet=bot.blockAt(b.position.offset(0,1,0)),head=bot.blockAt(b.position.offset(0,2,0));if(!feet||!head||feet.boundingBox!=='empty'||head.boundingBox!=='empty'||['water','lava'].includes(feet.name)||['water','lava'].includes(head.name))return null;return b}}return null}
async function main(){
 await new Promise((resolve,reject)=>{bot.once('spawn',resolve);bot.once('error',reject)})
 await sleep(1500)
 rcon(`forceload add ${bounds.join(' ')}`);rcon('time set 1000');console.log(rcon(`tp LayaSpawnSurvey ${center.x+.5} 64 ${center.z+.5}`).trim())
 await sleep(4000)
 console.log('Survey position',JSON.stringify(bot.entity.position))
 for(let x=center.x-40;x<=center.x+40;x+=4)for(let z=center.z-40;z<=center.z+40;z+=4){
  const g=ground(x,z);if(!g)continue
  const heights=[];let valid=true
  for(let dx=-8;dx<=8&&valid;dx++)for(let dz=-8;dz<=8;dz++){const b=ground(x+dx,z+dz);if(!b){valid=false;break}heights.push(b.position.y)}
  if(!valid)continue
  const span=Math.max(...heights)-Math.min(...heights);if(span>2)continue
  const trees=bot.findBlocks({matching:b=>b.name.endsWith('_log'),point:g.position,maxDistance:48,count:8}),water=bot.findBlock({matching:b=>b.name==='water',point:g.position,maxDistance:40})
  candidate.push({x,y:g.position.y+1,z,biome:null,span,area:'17x17 natural grass surface',treeDistance:trees.length?Math.min(...trees.map(p=>p.distanceTo(g.position))):null,waterDistance:water?.position.distanceTo(g.position)??null,score:span*20+(trees.length?0:30)+(water?0:15)+Math.hypot(x-center.x,z-center.z)*.05})
 }
 candidate.sort((a,b)=>a.score-b.score);assert(candidate.length,'No flat plains candidate found; do not configure an unmeasured spawn')
 const chosen=candidate.find(p=>rcon(`execute positioned ${p.x} ${p.y} ${p.z} if biome ~ ~ ~ minecraft:plains`).includes('Test passed'));assert(chosen,'Server did not confirm a flat candidate inside plains');chosen.biome='plains'
 rcon(`setworldspawn ${chosen.x} ${chosen.y} ${chosen.z}`);rcon('gamerule spawnRadius 0')
 fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/plains-spawn.json',JSON.stringify({seed:'625086861',scope:'Natural normal survival terrain; only spawn location configured',chosen,candidateCount:candidate.length},null,2)+'\n');console.log(JSON.stringify(chosen))
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{try{rcon(`forceload remove ${bounds.join(' ')}`)}catch{}bot.quit();setTimeout(()=>process.exit(process.exitCode||0),500)})
