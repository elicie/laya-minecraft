const fs = require('node:fs')
const {designs} = require('./structures')

const ROLES = Object.freeze({guard: '경비병', builder: '건축가', farmer: '농부', manager: '관리자', rancher: '축산', hunter: '사냥꾼'})
const COUNTS = Object.freeze({guard: 2, builder: 4, farmer: 2, manager: 1, rancher: 1, hunter: 2})
const PREFIXES = {guard: 'Guard', builder: 'Builder', farmer: 'Farmer', manager: 'Manager', rancher: 'Rancher', hunter: 'Hunter'}
const PRIORITIES = ['develop', 'food', 'defense', 'livestock', 'maintain']
const position = p => p && ['x', 'y', 'z'].every(k => Number.isInteger(p[k]) && Math.abs(p[k]) <= 30000000)

function loadVillageConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (config.version !== 1) throw new Error('Village config version must be 1')
  for (const [role, count] of Object.entries(COUNTS)) {
    if (config.roles?.[role] !== count) throw new Error(`${role} count must be ${count}`)
  }
  if (Object.keys(config.roles).length !== Object.keys(COUNTS).length) throw new Error('Unknown village role')
  if (config.center != null && !position(config.center)) throw new Error('Village center must contain integer x, y, z')
  if (!Array.isArray(config.buildings) || config.buildings.length !== 4) throw new Error('Four building plots are required')
  if (!Array.isArray(config.farms) || config.farms.length !== 2) throw new Error('Two farm plots are required')
  const plots = [...config.buildings.map((p, i) => {
    if (!designs[p.design] || designs[p.design].width > 9 || designs[p.design].depth > 9) throw new Error('Village building requires a supported design up to 9 x 9')
    return {...p, width: designs[p.design].width + 4, depth: designs[p.design].depth + 4, margin: 2, id: 'building-' + (i + 1)}
  }), ...config.farms.map((p, i) => ({...p, width: 9, depth: 9, margin: 4, id: 'farm-' + (i + 1)}))]
  for (const p of plots) if (!Number.isInteger(p.x) || !Number.isInteger(p.z) || Math.abs(p.x) > 128 || Math.abs(p.z) > 128) throw new Error('Plot offsets must be integers within 128 blocks')
  for (let i = 0; i < plots.length; i++) for (const b of plots.slice(i + 1)) {
    const a = plots[i]
    if (a.x - a.margin < b.x - b.margin + b.width && a.x - a.margin + a.width > b.x - b.margin && a.z - a.margin < b.z - b.margin + b.depth && a.z - a.margin + a.depth > b.z - b.margin) throw new Error(`Village plots overlap: ${a.id}, ${b.id}`)
  }
  for (const p of config.farms) if (!['wheat', 'carrot', 'potato', 'beetroot'].includes(p.crop)) throw new Error('Unsupported village crop')
  if (!Number.isInteger(config.animalLimit) || config.animalLimit < 2 || config.animalLimit > 32) throw new Error('animalLimit must be 2..32')
  return {...config, plots}
}

function members() {
  return Object.entries(COUNTS).flatMap(([role, count]) => Array.from({length: count}, (_, i) => ({role, index: i + 1, username: 'Laya' + PREFIXES[role] + String(i + 1).padStart(2, '0')})))
}

function assignment(config, member, center, dimension) {
  const areas = config.plots.map(p => ({id: p.id, minX: center.x + p.x - p.margin, maxX: center.x + p.x - p.margin + p.width - 1, minZ: center.z + p.z - p.margin, maxZ: center.z + p.z - p.margin + p.depth - 1, y: p.id.startsWith('building-') ? center.y : center.y - 1}))
  const plot = member.role === 'builder' ? config.buildings[member.index - 1] : member.role === 'farmer' ? config.farms[member.index - 1] : null
  return {role: member.role, index: member.index, center, dimension, animalLimit: config.animalLimit, areas, area: areas.find(p => p.id === (member.role === 'builder' ? 'building-' : 'farm-') + member.index) || null, plot: plot ? {...plot, origin: {x: center.x + plot.x, y: center.y - (member.role === 'farmer' ? 1 : 0), z: center.z + plot.z}} : null, patrol: [[-24,-24],[24,-24],[24,24],[-24,24]].map(([x,z]) => ({x:center.x+x,y:center.y,z:center.z+z})), huntingRoute: (member.index === 1 ? [[-48,0],[-48,-32],[-48,32]] : [[48,0],[48,32],[48,-32]]).map(([x,z]) => ({x:center.x+x,y:center.y,z:center.z+z}))}
}

module.exports = {ROLES, COUNTS, PRIORITIES, loadVillageConfig, members, assignment, position}
