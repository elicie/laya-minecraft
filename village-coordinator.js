const fs = require('node:fs')
const path = require('node:path')
const {assignment, PRIORITIES, position} = require('./village-config')

function createVillageCoordinator(config, members, {file, server, send, now = Date.now}) {
  const reports = new Map()
  let center = config.center, dimension = null, priority = 'develop', stock = {}, warehouse = null, lock = null
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (saved.server !== server) throw new Error('Village state belongs to a different Minecraft server; use a separate FLEET_LOG_DIR')
    if (!position(saved.center) || typeof saved.dimension !== 'string') throw new Error('Invalid saved village center')
    if (center && JSON.stringify(center) !== JSON.stringify(saved.center)) throw new Error('Configured center differs from saved village; use a separate FLEET_LOG_DIR')
    center = saved.center; dimension = saved.dimension
  }
  function persist() {
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file + '.tmp', JSON.stringify({server, center, dimension}, null, 2) + '\n')
    fs.renameSync(file + '.tmp', file)
  }
  function receive(index, message) {
    const member = members[index - 1]
    if (!member) return
    if (message.type === 'village_lock') {
      if (lock && lock.until <= now()) lock = null
      const granted = !lock && !!warehouse
      if (granted) lock = {index, id: message.id, until: now() + 30000}
      send(index, {type: 'village_lock_result', id: message.id, granted})
      return
    }
    if (message.type === 'village_unlock') {
      if (lock?.index === index && lock.id === message.id) lock = null
      return
    }
    if (message.type !== 'state') return
    reports.set(index, {...message, receivedAt: now()})
    if (!center || !dimension) {
      if (member.role !== 'manager' || !message.ready || !message.position || !message.world?.dimension) return
      center ||= Object.fromEntries(['x','y','z'].map(k => [k, Math.floor(message.position[k])]))
      if (!position(center)) throw new Error('Invalid observed manager spawn')
      dimension = message.world.dimension; persist()
    }
    if (member.role === 'manager' && message.ready && message.world?.dimension === dimension) {
      if (PRIORITIES.includes(message.village?.priority)) priority = message.village.priority
      if (message.village?.stock && typeof message.village.stock === 'object') stock = message.village.stock
    }
    if (member.role === 'builder' && config.buildings[member.index - 1].design === 'warehouse' && message.ready && message.world?.dimension === dimension) {
      const building = message.buildings?.find(b => b.kind === 'warehouse' && b.complete && b.origin)
      if (building) warehouse = {x: building.origin.x + 1, y: building.origin.y + 1, z: building.origin.z + 1}
    }
  }
  function broadcast() {
    if (!center || !dimension) return
    const summary = {priority, stock, warehouse, completedBuildings: [...reports.values()].filter(r => r.ready && r.world?.dimension === dimension && now() - r.receivedAt < 10000).flatMap(r => r.buildings || []).filter(b => b.complete).length, threats: [...reports.values()].filter(r => r.ready && now() - r.receivedAt < 10000).reduce((n, r) => n + (r.combat?.threats?.length || 0), 0)}
    members.forEach((member, i) => send(i + 1, {type: 'village_assignment', assignment: assignment(config, member, center, dimension), shared: summary}))
  }
  function disconnected(index) {reports.delete(index); if (lock?.index === index) lock = null}
  return {receive, broadcast, disconnected, status: () => ({center, dimension, priority, warehouse, stock, roles: config.roles})}
}
module.exports = {createVillageCoordinator}
