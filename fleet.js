// One independent production bot process per Minecraft identity.
const fs = require('node:fs')
const path = require('node:path')
const {fork} = require('node:child_process')
const readline = require('node:readline')
const {loadVillageConfig, members: villageMembers, ROLES} = require('./village-config')
const {createVillageCoordinator} = require('./village-coordinator')
const {viewerConfig, cameraFor, readFleetStatus} = require('./fleet-viewer')

const villageFlag = process.argv.indexOf('--village')
const villageFile = villageFlag >= 0 ? process.argv[villageFlag + 1] : process.env.VILLAGE_CONFIG
if (villageFlag >= 0 && !villageFile) throw new Error('--village requires a config path')
const villageConfig = villageFile ? loadVillageConfig(path.resolve(villageFile)) : null
const memberList = villageConfig ? villageMembers() : null
const count = memberList ? memberList.length : Number(process.env.BOT_COUNT || 12)
if (memberList && process.env.BOT_COUNT && Number(process.env.BOT_COUNT) !== count) throw new Error(`Village roles require exactly ${count} bots`)
if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('BOT_COUNT must be 1..64')
const prefix = process.env.BOT_PREFIX || 'LayaBot'
if (!/^[A-Za-z0-9_]{1,12}$/.test(prefix)) throw new Error('BOT_PREFIX must be 1..12 ASCII letters, digits or underscores')
const directory = path.resolve(process.env.FLEET_LOG_DIR || path.join(__dirname, 'logs/fleet'))
const viewers = viewerConfig()
const identities = Array.from({length: count}, (_, i) => memberList?.[i]?.username || prefix + String(i + 1).padStart(2, '0'))
const cameras = identities.map((username, i) => cameraFor(username, i + 1, viewers))
if (readFleetStatus(directory).running) throw new Error('A fleet is already running in this FLEET_LOG_DIR')
fs.mkdirSync(directory, {recursive: true})
const children = new Map(), timers = new Set()
let stopping = false, statusTicks = 0
const coordinator = villageConfig ? createVillageCoordinator(villageConfig, memberList, {
  file: path.join(directory, 'village.json'),
  server: `${process.env.MC_HOST || '127.0.0.1'}:${process.env.MC_PORT || 25565}`,
  send: (index, message) => {const child = children.get(index)?.child; if (child?.connected) child.send(message)}
}) : null
const input = readline.createInterface({input: process.stdin})
input.on('line', line => {
  const match = line.trim().match(/^(\S+)\s+(.+)$/)
  if (!match) {console.log('Command: all <text> or <bot username> <text>'); return}
  const targets = [...children.values()].filter(r => match[1] === 'all' || r.username.toLowerCase() === match[1].toLowerCase())
  if (!targets.length) {console.error('Unknown bot: ' + match[1]); return}
  for (const {child} of targets) if (child.connected) child.send({type:'command',text:match[2]})
})

function start(index, failures = 0) {
  if (stopping) return
  const member = memberList?.[index - 1]
  const username = identities[index - 1]
  const viewer = cameras[index - 1]
  const botDirectory = path.join(directory, username)
  fs.mkdirSync(botDirectory, {recursive: true})
  const child = fork(path.join(__dirname, 'bot.js'), [], {
    cwd: __dirname,
    env: {...process.env, MC_USERNAME: username, BOT_LOG_DIR: botDirectory, WEB_VIEWER: viewer ? '1' : '0', BOT_VIEWER_PORT: String(viewer?.port || 3008), BOT_VIEWER_PREFIX: viewer?.prefix || '/view', BOT_VIEWER_DISTANCE: String(viewers.viewDistance), BOT_VILLAGE_PROFILE: member ? JSON.stringify({role: member.role, index: member.index}) : ''},
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const record = {child, username, member, viewer, ready: false, state: null, seenAt: 0, failures, started: Date.now()}
  children.set(index, record)
  const output = fs.createWriteStream(path.join(botDirectory, 'process.log'), {flags: 'a'})
  child.stdout.pipe(output, {end: false})
  child.stderr.pipe(output, {end: false})
  child.on('message', message => {
    coordinator?.receive(index, message)
    if (message.type === 'state') {
      record.ready = message.ready
      record.state = message
      record.seenAt = Date.now()
    }
  })
  child.on('error', error => console.error(username, error.message))
  child.on('exit', (code, signal) => {
    output.end()
    record.ready = false
    record.state = null
    coordinator?.disconnected(index)
    if (stopping) return
    const retry = Date.now() - record.started > 60000 ? 0 : failures + 1
    const delay = Math.min(30000, 1000 * 2 ** Math.min(retry, 5))
    console.error(`${username} exited (${code ?? signal}); retry in ${delay} ms`)
    const timer = setTimeout(() => {timers.delete(timer); start(index, retry)}, delay)
    timers.add(timer)
  })
}

function stop() {
  if (stopping) return
  stopping = true
  input.close()
  clearInterval(status)
  clearInterval(villageTick)
  for (const timer of timers) clearTimeout(timer)
  for (const {child} of children.values()) if (child.exitCode === null) child.kill('SIGTERM')
  publishStatus()
  setTimeout(() => {
    for (const {child} of children.values()) if (child.exitCode === null) child.kill('SIGKILL')
  }, 3000).unref()
}

function publishStatus() {
  const now = Date.now()
  const bots = [...children.values()].map(bot => {
    const ready = !stopping && bot.ready && now - bot.seenAt < 10000
    return {username: bot.username, role: bot.member?.role || null, label: ROLES[bot.member?.role] || '동료', ready, viewerReady: ready && !!bot.viewer && !!bot.state?.viewerReady, viewer: bot.viewer ? {...bot.viewer, instance: String(bot.started)} : null, job: bot.state?.job, health: bot.state?.health, food: bot.state?.food, position: bot.state?.position, village: bot.state?.village}
  })
  const summary = {version: 1, time: new Date(now).toISOString(), pid: process.pid, running: !stopping, server: `${process.env.MC_HOST || '127.0.0.1'}:${process.env.MC_PORT || 25565}`, configured: count, ready: bots.filter(bot => bot.ready).length, viewerEnabled: viewers.enabled, viewDistance: viewers.viewDistance, village: coordinator?.status(), bots}
  const temporary = path.join(directory, 'status-' + process.pid + '.tmp')
  fs.writeFileSync(temporary, JSON.stringify(summary) + '\n')
  fs.renameSync(temporary, path.join(directory, 'status.json'))
  return summary
}

for (let index = 1; index <= count; index++) start(index)
publishStatus()
const villageTick = coordinator ? setInterval(() => coordinator.broadcast(), 2000) : null
const status = setInterval(() => {
  const summary = publishStatus()
  if (++statusTicks % 5 === 0) console.log(`Laya fleet: ${summary.ready}/${count} connected`)
}, 1000)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
