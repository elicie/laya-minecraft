// One independent production bot process per Minecraft identity.
const fs = require('node:fs')
const path = require('node:path')
const {fork} = require('node:child_process')
const readline = require('node:readline')
const {loadVillageConfig, members: villageMembers} = require('./village-config')
const {createVillageCoordinator} = require('./village-coordinator')

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
const children = new Map(), timers = new Set()
let stopping = false
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
  const username = member?.username || prefix + String(index).padStart(2, '0')
  const botDirectory = path.join(directory, username)
  fs.mkdirSync(botDirectory, {recursive: true})
  const child = fork(path.join(__dirname, 'bot.js'), [], {
    cwd: __dirname,
    env: {...process.env, MC_USERNAME: username, BOT_LOG_DIR: botDirectory, WEB_VIEWER: '0', BOT_VILLAGE_PROFILE: member ? JSON.stringify({role: member.role, index: member.index}) : ''},
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const record = {child, username, ready: false, state: null, failures, started: Date.now()}
  children.set(index, record)
  const output = fs.createWriteStream(path.join(botDirectory, 'process.log'), {flags: 'a'})
  child.stdout.pipe(output, {end: false})
  child.stderr.pipe(output, {end: false})
  child.on('message', message => {
    coordinator?.receive(index, message)
    if (message.type === 'state') {
      record.ready = message.ready
      record.state = message
    }
  })
  child.on('error', error => console.error(username, error.message))
  child.on('exit', (code, signal) => {
    output.end()
    record.ready = false
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
  setTimeout(() => {
    for (const {child} of children.values()) if (child.exitCode === null) child.kill('SIGKILL')
  }, 3000).unref()
}

for (let index = 1; index <= count; index++) start(index)
const villageTick = coordinator ? setInterval(() => coordinator.broadcast(), 2000) : null
const status = setInterval(() => {
  const bots = [...children.values()]
  const summary = {time: new Date().toISOString(), configured: count, ready: bots.filter(bot => bot.ready).length, village: coordinator?.status(), bots: bots.map(bot => ({username: bot.username, ready: bot.ready, job: bot.state?.job, health: bot.state?.health, village: bot.state?.village}))}
  fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`Laya fleet: ${summary.ready}/${count} connected`)
}, 5000)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
