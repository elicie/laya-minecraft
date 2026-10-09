// Browser-only response fixtures; do not execute commands in the user's world.
const assert=require('node:assert/strict'),{chromium}=require('/tmp/laya-browser/node_modules/playwright')
;(async()=>{
 const base=await fetch('http://127.0.0.1:3000/api/state').then(r=>r.json()),errors=[]
 let phase='작업 중 방어',active=true,serial=0
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}});page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/api/state',route=>{
   const state={...base,ready:true,viewerReady:false,job:'defend',recovery:{active:false},threatResponse:{active,phase,reason:'피격을 감지해 기존 목표를 보존합니다.',checkpoint:active?{mission:{request:'나무 16개 채집해줘',index:2}}:null,resumptions:active?0:1},events:[{id:'browser-threat-'+serial,type:'threat_response',time:new Date().toISOString(),phase,reason:'피격을 감지해 기존 목표를 보존합니다.'}]}
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(state)})
  })
  await page.goto('http://127.0.0.1:3000/');await page.waitForFunction(()=>document.querySelector('#threatStatus').textContent.includes('작업 중 방어'))
  assert((await page.locator('#threatStatus').textContent()).includes('나무 16개 채집해줘 / 3번째 단계'));assert((await page.locator('#autoStatus').textContent()).startsWith('위험 대응'))
  assert((await page.locator('#events').textContent()).includes('작업 중 위험 대응 · 작업 중 방어'))
  for(const next of ['작업 중 후퇴','식사·회복','주변 안전 확인','기존 작업 재개']){phase=next;serial++;active=next!=='기존 작업 재개';await page.waitForFunction(p=>document.querySelector('#threatStatus').textContent.includes(p),phase)}
  assert((await page.locator('#threatStatus').textContent()).includes('자동 재개 1회'))
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(700);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');assert.deepEqual(errors,[])
  console.log('PASS browser: attack/retreat/recovery/resume phases, saved goal and stage, visible event log, mobile layout, no world commands')
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
