// Observation-only browser verification: the policy button never runs a skill.
const assert=require('node:assert/strict'),fs=require('node:fs')
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'/tmp/laya-browser/node_modules/playwright')
;(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader']})
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(process.env.DASHBOARD_URL||'http://127.0.0.1:3000/');await page.waitForFunction(()=>document.querySelector('#botStatus').textContent.includes('접속 중'))
  await page.waitForFunction(()=>document.querySelector('#houseDesignNote').textContent.includes('넓은'))
  const outside=await page.locator('#housePreview').evaluate(c=>c.toDataURL());await page.locator('#houseRoof').uncheck();assert.notEqual(await page.locator('#housePreview').evaluate(c=>c.toDataURL()),outside);await page.locator('#houseRotate').click();await page.locator('#houseRoof').check()
  assert((await page.locator('#recoveryStatus').textContent()).length)
  assert((await page.locator('#recoveryReason').textContent()).length)
  assert((await page.locator('#routineStatus').textContent()).length);assert((await page.locator('#routineDetails').textContent()).length);assert(await page.locator('#routineToggle').isEnabled())
  await page.waitForFunction(()=>document.querySelector('#mapCoords').textContent.includes('블록 범위'));assert(await page.locator('#minimap').isVisible());const mapImage=await page.locator('#minimap').evaluate(c=>c.toDataURL());await page.locator('#mapZoomIn').click();assert.notEqual(await page.locator('#minimap').evaluate(c=>c.toDataURL()),mapImage,'map zoom changes the observed view');await page.locator('#mapZoomOut').click();await page.locator('#mapToggle').click();assert.equal(await page.locator('#mapToggle').getAttribute('aria-expanded'),'false');assert(!await page.locator('#minimap').isVisible());await page.locator('#mapToggle').click()
  await page.locator('#houseDesign').selectOption('castle');assert((await page.locator('#houseDesignNote').textContent()).includes('15×15'));assert((await page.locator('#houseMaterials').textContent()).includes('stone_bricks'));const castleImage=await page.locator('#housePreview').evaluate(c=>c.toDataURL());await page.locator('#houseRoof').uncheck();assert.notEqual(await page.locator('#housePreview').evaluate(c=>c.toDataURL()),castleImage);await page.locator('#houseRotate').click();await page.locator('#houseRoof').check();await page.locator('[data-goal="유럽풍 성 지어줘"]').click();assert.equal(await page.locator('#autoGoal').inputValue(),'유럽풍 성 지어줘')
  // Verify the control's actual HTTP request without stopping the user's bot.
  let toggleRequest;await page.route('**/api/command',async route=>{toggleRequest=route.request().postDataJSON();await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'})});await page.locator('#routineToggle').click();await page.waitForTimeout(150);assert(['자율생활 켜기','자율생활 끄기'].includes(toggleRequest.text));await page.locator('[data-command="집으로 가"]').click();assert.equal(await page.locator('#command').inputValue(),'집으로 가');await page.locator('#execute').click();await page.waitForTimeout(150);assert.equal(toggleRequest.text,'집으로 가');await page.unroute('**/api/command')
  for(const id of ['nutritionStatus','farmStatus','combatStatus','collectionStatus','explorationStatus','buildingStatus'])assert((await page.locator('#'+id).textContent()).length)
  const foodResponse=page.waitForResponse(r=>r.url().endsWith('/api/policy/analyze'));await page.locator('#policyTest').click();assert((await (await foodResponse).json()).ok);await page.waitForFunction(()=>/학습된 Laya|기본 복구/.test(document.querySelector('#policySource').textContent))
  assert((await page.locator('#policyObservation').textContent()).includes('허기'))
  assert((await page.locator('#policyTraining').textContent()).includes('합성 상태 108개'))
  assert((await page.locator('#policyTraining').textContent()).includes('실제 게임 성공률과는 다릅니다'))
  await page.waitForFunction(()=>!document.querySelector('#policyCorrect').disabled);assert(await page.locator('#policyLabel option').count()>0)
  for(const domain of ['farm','build','collect','explore','fight']){
   await page.locator('#activityDomain').selectOption(domain);const response=page.waitForResponse(r=>r.url().endsWith('/api/activity/analyze'));await page.locator('#activityTest').click();const result=await (await response).json();assert.equal(result.decision.observation.domain,domain);assert.equal(result.decision.preview,true);await page.waitForFunction(()=>document.querySelector('#activityNotice').textContent.includes('실제 행동은 실행하지'))
  }
  assert((await page.locator('#activityTraining').textContent()).includes('합성 상태 180개'));await page.waitForFunction(()=>!document.querySelector('#activityCorrect').disabled);assert(await page.locator('#activityLabel option').count()>0)
  assert.equal(await page.locator('.mc-slot').count(),41)
  await page.locator('[data-goal="밀 농장 계속 관리해줘"]').click();assert.equal(await page.locator('#autoGoal').inputValue(),'밀 농장 계속 관리해줘')
  await page.waitForTimeout(12000);const frame=page.frames().find(f=>f.url().includes('/view/'));assert(frame,'live viewer iframe');assert(await frame.locator('canvas').count()>0,'live world canvas')
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/activity-dashboard-desktop.png',fullPage:true});await page.screenshot({path:'artifacts/castle-minimap-dashboard-desktop.png',fullPage:true})
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(1000);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');assert(await page.locator('#minimap').isVisible());await page.screenshot({path:'artifacts/activity-dashboard-mobile.png',fullPage:true});await page.screenshot({path:'artifacts/castle-minimap-dashboard-mobile.png',fullPage:true})
  assert.deepEqual(errors,[]);console.log('PASS live dashboard: minimap zoom/fold, European castle preview/interior/preset, five-domain activity and food previews, inventory/viewer, desktop/mobile layout, no page errors')
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)})
