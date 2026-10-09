// The same block coordinates drive both this preview and actual construction.
(()=>{
 const $=id=>document.getElementById(id),canvas=$('housePreview'),ctx=canvas.getContext('2d');let plans=[],angle=0
  const colors={wood:'#b38350',log:'#61442c',cobblestone:'#85878b',stone_bricks:'#afb2b6',torch:'#ffbe52',slab:'#bfa17a',glass_pane:'#9fd5db',door:'#704621',chest:'#b07532',bed:'#cd575c',crafting_table:'#82542e',furnace:'#71747a',wall_torch:'#ffbe52',fence:'#926c42',ladder:'#bc965c'}
 function draw(){
  const plan=plans.find(p=>p.kind===$('houseDesign').value);if(!plan)return
  const all=[...plan.cells,...plan.furniture],roof=$('houseRoof').checked
  const cells=all.filter(c=>roof||c.y<2)
  const turn=c=>{let x=c.x-plan.width/2,z=c.z-plan.depth/2;for(let i=0;i<angle;i++)[x,z]=[-z,x];return {a:x,b:-z}}
  const scale=Math.min(23,(canvas.width-60)/(plan.width+plan.depth)),project=(a,b,y)=>({x:canvas.width/2+(a-b)*scale,y:canvas.height*.77+(a+b)*scale*.28-y*scale*.95})
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#142124';ctx.fillRect(0,0,canvas.width,canvas.height)
  cells.sort((a,b)=>{const p=turn(a),q=turn(b);return p.a+p.b-q.a-q.b+(a.y-b.y)})
  for(const c of cells){const {a,b}=turn(c),h=c.material==='slab'?.5:c.material==='bed'?.55:1
   const base=colors[c.material]||'#b38350',poly=(points,shade)=>{ctx.beginPath();points.forEach(([x,z,y],i)=>{const p=project(x,z,y);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)});ctx.closePath();ctx.globalAlpha=c.material==='glass_pane'?.55:1;ctx.fillStyle=base;ctx.fill();if(shade){ctx.fillStyle=shade;ctx.fill()}ctx.strokeStyle='#14212466';ctx.lineWidth=.65;ctx.stroke();ctx.globalAlpha=1}
   poly([[a+1,b,c.y],[a+1,b+1,c.y],[a+1,b+1,c.y+h],[a+1,b,c.y+h]],'#00000025')
   poly([[a,b+1,c.y],[a+1,b+1,c.y],[a+1,b+1,c.y+h],[a,b+1,c.y+h]],'#00000044')
   poly([[a,b,c.y+h],[a+1,b,c.y+h],[a+1,b+1,c.y+h],[a,b+1,c.y+h]],'#ffffff12')
  }
  $('houseDesignNote').textContent=`${plan.title} · ${plan.kind==='castle'?`${plan.width}×${plan.depth} 부지 · ${plan.description}`:`실내 ${plan.width-2}×${plan.depth-2}`} · ${all.length}개 블록·가구 위치 · ${roof?'외관':'지붕과 윗벽을 제거한 내부 보기'}`
  $('houseMaterials').textContent=Object.entries(plan.requirements).map(([name,n])=>`${name} ${n}개`).join(' · ')
 }
 $('houseRotate').addEventListener('click',()=>{angle=(angle+1)%4;draw()});$('houseRoof').addEventListener('change',draw);$('houseDesign').addEventListener('change',draw)
 fetch('/api/buildings/designs').then(r=>{if(!r.ok)throw Error('설계 불러오기 실패');return r.json()}).then(p=>{plans=p;draw()}).catch(e=>{$('houseDesignNote').textContent=e.message})
})()
