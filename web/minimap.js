(()=>{
 const $=id=>document.getElementById(id),canvas=$('minimap'),ctx=canvas.getContext('2d');let latest=null,extent=24
 function draw(){
  ctx.fillStyle='#1a252a';ctx.fillRect(0,0,canvas.width,canvas.height)
  const s=latest,map=s?.minimap,p=s?.position;if(!map||!p){ctx.fillStyle='#a8b9ba';ctx.font='13px sans-serif';ctx.textAlign='center';ctx.fillText('접속 후 주변 지형을 표시합니다',canvas.width/2,canvas.height/2);return}
  const scale=canvas.width/(extent*2),xy=(x,z)=>({x:canvas.width/2+(x-p.x)*scale,y:canvas.height/2+(z-p.z)*scale})
  for(let iz=0;iz<map.size;iz++)for(let ix=0;ix<map.size;ix++){const n=iz*map.size+ix,q=xy(map.center.x-map.radius+ix*map.step-.5,map.center.z-map.radius+iz*map.step-.5);ctx.fillStyle=map.palette[map.cells[n]];ctx.fillRect(q.x,q.y,map.step*scale+.4,map.step*scale+.4)}
  ctx.save();ctx.strokeStyle='#ffffff16';ctx.lineWidth=1;for(let k=-32;k<=32;k+=16){const q=xy(Math.floor(p.x/16)*16+k,Math.floor(p.z/16)*16+k);ctx.beginPath();ctx.moveTo(q.x,0);ctx.lineTo(q.x,canvas.height);ctx.moveTo(0,q.y);ctx.lineTo(canvas.width,q.y);ctx.stroke()}ctx.restore()
  for(const b of s.buildings||[]){if(!b.origin)continue;const d=s.buildingDimensions?.[b.kind]||{width:5,depth:5},q=xy(b.origin.x,b.origin.z);ctx.strokeStyle=b.complete?'#96f0c0':'#f0cb7b';ctx.lineWidth=2;ctx.setLineDash(b.built?[ ]:[4,3]);ctx.strokeRect(q.x,q.y,d.width*scale,d.depth*scale);ctx.setLineDash([])}
  for(const f of s.farming?.farms||[]){if(!f.origin)continue;const q=xy(f.origin.x,f.origin.z);ctx.fillStyle='#f3dc75';ctx.fillRect(q.x-3,q.y-3,6,6)}
  const death=s.recovery?.death;if(death?.dimension===map.dimension){const q=xy(death.position.x,death.position.z);ctx.strokeStyle='#ffbdcc';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(q.x-4,q.y-4);ctx.lineTo(q.x+4,q.y+4);ctx.moveTo(q.x+4,q.y-4);ctx.lineTo(q.x-4,q.y+4);ctx.stroke()}
  for(const e of s.mapMarkers||[]){const q=xy(e.x,e.z);ctx.fillStyle=({hostile:'#f07d74',player:'#e9f4ff',animal:'#e9caa1'})[e.type];ctx.beginPath();ctx.arc(q.x,q.y,e.type==='player'?3:2.3,0,Math.PI*2);ctx.fill()}
  // Minecraft yaw 0 faces south (+Z), pi/2 faces west (-X).
  const yaw=s.yaw||0,cx=canvas.width/2,cy=canvas.height/2,dx=-Math.sin(yaw),dz=Math.cos(yaw);ctx.fillStyle='#79eeef';ctx.strokeStyle='#153438';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(cx+dx*10,cy+dz*10);ctx.lineTo(cx-dx*6+dz*5,cy-dz*6-dx*5);ctx.lineTo(cx-dx*6-dz*5,cy-dz*6+dx*5);ctx.closePath();ctx.fill();ctx.stroke()
  $('mapCoords').textContent=`(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}) · ${extent*2}블록 범위`
 }
 $('mapToggle').onclick=()=>{const panel=canvas.closest('.minimap-panel'),collapsed=panel.classList.toggle('collapsed');$('mapToggle').setAttribute('aria-expanded',String(!collapsed));$('mapToggle').setAttribute('aria-label',collapsed?'미니맵 펼치기':'미니맵 접기');$('mapToggle').textContent=collapsed?'⌄':'⌃'};window.renderMinimap=s=>{latest=s;draw()};$('mapZoomIn').onclick=()=>{extent=Math.max(12,extent-6);draw()};$('mapZoomOut').onclick=()=>{extent=Math.min(30,extent+6);draw()};draw()
})()
