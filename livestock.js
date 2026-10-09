const {Vec3} = require('vec3')
const FEED = {cow: ['wheat'], sheep: ['wheat'], pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds']}
function baby(bot, entity) {
  const index = bot.registry.entitiesByName[entity.name]?.metadataKeys?.indexOf('baby')
  return index >= 0 ? entity.metadata?.[index] === true : null
}
function createLivestock(bot, {check, near, sleep, now = Date.now, log = () => {}}) {
  const cooldowns = new Map()
  let state = {fed: 0, births: 0, phase: '가축 관측', lastResult: null}
  function observe(center, limit) {
    const origin = new Vec3(center.x, center.y, center.z)
    const animals = Object.values(bot.entities || {}).filter(e => !e.username && Object.hasOwn(FEED, e.name) && e.position?.distanceTo(origin) < 40)
    const key = e => e.uuid || e.id
    const adults = animals.filter(e => baby(bot, e) === false && (cooldowns.get(key(e)) || 0) <= now())
    const pairs = Object.keys(FEED).flatMap(name => {
      const group = adults.filter(e => e.name === name)
      const a = group[0], b = a && group.slice(1).find(e => e.position.distanceTo(a.position) < 8)
      return b ? [{name, entities: [a, b], food: FEED[name].find(n => bot.inventory.items().some(i => i.name === n && i.count >= 2)) || FEED[name][0]}] : []
    })
    return {animals: animals.length, babies: animals.filter(e => baby(bot, e) === true).length, atLimit: animals.length >= limit, pair: pairs[0] || null}
  }
  async function breed(center, limit, token) {
    check(token)
    const before = observe(center, limit), pair = before.pair
    if (before.atLimit || !pair) throw new Error('번식 가능한 성체 두 마리가 필요하거나 가축 수가 한도에 도달했습니다.')
    const items = () => bot.inventory.items(), count = () => items().filter(i => i.name === pair.food).reduce((n, i) => n + i.count, 0)
    if (count() < 2) throw new Error('가축 먹이 두 개가 필요합니다: ' + pair.food)
    const priorBabies = new Set(Object.values(bot.entities).filter(e => e.name === pair.name && baby(bot, e) === true).map(e => e.uuid || e.id))
    for (const entity of pair.entities) {
      check(token)
      if (!bot.entities[entity.id] || baby(bot, entity) !== false) throw new Error('가축 상태가 바뀌었습니다.')
      await near(entity.position, 2, token)
      await bot.equip(items().find(i => i.name === pair.food), 'hand')
      const stock = count()
      await bot.activateEntity(entity)
      for (let i = 0; i < 15 && count() >= stock; i++) {await sleep(100); check(token)}
      if (count() >= stock) throw new Error('서버에서 가축 먹이 소비를 확인하지 못했습니다.')
      cooldowns.set(entity.uuid || entity.id, now() + 300000)
      state.fed++
    }
    let born = false
    for (let i = 0; i < 30; i++) {
      check(token)
      born = Object.values(bot.entities).some(e => e.name === pair.name && baby(bot, e) === true && !priorBabies.has(e.uuid || e.id) && e.position.distanceTo(pair.entities[0].position) < 12)
      if (born) break
      await sleep(100)
    }
    if (born) state.births++
    state.phase = born ? '새끼 탄생 확인' : '먹이 소비 확인 · 번식 관측 중'
    state.lastResult = {animal: pair.name, fed: 2, birthConfirmed: born}
    log({type: 'livestock_result', ...state.lastResult})
    return state.lastResult
  }
  return {observe, breed, status: () => ({...state})}
}
module.exports = {FEED, baby, createLivestock}
