const $ = id => document.getElementById(id)
const cards = new Map()
const roleLabels = {guard: '경비병', builder: '건축가', farmer: '농부', manager: '관리자', rancher: '축산', hunter: '사냥꾼'}
const jobLabels = {idle: '작업 대기', follow: '따라가는 중', wood: '목재 채집', farm: '농사', build: '건축', village: '마을 작업', combat: '전투', food: '식량 확보', explore: '탐색'}
let latest = null, paused = false, focused = null, previousFocus = null, timer = null
let unavailable = false, showAll = false, selected = 'Manager'

function createCard(username) {
  const card = document.createElement('article')
  card.className = 'camera-card'
  card.dataset.username = username
  card.innerHTML = '<div class="camera-head"><div class="camera-title"><h2></h2><span class="camera-role"></span></div><span class="camera-status"></span><button type="button" class="camera-select">보기</button><button type="button" class="camera-close">확대 닫기 ×</button></div><div class="camera-view"><iframe hidden></iframe><div class="camera-wait"><span class="wait-cube" aria-hidden="true">◇</span><span class="wait-text"></span><small></small></div><button type="button" class="camera-open"><span>화면 확대 ↗</span></button></div><div class="camera-meta"><div class="camera-vitals"><span>체력 <b class="camera-health">—</b></span><span>허기 <b class="camera-food">—</b></span></div><p class="camera-job"></p><p class="camera-position"></p></div>'
  const find = selector => card.querySelector(selector)
  const entry = {card, title: find('h2'), role: find('.camera-role'), status: find('.camera-status'), frame: find('iframe'), wait: find('.camera-wait'), waitText: find('.wait-text'), hint: find('.camera-wait small'), open: find('.camera-open'), select: find('.camera-select'), close: find('.camera-close'), health: find('.camera-health'), food: find('.camera-food'), job: find('.camera-job'), position: find('.camera-position'), source: null}
  entry.title.textContent = username
  entry.title.id = 'camera-title-' + username
  entry.frame.title = username + ' 1인칭 관전 화면'
  entry.frame.tabIndex = -1
  entry.open.setAttribute('aria-label', username + ' 화면 확대')
  entry.open.onclick = () => expand(username)
  entry.select.setAttribute('aria-label', username + ' 메인으로 보기')
  entry.select.onclick = () => selectCamera(username)
  entry.close.onclick = collapse
  cards.set(username, entry)
  $('cameraGrid').append(card)
  return entry
}

function detach(entry) {
  if (entry.source !== null) entry.frame.removeAttribute('src')
  entry.source = null
  entry.frame.hidden = true
  entry.wait.hidden = false
}

function updateCard(bot, running) {
  const entry = cards.get(bot.username) || createCard(bot.username)
  const online = !unavailable && running && !!bot.ready
  const wanted = (showAll || bot.username === selected) && (!focused || bot.username === focused)
  const active = wanted && online && !!bot.viewerReady && !paused && !document.hidden && !unavailable
  const label = bot.label || roleLabels[bot.role] || '동료'
  entry.role.textContent = label
  entry.card.dataset.role = bot.role || 'companion'
  entry.card.classList.toggle('is-primary', !showAll && bot.username === selected)
  entry.card.classList.toggle('is-compact', !showAll && bot.username !== selected)
  entry.select.textContent = !showAll && bot.username === selected ? '메인' : '보기'
  entry.select.setAttribute('aria-pressed', String(!showAll && bot.username === selected))
  entry.card.dataset.state = active ? 'live' : online ? 'waiting' : 'offline'
  entry.status.textContent = unavailable ? '상태 확인 중' : active ? '관전 중' : online ? '접속됨' : '미접속'
  entry.health.textContent = online && Number.isFinite(bot.health) ? bot.health + ' / 20' : '—'
  entry.food.textContent = online && Number.isFinite(bot.food) ? bot.food + ' / 20' : '—'
  entry.job.textContent = online ? bot.village?.phase || jobLabels[bot.job] || bot.job || '작업 대기' : '접속 후 현재 작업을 표시합니다.'
  const p = bot.position
  entry.position.textContent = online && p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis])) ? `X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)}  Z ${p.z.toFixed(1)}` : '좌표 —'
  entry.waitText.textContent = unavailable ? '상태 연결이 끊겼습니다.' : paused ? '관전을 잠시 멈췄습니다.' : document.hidden ? '다른 창을 보는 동안 관전 대기' : !running ? '마을 봇 접속 대기' : !online ? '봇이 서버에 접속하는 중' : '관전 화면 준비 중'
  entry.hint.textContent = paused ? '관전을 재개하면 화면이 다시 연결됩니다.' : running && online && !bot.viewer ? '이 봇은 관전 화면이 꺼져 있습니다.' : '봇이 접속하면 화면이 자동으로 연결됩니다.'
  const expected = '/view/fleet/' + bot.username + '/'
  if (!active || bot.viewer?.url !== expected) return detach(entry)
  const source = expected + '?instance=' + encodeURIComponent(bot.viewer.instance || '')
  if (entry.source !== source) {
    entry.source = source
    entry.frame.src = source
  }
  entry.frame.hidden = false
  entry.wait.hidden = true
}

function render(status) {
  latest = status
  const bots = (status.bots || []).filter(bot => typeof bot.username === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(bot.username))
  const names = new Set(bots.map(bot => bot.username))
  if (!names.has(selected)) selected = bots.find(bot => bot.role === 'manager')?.username || bots[0]?.username || 'Manager'
  if (focused && !names.has(focused)) collapse()
  for (const [name, entry] of cards) if (!names.has(name)) {detach(entry); entry.card.remove(); cards.delete(name)}
  // Release the previous stream before connecting the selected camera.
  for (const [name, entry] of cards) if ((!showAll && name !== selected) || (focused && name !== focused)) detach(entry)
  for (const bot of bots) {
    updateCard(bot, status.running)
    if (focused && focused !== bot.username) cards.get(bot.username).card.inert = true
  }
  $('fleetStatus').textContent = unavailable ? '상태 연결 끊김' : status.running ? `${status.ready} / ${status.configured}명 접속` : '마을 봇 미접속'
  $('fleetStatus').classList.toggle('online', status.running && status.ready > 0 && !unavailable)
  $('serverAddress').textContent = '서버 · ' + (status.server || '확인 중')
  const center = status.village?.center
  $('villageCenter').textContent = center ? `마을 · X ${center.x}  Y ${center.y}  Z ${center.z}` : '마을 · 관리자 기준 위치 대기'
  $('viewCount').textContent = '관전 · ' + [...cards.values()].filter(entry => entry.source).length + '개 화면'
  $('fleetNotice').textContent = unavailable ? '접속 상태를 다시 확인하고 있습니다. 연결되면 화면을 자동으로 복구합니다.' : paused ? '관전을 일시정지했습니다. 봇은 계속 작업합니다.' : !status.running ? '마을 봇이 접속하면 메인 화면이 자동으로 열립니다.' : !status.viewerEnabled ? '마을 봇의 관전 화면이 꺼져 있습니다.' : showAll ? '12명 동시 관전 중입니다. 느리면 ‘한 명씩 관전’으로 전환하세요.' : `${selected}를 메인으로 관전합니다. 다른 봇의 ‘보기’를 누르면 화면이 전환됩니다.`
  $('allViews').textContent = showAll ? '한 명씩 관전' : '12명 동시 관전'
  $('allViews').setAttribute('aria-pressed', String(showAll))
}

function selectCamera(username) {
  collapse(false)
  selected = username
  showAll = false
  if (latest) render(latest)
}

function expand(username) {
  if (focused) collapse(false)
  const entry = cards.get(username)
  if (!entry) return
  previousFocus = document.activeElement
  focused = username
  entry.card.classList.add('is-expanded')
  entry.card.setAttribute('role', 'dialog')
  entry.card.setAttribute('aria-modal', 'true')
  entry.card.setAttribute('aria-labelledby', entry.title.id)
  for (const [name, other] of cards) other.card.inert = name !== username
  $('fleetHeader').inert = true
  $('fleetOverview').inert = true
  $('focusBackdrop').hidden = false
  document.body.classList.add('focus-open')
  if (latest) render(latest)
  entry.close.focus()
}

function collapse(refresh = true) {
  if (!focused) return
  const entry = cards.get(focused)
  if (entry) {
    entry.card.classList.remove('is-expanded')
    for (const name of ['role', 'aria-modal', 'aria-labelledby']) entry.card.removeAttribute(name)
  }
  for (const other of cards.values()) other.card.inert = false
  focused = null
  $('fleetHeader').inert = false
  $('fleetOverview').inert = false
  $('focusBackdrop').hidden = true
  document.body.classList.remove('focus-open')
  if (refresh && latest) render(latest)
  previousFocus?.focus()
}

$('managerView').onclick = () => selectCamera(latest?.bots?.find(bot => bot.role === 'manager')?.username || 'Manager')
$('allViews').onclick = () => {collapse(false); showAll = !showAll; if (latest) render(latest)}
$('focusBackdrop').onclick = collapse
document.addEventListener('keydown', event => {
  if (!focused) return
  if (event.key === 'Escape') {event.preventDefault(); collapse()}
  if (event.key === 'Tab') {event.preventDefault(); cards.get(focused)?.close.focus()}
})
$('pauseViews').onclick = () => {
  paused = !paused
  $('pauseViews').textContent = paused ? '관전 재개' : '관전 일시정지'
  $('pauseViews').setAttribute('aria-pressed', String(paused))
  if (latest) render(latest)
}

async function refresh() {
  clearTimeout(timer)
  if (document.hidden) return
  try {
    const response = await fetch('/api/fleet', {cache: 'no-store', signal: AbortSignal.timeout(5000)})
    if (!response.ok) throw new Error('Fleet status unavailable')
    const status = await response.json()
    unavailable = false
    render(status)
  } catch {
    unavailable = true
    if (latest) render(latest)
    else $('fleetNotice').textContent = '관전 연결을 확인하고 있습니다. 잠시 후 자동으로 다시 시도합니다.'
  } finally {if (!document.hidden) timer = setTimeout(refresh, 1000)}
}
document.addEventListener('visibilitychange', () => {
  clearTimeout(timer)
  if (document.hidden) {for (const entry of cards.values()) detach(entry)}
  else refresh()
})
window.addEventListener('pagehide', () => {clearTimeout(timer); for (const entry of cards.values()) detach(entry)})
refresh()
