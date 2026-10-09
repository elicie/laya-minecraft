// Production bot.js instances, disposable Minecraft server 25566 only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {fork, execFileSync} = require('node:child_process')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-fleet-live-'))
const count = 10, records = [], failures = [], ticks = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
assert.equal(Number(process.env.MC_TEST_PORT || 25566), 25566)
const rcon = command => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], {encoding: 'utf8', timeout: 10000})

async function wait(test, label, limit = 45000) {
  const end = Date.now() + limit
  while (Date.now() < end) {
    assert.equal(failures.length, 0, failures.join('\n'))
    if (test()) return
    await sleep(100)
  }
  throw new Error(`${label}: ${JSON.stringify(records.map(r => ({name: r.username, ready: r.state?.ready, job: r.state?.job, output: r.output.slice(-2)})))}`)
}

async function main() {
  rcon('gamerule doMobSpawning false')
  rcon('gamerule doDaylightCycle false')
  rcon('time set day')
  rcon('kill @e[type=!minecraft:player]')
  rcon('fill -24 64 -24 24 64 24 minecraft:grass_block')
  rcon('fill -24 65 -24 24 72 24 minecraft:air')
  const before = await (await fetch('http://127.0.0.1:8093/metrics')).text()
  for (let i = 0; i < count; i++) {
    const username = 'VllmLaya' + String(i + 1).padStart(2, '0')
    const logDirectory = path.join(directory, username)
    fs.mkdirSync(logDirectory, {recursive: true})
    fs.writeFileSync(path.join(logDirectory, 'mission.json'), JSON.stringify({request: '', goals: [], index: 0, autoRequested: false, continuous: false}))
    const record = {username, logDirectory, output: [], state: null, positions: []}
    record.child = fork(path.join(root, 'bot.js'), [], {cwd: root, env: {...process.env, MC_HOST: '127.0.0.1', MC_PORT: '25566', MC_VERSION: '1.21.1', MC_AUTH: 'offline', MC_USERNAME: username, MC_OWNERS: '', BOT_LOG_DIR: logDirectory, WEB_VIEWER: '0', BOT_ONCE: '', LAYA_NORMALIZE: '0', LAYA_ENDPOINT: 'http://127.0.0.1:8093/models/minecraft-ko-v1/api/decide', LAYA_POLICY_ENDPOINT: 'http://127.0.0.1:8093/models/minecraft-food-v1/api/decide', LAYA_ACTIVITY_ENDPOINT: 'http://127.0.0.1:8093/models/minecraft-activity-v1/api/decide'}, stdio: ['ignore', 'pipe', 'pipe', 'ipc']})
    record.child.on('message', message => {if (message.type === 'state') {record.state = message; if (message.position) record.positions.push(message.position)}})
    for (const stream of [record.child.stdout, record.child.stderr]) stream.on('data', data => {record.output.push(data.toString()); if (record.output.length > 20) record.output.shift()})
    record.child.on('error', error => failures.push(username + ': ' + error.message))
    record.child.on('exit', (code, signal) => {if (!record.stopping) failures.push(username + ' exited: ' + (code ?? signal))})
    records.push(record)
  }
  await wait(() => records.every(record => record.state?.ready), 'all ten bots spawn')
  assert.match(rcon('list'), /10 of a max of 16/)
  for (let i = 0; i < records.length; i++) {
    const x = i === 0 ? 0.5 : -18 + (i % 3) * 12
    const z = i === 0 ? 0.5 : -18 + Math.floor(i / 3) * 12
    rcon(`tp ${records[i].username} ${x} 65 ${z}`)
  }
  await sleep(1000)
  for (const record of records) record.origin = {...record.state.position}
  for (let i = 0; i < records.length; i++) records[i].child.send({type: 'command', text: i === 0 ? '상태 알려줘' : '따라와', player: records[0].username})
  const events = record => fs.existsSync(path.join(record.logDirectory, 'events.jsonl')) ? fs.readFileSync(path.join(record.logDirectory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  await wait(() => records.every(record => events(record).some(event => event.type === 'decision' && event.model === 'minecraft-ko-v1')), 'actual vLLM command decisions for all ten bots')
  await wait(() => records.slice(1).every(record => record.state.position && Math.hypot(record.state.position.x - record.origin.x, record.state.position.z - record.origin.z) > 1), 'nine followers actually move')
  for (let i = 0; i < 60; i++) {
    assert(records.every(record => record.state?.ready && record.state.health > 0), 'all ten remain connected and alive')
    if (i % 10 === 0) ticks.push({elapsed_seconds: i / 2, players: rcon('list')})
    await sleep(500)
  }
  for (const record of records) record.child.send({type: 'command', text: '!stop'})
  await sleep(1000)
  const after = await (await fetch('http://127.0.0.1:8093/metrics')).text()
  const result = {scope: 'Ten independent production bot.js processes in disposable survival world on 25566. One status decision and nine follow decisions through actual vLLM CUDA, actual follower movement, thirty seconds connected and alive. Terrain prepared before commands; no user-world fixtures; does not cover long survival campaigns.', clients: count, errors: failures, connection_samples: ticks, bots: records.map(record => ({username: record.username, ready: record.state.ready, health: record.state.health, origin: record.origin, position: record.state.position, decision: events(record).find(event => event.type === 'decision' && event.model === 'minecraft-ko-v1')})), metrics_before: before, metrics_after: after}
  fs.mkdirSync(path.join(root, 'artifacts'), {recursive: true})
  fs.writeFileSync(path.join(root, 'artifacts/fleet-vllm-live.json'), JSON.stringify(result, null, 2) + '\n')
  console.log('PASS ten production bots connected; native vLLM decisions; nine followers moved; all ten alive after thirty seconds')
}

const deadline = setTimeout(() => {failures.push('fleet test deadline exceeded'); for (const r of records) r.child.kill('SIGTERM')}, 120000)
main().catch(error => {console.error(error); console.error(records.map(r => ({name: r.username, output: r.output.slice(-3)}))); process.exitCode = 1}).finally(async () => {
  clearTimeout(deadline)
  for (const record of records) {record.stopping = true; if (record.child.exitCode === null) record.child.kill('SIGTERM')}
  await sleep(700)
  for (const record of records) if (record.child.exitCode === null) record.child.kill('SIGKILL')
  fs.rmSync(directory, {recursive: true, force: true})
  process.exit(process.exitCode || 0)
})
