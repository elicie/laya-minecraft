const {Vec3}=require('vec3')
const castleDesign={title:'유럽풍 성',width:15,depth:15,height:7,roof:'mixed',description:'네 모서리 탑·성벽·성문·안뜰·박공지붕 본관',stages:['기초·안뜰','성벽·성문','모서리 탑','본관','본관 지붕','가구·조명']}
const towers=[{x:0,z:0,entry:2},{x:12,z:0,entry:2},{x:0,z:12,entry:0},{x:12,z:12,entry:0}]
function castleBlueprint(origin={x:0,y:0,z:0}){
 const out=new Map(),cell=(x,y,z,material,phase,extra={})=>out.set(`${x},${y},${z}`,{x:origin.x+x,y:origin.y+y,z:origin.z+z,material,phase,...extra})
 for(let z=0;z<15;z++)for(let x=0;x<15;x++)cell(x,0,z,x>=5&&x<=9&&z>=7&&z<=11?'wood':'cobblestone','기초·안뜰')
 for(let y=1;y<=3;y++)for(let n=3;n<=11;n++)for(const [x,z]of [[n,0],[n,14],[0,n],[14,n]]){
  if(x===7&&z===0&&y<3)continue
  cell(x,y,z,z===0&&x>=6&&x<=8?'stone_bricks':'cobblestone','성벽·성문')
 }
 for(let n=3;n<=11;n+=2)for(const [x,z]of [[n,0],[n,14],[0,n],[14,n]])cell(x,4,z,'stone_bricks','성벽·성문',{detail:'성벽 흉벽'})
 for(const t of towers){
  for(let y=1;y<=4;y++)for(let x=0;x<3;x++)for(let z=0;z<3;z++){
   if(x===1&&z===1||x===1&&z===t.entry&&y<3)continue
   const corner=x!==1&&z!==1,window=y===3&&x===1&&z===2-t.entry
   cell(t.x+x,y,t.z+z,window?'glass_pane':corner?'stone_bricks':'cobblestone','모서리 탑')
  }
  for(let x=0;x<3;x++)for(let z=0;z<3;z++)if(x!==1||z!==1)cell(t.x+x,5,t.z+z,'cobblestone','모서리 탑',{detail:'망루 바닥'})
  for(const x of [0,2])for(const z of [0,2])cell(t.x+x,6,t.z+z,'stone_bricks','모서리 탑',{detail:'탑 흉벽'})
 }
 for(let y=1;y<4;y++)for(let x=5;x<=9;x++)for(let z=7;z<=11;z++){
  if(x!==5&&x!==9&&z!==7&&z!==11||x===7&&z===7&&y<3)continue
  const window=y===2&&((x===5||x===9)&&z===9||x===7&&z===11)
  cell(x,y,z,window?'glass_pane':'stone_bricks','본관')
 }
 for(const x of [4,10])for(let z=7;z<=11;z++)cell(x,3,z,'wood','본관 지붕',{detail:'처마'})
 for(let level=0;level<=2;level++){
  for(const z of [7,11])for(let x=5+level;x<=9-level;x++)cell(x,4+level,z,'stone_bricks','본관 지붕',{detail:'박공 벽'})
  for(const x of [...new Set([5+level,9-level])])for(let z=6;z<=12;z++)if(z!==7&&z!==11)cell(x,4+level,z,'wood','본관 지붕',{detail:'경사 지붕'})
 }
 for(const z of [0,7]){cell(7,1,z,'door',z===0?'성벽·성문':'본관',{part:'lower'});cell(7,2,z,'door',z===0?'성벽·성문':'본관',{part:'upper',generated:true})}
 // Lower courses first; leave both doors open until furniture is installed.
 return [...out.values()].sort((a,b)=>a.y-b.y||castleDesign.stages.indexOf(a.phase)-castleDesign.stages.indexOf(b.phase)||(a.phase==='본관 지붕'?Number(a.material==='wood')-Number(b.material==='wood'):0)||a.z-b.z||a.x-b.x)
}
function castleFurniture(origin={x:0,y:0,z:0}){
 const p=new Vec3(origin.x,origin.y,origin.z),out=[]
 const add=(x,y,z,material,extra={})=>out.push({p:p.offset(x,y,z),material,phase:'가구·조명',face:new Vec3(0,1,0),reference:p.offset(x,y-1,z),...extra})
 for(const t of towers)for(let y=1;y<=5;y++)add(t.x+1,y,t.z+1,'ladder',{face:new Vec3(1,0,0),reference:p.offset(t.x,y,t.z+1),facing:'east'})
 add(6,1,8,'chest');add(8,1,8,'crafting_table')
 add(7,1,10,'bed',{facing:'east',part:'foot'});add(8,1,10,'bed',{part:'head',generated:true})
 add(6,1,10,'furnace')
 add(6,2,8,'wall_torch',{face:new Vec3(0,0,1),reference:p.offset(6,2,7)});add(8,2,10,'wall_torch',{face:new Vec3(0,0,-1),reference:p.offset(8,2,11)})
 add(3,1,7,'chest');add(11,1,7,'chest')
 for(const x of [3,11])for(const z of [4,10])add(x,1,z,'torch')
 return out
}
function castleEntrances(origin){const p=new Vec3(origin.x,origin.y,origin.z);return [
 {door:p.offset(7,1,7),outside:p.offset(7,1,5),interior:p.offset(7,1,9),inside:q=>q.x>=p.x+6&&q.x<p.x+9&&q.z>=p.z+8&&q.z<p.z+11&&q.y>=p.y+1&&q.y<p.y+4},
 {door:p.offset(7,1,0),outside:p.offset(7,0,-2),interior:p.offset(7,1,2),inside:q=>q.x>p.x&&q.x<p.x+14&&q.z>p.z&&q.z<p.z+14&&q.y>=p.y+1&&q.y<p.y+7}
]}
module.exports={castleDesign,castleBlueprint,castleFurniture,castleEntrances,towers}
