const fs = require('node:fs')
const path = require('node:path')
const {randomUUID} = require('node:crypto')
const {Vec3} = require('vec3')
const {ROLES, position} = require('./village-config')
const {createLivestock, FEED, baby} = require('./livestock')
const {HOSTILES, canEngage, usableWeapon} = require('./combat')
const {safeFoods} = require('./campaign')
const ACTION_LABELS = {defend:'마을 방어',retreat:'위험 회피',food:'식량 확보·섭취',heal:'체력 회복',weapon:'경비 장비 준비',patrol:'마을 순찰',survey:'배정 부지 조사',gather:'건축 자재 확보',build:'마을 건물 건축',deposit:'수확물 보급',bread:'빵 제작',store_bread:'공유 창고 식량 보급',farm:'파종·수확·재파종',breed:'가축 번식',take_feed:'가축 먹이 확보',return:'마을로 복귀',inspect_stock:'공유 창고 재고 확인',priority_develop:'마을 개발 우선',priority_food:'식량 생산 우선',priority_defense:'마을 방어 우선',priority_livestock:'축산 우선',priority_maintain:'마을 유지 우선',wait:'역할 상황 관측'}
Object.assign(ACTION_LABELS,{hunt:'야생동물 사냥',hunt_search:'사냥 구역 탐색',cook_game:'사냥 식재료 조리',supply_game:'사냥 식량·재료 보급'})
const GAME_MEAT = new Set(['beef','porkchop','mutton','chicken','rabbit'])

function createVillageWorker(bot, hooks, profile) {
  if (!ROLES[profile?.role] || !Number.isInteger(profile.index) || profile.index < 1) throw new Error('Invalid village role')
  const {check, token, isReady, isBusy, run, near, structures, world, skills, acquire, food, send = () => {}, log = () => {}, now = Date.now, fetchImpl = fetch} = hooks
  const sleep = hooks.sleep || (ms => new Promise(r => setTimeout(r, ms)))
  const livestock = createLivestock(bot, {check, near, sleep, now, log})
  let assignment = null, shared = {}, running = false, epoch = 0, patrolIndex = profile.index - 1, huntingIndex = 0, lastStock = -Infinity, consecutiveFailures = 0
  let state = {role: profile.role, label: ROLES[profile.role], index: profile.index, active: process.env.BOT_VILLAGE_AUTOSTART !== '0', phase: '관리자 기준 위치 대기', action: null, priority: 'develop', stock: {}, nextCheck: 0, steps: 0, failures: 0, decision: null}
  if (hooks.file && fs.existsSync(hooks.file)) {
    const saved = JSON.parse(fs.readFileSync(hooks.file, 'utf8'))
    if (saved.role !== profile.role || saved.index !== profile.index) throw new Error('Saved village role differs; use a separate FLEET_LOG_DIR')
    state.active = saved.active !== false
  }
  const persist = () => {
    if (!hooks.file) return
    fs.mkdirSync(path.dirname(hooks.file), {recursive: true})
    fs.writeFileSync(hooks.file + '.tmp', JSON.stringify({role: state.role, index: state.index, active: state.active}) + '\n')
    fs.renameSync(hooks.file + '.tmp', hooks.file)
  }
  const locks = new Map()
  const items = () => bot.inventory.items()
  const count = n => items().filter(i => i.name === n).reduce((sum, i) => sum + i.count, 0)
  const toVec = p => new Vec3(p.x, p.y, p.z)
  function receive(message) {
    if (message.type === 'village_lock_result') {locks.get(message.id)?.(message.granted === true); return}
    if (message.type !== 'village_assignment') return
    const a = message.assignment
    if (a?.role !== profile.role || a.index !== profile.index || !position(a.center) || typeof a.dimension !== 'string') throw new Error('Invalid village assignment')
    if (assignment && (JSON.stringify(assignment.center) !== JSON.stringify(a.center) || assignment.dimension !== a.dimension)) throw new Error('Village center cannot change while a worker is running')
    assignment = a; shared = message.shared || {}; state.center = a.center; state.dimension = a.dimension
  }
  function setActive(active) {epoch++; state.active = !!active; state.nextCheck = 0; state.phase = active ? '역할 작업 재개' : '역할 작업 중지'; persist()}
  function protects(p) {return !!assignment && bot.game.dimension === assignment.dimension && assignment.areas.some(a => p.x >= a.minX && p.x <= a.maxX && p.z >= a.minZ && p.z <= a.maxZ && Math.abs(p.y - a.y) <= 16)}
  function protectsAnimal(entity) {
    if (!assignment || !Object.hasOwn(FEED, entity.name) || bot.game.dimension !== assignment.dimension || entity.position.distanceTo(toVec(assignment.center)) >= 40) return false
    if (baby(bot, entity) !== false) return true
    return Object.values(bot.entities).filter(e => e.name === entity.name && baby(bot, e) === false && e.position.distanceTo(toVec(assignment.center)) < 40).sort((a, b) => a.id - b.id).slice(0, 2).some(e => e.id === entity.id)
  }
  async function withStorage(currentToken, callback) {
    if (!shared.warehouse) throw new Error('공유 창고 건물이 아직 완성되지 않았습니다.')
    await near(toVec(shared.warehouse), 2, currentToken); check(currentToken)
    const id = randomUUID()
    const granted = await new Promise(resolve => {
      const timer = setTimeout(() => finish(false), 5000)
      function finish(value) {clearTimeout(timer); locks.delete(id); resolve(value)}
      locks.set(id, finish); send({type: 'village_lock', id})
    })
    if (!granted) throw new Error('공유 창고가 사용 중입니다. 다음 주기에 다시 확인합니다.')
    try {check(currentToken); return await callback(shared.warehouse)}
    finally {send({type: 'village_unlock', id})}
  }
  const store = (name, quantity, currentToken) => withStorage(currentToken, p => world.storage('store', name, quantity, currentToken, {position: p, existingOnly: true}))
  const take = (name, quantity, currentToken) => withStorage(currentToken, p => world.storage('take', name, quantity, currentToken, {position: p, existingOnly: true}))
  async function choose(options, observation) {
    const fallback = options[0]
    try {
      const criteria = Object.fromEntries(options.map(o => [o.id, o.description]))
      const response = await fetchImpl(process.env.LAYA_VILLAGE_ENDPOINT || (process.env.OLLAYA_URL || 'http://127.0.0.1:8091') + '/api/decide', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({model: 'laya:multilingual', state: JSON.stringify(observation), questions: {village_action: {type: 'choice', instructions: 'Select one feasible next action for this Minecraft villager. Respect its assigned role, current village priority, food, health and observed resources. Choose only an action listed below.', criteria}}})
      })
      if (!response.ok) throw new Error('Village Laya HTTP ' + response.status)
      const result = await response.json(), answer = result.answers?.village_action, action = options.find(o => o.id === answer?.choice)
      if (!action || result.state_truncated || result.usage?.truncated || !Number.isFinite(answer.probabilities?.[answer.choice] ?? answer.confidence) || (answer.probabilities?.[answer.choice] ?? answer.confidence) < .5 || (answer.probabilities?.[answer.choice] ?? answer.confidence) > 1) throw new Error('마을 역할 판단을 확인하지 못했습니다.')
      state.decision = {source: 'laya', model: result.model, action: action.id, confidence: answer.probabilities?.[answer.choice] ?? answer.confidence}
      return action
    } catch (error) {state.decision = {source: 'fallback', action: fallback.id, error: error.message}; return fallback}
  }
  function options(currentToken) {
    const out = [], add = (id, description, work) => out.push({id, description, work})
    const enemies = Object.values(bot.entities || {}).filter(e => !e.username && e.type !== 'player' && HOSTILES.has(e.name) && e.position.distanceTo(bot.entity.position) < 20).sort((a,b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    if (enemies.length) {
      if (profile.role === 'guard' && canEngage(bot, enemies)) add('defend', 'Defend villagers from an observed nearby hostile mob using ready equipment.', () => skills.defend(currentToken, {target: enemies[0].name}))
      add('retreat', 'Move away from observed hostile mobs to stay alive.', () => skills.retreat(enemies[0], currentToken))
      return out
    }
    if (bot.food < 18 || bot.health < 12 && bot.food < 20) {
      add('food', 'Eat or obtain food before working.', async () => {
        const meal = Object.keys(shared.stock || {}).find(n => safeFoods.has(n) && shared.stock[n] > 0)
        if (!items().some(i => safeFoods.has(i.name)) && shared.warehouse && meal) await take(meal, 1, currentToken)
        return food(currentToken)
      })
      return out
    }
    if (bot.health < 12) {add('heal', 'Rest with full hunger until health recovers.', async () => sleep(1000)); return out}
    if (profile.role === 'guard') {
      if (!usableWeapon(bot)) {add('weapon', 'Prepare a weapon before guarding.', () => skills.prepareWeapon(currentToken)); return out}
      add('patrol', 'Patrol the assigned village boundary waypoint.', async () => {const p = assignment.patrol[patrolIndex % assignment.patrol.length]; await near(toVec(p), 2, currentToken); check(currentToken); patrolIndex += 2; return {waypoint:p}})
    }
    if (profile.role === 'hunter') {
      if (!usableWeapon(bot)) {add('weapon', 'Prepare a weapon before hunting.', () => skills.prepareWeapon(currentToken)); return out}
      if (shared.warehouse) {
        const supply = items().find(i => safeFoods.has(i.name) && count(i.name) > 4 || ['leather','feather','white_wool'].includes(i.name) && count(i.name) > 0)
        if (supply) add('supply_game', 'Deliver hunting food and materials to the shared warehouse, preserving personal food.', () => store(supply.name, count(supply.name) - (safeFoods.has(supply.name) ? 4 : 0), currentToken))
      }
      const raw = items().find(i => GAME_MEAT.has(i.name))
      if (raw) add('cook_game', 'Cook gathered game meat for village food.', () => skills.cook(currentToken,{input:raw.name}))
      const onSide = e => profile.index === 1 ? e.position.x < assignment.center.x : e.position.x >= assignment.center.x
      const prey = Object.values(bot.entities || {}).filter(e => !e.username && e.type !== 'player' && (Object.hasOwn(FEED,e.name) || e.name === 'rabbit') && e.position && e.position.distanceTo(bot.entity.position) < 32 && e.position.distanceTo(toVec(assignment.center)) >= 40 && onSide(e) && !protectsAnimal(e)).sort((a,b) => a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))
      if (prey.length) add('hunt', 'Hunt an observed wild animal in this hunter\'s sector; protect village breeding livestock.', () => {
        const target = bot.entities[prey[0].id]
        if (!target || !onSide(target) || target.position.distanceTo(toVec(assignment.center)) < 40 || protectsAnimal(target)) throw new Error('사냥 대상이 이동했거나 마을 가축입니다.')
        return skills.huntTarget(target,currentToken)
      })
      if (!prey.length && !raw) add('hunt_search', 'Search this hunter\'s separate outer-village hunting route.', async () => {
        const destination = toVec(assignment.huntingRoute[huntingIndex % assignment.huntingRoute.length]), start = bot.entity.position, dx = destination.x-start.x, dz = destination.z-start.z, distance = Math.hypot(dx,dz)
        const step = distance > 32 ? start.offset(dx/distance*24,0,dz/distance*24).floored() : destination
        await near(step,3,currentToken); check(currentToken)
        if (distance <= 32) huntingIndex++
        return {waypoint:{...step}}
      })
    }
    if (profile.role === 'builder') {
      const kind = assignment.plot.design, building = structures.status(kind)
      if (!building.origin) add('survey', 'Validate and reserve this builder\'s exclusive plot.', () => structures.site(kind, currentToken, {origin: assignment.plot.origin}))
      else if (JSON.stringify(building.origin) !== JSON.stringify(assignment.plot.origin)) throw new Error('저장된 건축 부지가 배정된 마을 부지와 다릅니다.')
      else if (!building.complete) {
        const needed = structures.pendingMaterials(kind).find(m => m.missing > 0)
        add(needed ? 'gather' : 'build', needed ? 'Obtain the next missing building material.' : 'Continue the assigned building and verify actual blocks.', async () => {
          if (needed && shared.warehouse && shared.stock[needed.item] > 0) await take(needed.item, Math.min(needed.missing, shared.stock[needed.item]), currentToken)
          else if (needed) await acquire(needed.item, needed.need, currentToken)
          else return structures.build(kind, currentToken)
        })
      }
    }
    if (profile.role === 'farmer') {
      const crop = assignment.plot.crop, produce = require('./farming').CROPS[crop].produce, seed = require('./farming').CROPS[crop].seed
      if (shared.warehouse && count(produce) > (produce === seed ? 24 : 8)) add('deposit', 'Store surplus harvest in the shared warehouse while preserving seed and food stock.', () => store(produce, count(produce) - (produce === seed ? 24 : 8), currentToken))
      if (crop === 'wheat' && count('wheat') >= 12 && count('bread') < 4) add('bread', 'Craft bread for village food stock.', () => acquire('bread', 4, currentToken))
      if (shared.warehouse && count('bread') > 2) add('store_bread', 'Store bread for the other villagers.', () => store('bread', count('bread') - 2, currentToken))
      const farm = world.farmStatus().farms.find(f => f.crop === crop)
      if (!farm || !farm.complete || farm.ripe || now() >= (world.farmStatus().nextCheck || 0)) add('farm', 'Cultivate, harvest and replant this farmer\'s assigned field.', () => world.farm(currentToken, {crop}))
    }
    if (profile.role === 'rancher') {
      const observed = livestock.observe(assignment.center, assignment.animalLimit)
      if (observed.pair && !observed.atLimit) {
        const {food} = observed.pair
        if (count(food) >= 2) add('breed', 'Feed two observed adult animals and verify a newborn; keep the herd below its limit.', () => livestock.breed(assignment.center, assignment.animalLimit, currentToken))
        else if (shared.warehouse && shared.stock[food] >= 2) add('take_feed', 'Withdraw observed available animal feed from the shared warehouse.', () => take(food, 2, currentToken))
      }
      if (bot.entity.position.distanceTo(toVec(assignment.center)) > 16) add('return', 'Return to the village to observe livestock.', () => near(toVec(assignment.center), 4, currentToken))
    }
    if (profile.role === 'manager') {
      if (shared.warehouse && now() - lastStock >= 10000) {
        add('inspect_stock', 'Inspect actual shared warehouse inventory.', async () => {state.stock = await withStorage(currentToken, p => world.storageContents(p, currentToken)); lastStock = now()})
        return out
      }
      const meals = Object.entries(state.stock).filter(([n]) => safeFoods.has(n)).reduce((n, [, count]) => n + count, 0)
      const ordered = shared.threats > 0 ? ['defense','food','develop','livestock','maintain'] : shared.completedBuildings >= 4 ? meals < 16 ? ['food','livestock','maintain'] : ['livestock','maintain','food'] : ['develop','food','livestock']
      for (const priority of ordered) add('priority_' + priority, `Set village priority to ${priority}: observed buildings=${shared.completedBuildings || 0}, food stock=${meals}.`, async () => {state.priority = priority})
    }
    if (!out.length) add('wait', 'Wait and observe until crops, livestock, materials or construction need attention.', async () => sleep(500))
    return out
  }
  async function tick() {
    if (!state.active || !assignment || running || !isReady() || isBusy() || now() < state.nextCheck || bot.health <= 0) return
    if (bot.game.dimension !== assignment.dimension) {state.phase = '마을과 다른 차원 · 작업 대기'; return}
    running = true; const currentToken = token(), ownEpoch = epoch
    try {
      check(currentToken)
      const available = options(currentToken)
      const herd = profile.role === 'rancher' ? livestock.observe(assignment.center, assignment.animalLimit) : null
      const action = await choose(available, {role: state.label, role_index: state.index, village_priority: shared.priority || state.priority, health: bot.health, hunger: bot.food, inventory: items().map(i => ({name:i.name,count:i.count})), village: shared, livestock: herd ? {animals:herd.animals,babies:herd.babies,atLimit:herd.atLimit,pair:herd.pair?{animal:herd.pair.name,feed:herd.pair.food,ids:herd.pair.entities.map(e=>e.id)}:null} : undefined, available_actions: available.map(o => o.id)})
      check(currentToken); if (ownEpoch !== epoch || !state.active) return
      state.action = action.id; state.phase = ACTION_LABELS[action.id] || action.description; state.steps++
      log({type:'village_decision',role:profile.role,...state.decision})
      const result = await run(() => action.work()); check(currentToken)
      if (ownEpoch !== epoch) return
      consecutiveFailures = 0
      state.lastResult = result || null; state.nextCheck = now() + (profile.role === 'manager' && action.id !== 'inspect_stock' ? 10000 : action.id === 'wait' ? 5000 : 2000)
      log({type:'village_result',role:profile.role,action:action.id,ok:true,result})
    } catch (error) {
      if (ownEpoch !== epoch || currentToken !== token()) return
      state.failures++; consecutiveFailures++; state.phase = error.message; state.nextCheck = now() + Math.min(30000, 5000 * 2 ** Math.min(consecutiveFailures - 1, 3))
      log({type:'village_result',role:profile.role,action:state.action,ok:false,error:error.message})
    } finally {running = false}
  }
  return {receive, tick, setActive, isActive: () => state.active, isRunning: () => running, protects, protectsAnimal, area: () => assignment?.area || null, status: () => ({...state, assigned: !!assignment, running, livestock: livestock.status()})}
}
module.exports = {createVillageWorker}
