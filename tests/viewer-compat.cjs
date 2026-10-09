const assert = require('node:assert/strict')
const {EventEmitter} = require('node:events')
const {Vec3} = require('vec3')
const {createRenderAdapter} = require('../viewer-compat')
const version = '26.1', targetVersion = '1.21.4'
const registry = require('minecraft-data')(version)
const TargetBlock = require('prismarine-block')(targetVersion)
const SourceBlock = require('prismarine-block')(version)
const column = new (require('prismarine-chunk')(version))({minY: -64, worldHeight: 384})
const bot = new EventEmitter()
Object.assign(bot, {version, username: 'CompatTest', entity: {position: new Vec3(0, 65, 0)}, entities: {}, world: {getColumnAt: async () => column}})
const {adapter, convertColumn} = createRenderAdapter(bot, targetVersion)

async function main() {
  const examples = [['grass_block', {snowy: false}], ['oak_log', {axis: 'x'}], ['wheat', {age: 7}], ['oak_stairs', {facing: 'west', half: 'top', shape: 'straight', waterlogged: false}], ['water', {level: 4}]]
  for (const [i, [name, properties]] of examples.entries()) column.setBlockStateId(new Vec3(i, 65, 0), SourceBlock.fromProperties(name, properties, 0).stateId)
  const before = column.toJson(), converted = convertColumn(column)
  for (const [i, [name, properties]] of examples.entries()) {
    const actual = converted.getBlock(new Vec3(i, 65, 0))
    assert.equal(actual.name, name)
    const nativeProperties = column.getBlock(new Vec3(i, 65, 0)).getProperties()
    for (const property of Object.keys(properties)) assert.equal(actual.getProperties()[property], nativeProperties[property])
  }
  assert.equal(column.toJson(), before, 'render conversion must not modify the game world')
  assert.equal(converted.getBlock(new Vec3(15, 65, 0)).name, 'air')
  const cached = await adapter.world.getColumnAt(new Vec3(0, 0, 0))
  const native = column.getBlock(new Vec3(0, 65, 0)); native.position = new Vec3(0, 65, 0)
  const changed = SourceBlock.fromProperties('stone', {}, 0); changed.position = native.position
  let update
  adapter.on('blockUpdate', (oldBlock, newBlock) => {update = newBlock})
  bot.emit('blockUpdate', native, changed)
  assert.equal(cached.getBlock(new Vec3(0, 65, 0)).name, 'stone')
  assert.equal(TargetBlock.fromStateId(update.stateId, 0).name, 'stone')
  bot.emit('chunkColumnLoad', new Vec3(0, 0, 0))
  assert.notEqual(await adapter.world.getColumnAt(new Vec3(0, 0, 0)), cached)
  // More than 256 states force the global palette, which also needs remapping.
  const many = registry.blocksArray.slice(0, 350)
  for (const [i, block] of many.entries()) column.setBlockStateId(new Vec3(i & 15, 96 + (i >> 8), (i >> 4) & 15), block.defaultState)
  const direct = convertColumn(column)
  for (const [i, block] of many.entries()) {
    const target = require('minecraft-data')(targetVersion).blocksByName[block.name]
    if (target) assert.equal(direct.getBlock(new Vec3(i & 15, 96 + (i >> 8), (i >> 4) & 15)).name, target.name)
  }
  adapter.dispose()
  assert.equal(bot.eventNames().length, 0, 'close must remove all rendering listeners')
  console.log('PASS native 26.1 render adapter: block names/properties, air, global palettes, live updates, cache invalidation and listener cleanup')
}
main().catch(error => {console.error(error); process.exitCode = 1})
