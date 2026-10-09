// Read-only rendering adapter: the game bot keeps its native protocol/registry.
const {EventEmitter} = require('node:events')
const {Vec3} = require('vec3')
const minecraftData = require('minecraft-data')
const prismarineViewer = require('prismarine-viewer')

function createRenderAdapter(bot, targetVersion = prismarineViewer.supportedVersions.at(-1)) {
  const sourceData = minecraftData(bot.version), targetData = minecraftData(targetVersion)
  const SourceBlock = require('prismarine-block')(bot.version)
  const TargetBlock = require('prismarine-block')(targetVersion)
  const TargetChunk = require('prismarine-chunk')(targetVersion)
  const stateIds = new Map(), biomeIds = new Map(), columns = new Map(), listeners = []
  const adapter = new EventEmitter()
  adapter.version = targetVersion
  adapter.username = bot.username
  Object.defineProperties(adapter, {entity: {get: () => bot.entity}, entities: {get: () => bot.entities}})

  function stateId(id) {
    if (stateIds.has(id)) return stateIds.get(id)
    const source = SourceBlock.fromStateId(id, 0)
    const target = targetData.blocksByName[source.name]
    let mapped = target?.defaultState ?? targetData.blocksByName.stone.defaultState
    if (target) {
      const names = new Set((target.states || []).map(state => state.name))
      const properties = Object.fromEntries(Object.entries(source.getProperties()).filter(([name]) => names.has(name)))
      try {mapped = TargetBlock.fromProperties(target.name, properties, 0).stateId} catch {}
    } else if (source.boundingBox === 'empty') mapped = targetData.blocksByName.air.defaultState
    stateIds.set(id, mapped)
    return mapped
  }

  function biomeId(id) {
    if (!biomeIds.has(id)) biomeIds.set(id, targetData.biomesByName[sourceData.biomes[id]?.name]?.id ?? targetData.biomesByName.plains.id)
    return biomeIds.get(id)
  }

  function palette(json, map) {
    const data = JSON.parse(json)
    if (data.type === 'single') data.value = map(data.value)
    else if (data.type === 'indirect') data.palette = data.palette.map(map)
    return {json: JSON.stringify(data), direct: data.type === 'direct'}
  }

  function convertColumn(column) {
    const data = JSON.parse(column.toJson()), directSections = [], directBiomes = []
    data.sections = data.sections.map((json, i) => {
      const section = JSON.parse(json), mapped = palette(section.data, stateId)
      section.data = mapped.json
      section.noSizePrefix = false
      section.hasFluidCount = false
      section.fluidCount = 0
      if (mapped.direct) directSections.push(i)
      return JSON.stringify(section)
    })
    data.biomes = data.biomes.map((json, i) => {
      const mapped = palette(json, biomeId)
      if (mapped.direct) directBiomes.push(i)
      return mapped.json
    })
    const converted = TargetChunk.fromJson(JSON.stringify(data))
    for (const section of directSections) for (let i = 0; i < 4096; i++) {
      const pos = new Vec3(i & 15, data.minY + section * 16 + (i >> 8), (i >> 4) & 15)
      converted.setBlockStateId(pos, stateId(column.getBlockStateId(pos)))
    }
    for (const section of directBiomes) for (let y = 0; y < 16; y += 4) for (let z = 0; z < 16; z += 4) for (let x = 0; x < 16; x += 4) {
      const pos = new Vec3(x, data.minY + section * 16 + y, z)
      converted.setBiome(pos, biomeId(column.getBiome(pos)))
    }
    return converted
  }

  const key = pos => `${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`
  adapter.world = {
    getColumnAt: async pos => {
      const column = await bot.world.getColumnAt(pos)
      if (!column) return null
      const id = key(pos), cached = columns.get(id)
      if (cached?.source === column) return cached.converted
      const converted = convertColumn(column)
      columns.set(id, {source: column, converted})
      while (columns.size > 64) columns.delete(columns.keys().next().value)
      return converted
    },
    raycast: (...args) => bot.world.raycast(...args)
  }

  function listen(event, callback) {bot.on(event, callback); listeners.push([event, callback])}
  for (const event of ['move', 'entitySpawn', 'entityMoved', 'entityGone']) listen(event, (...args) => adapter.emit(event, ...args))
  for (const event of ['chunkColumnLoad', 'chunkColumnUnload']) listen(event, pos => {columns.delete(key(pos)); adapter.emit(event, pos)})
  listen('blockUpdate', (oldBlock, newBlock) => {
    const id = stateId(newBlock.stateId), pos = newBlock.position
    columns.get(key(pos))?.converted.setBlockStateId(new Vec3(pos.x & 15, pos.y, pos.z & 15), id)
    adapter.emit('blockUpdate', oldBlock, {position: pos, stateId: id})
  })
  adapter.dispose = () => {
    for (const [event, callback] of listeners) bot.removeListener(event, callback)
    columns.clear()
    adapter.removeAllListeners()
  }
  return {adapter, convertColumn, stateId}
}

function createBotViewer(bot, options) {
  const adapted = prismarineViewer.supportedVersions.includes(bot.version) ? null : createRenderAdapter(bot)
  const viewedBot = adapted?.adapter || bot
  prismarineViewer.mineflayer(viewedBot, options)
  let closed = false
  return {version: viewedBot.version, close: () => {
    if (closed) return
    closed = true
    viewedBot.viewer.close()
    adapted?.adapter.dispose()
  }}
}

module.exports = {createRenderAdapter, createBotViewer}
