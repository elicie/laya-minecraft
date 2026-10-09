const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const {Server} = require('socket.io')
const {io} = require('socket.io-client')
const {members} = require('../village-config')
const {viewerConfig, cameraFor, readFleetStatus, fleetViewerTarget} = require('../fleet-viewer')
const {proxyViewer, proxyViewerUpgrade} = require('../viewer-proxy')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-camera-test-'))
const servers = [], sockets = [], clients = []
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

async function main() {
  const roster = members(), config = viewerConfig({})
  assert.equal(roster.length, 12)
  const cameras = roster.map((member, i) => cameraFor(member.username, i + 1, config))
  assert.equal(new Set(cameras.map(camera => camera.port)).size, 12)
  assert.equal(new Set(cameras.map(camera => camera.prefix)).size, 12)
  assert.equal(cameraFor(roster[0].username, 1, viewerConfig({FLEET_VIEWER: '0'})), null)
  assert.throws(() => cameraFor(undefined, 1), /identity/)
  assert.throws(() => viewerConfig({FLEET_VIEWER_BASE_PORT: '65500'}))
  assert.throws(() => viewerConfig({FLEET_VIEW_DISTANCE: '0'}))
  assert.equal(readFleetStatus(directory).bots.length, 12)
  const status = {time: new Date().toISOString(), pid: process.pid, running: true, configured: 12, bots: roster.map((member, i) => ({...member, ready: true, viewerReady: true, viewer: cameras[i]}))}
  const file = path.join(directory, 'status.json'), write = value => fs.writeFileSync(file, JSON.stringify(value))
  write(status)
  assert.equal(readFleetStatus(directory).ready, 12)
  assert.equal(fleetViewerTarget(cameras[0].url + 'socket.io/?transport=websocket', readFleetStatus(directory)).port, cameras[0].port)
  assert.equal(fleetViewerTarget('/view/fleet/Unknown/', status), null)
  write({...status, time: new Date(Date.now() - 30000).toISOString()})
  assert.equal(readFleetStatus(directory).ready, 0)
  write({...status, running: false})
  assert.equal(readFleetStatus(directory).bots.some(bot => bot.viewerReady), false)
  write({...status, bots: [status.bots[0], status.bots[0]]})
  assert.equal(readFleetStatus(directory).running, false)
  const targets = new Map()
  for (const member of roster.slice(0, 2)) {
    const prefix = '/view/fleet/' + member.username
    const server = http.createServer((req, res) => {res.writeHead(200, {'Content-Type': 'text/plain'}); res.end(member.username)})
    servers.push(server)
    const socketServer = new Server(server, {path: prefix + '/socket.io'})
    sockets.push(socketServer)
    socketServer.on('connection', socket => socket.emit('identity', member.username))
    targets.set(member.username, {port: await listen(server), prefix})
  }
  const targetFor = url => targets.get(url.match(/^\/view\/fleet\/([A-Za-z0-9_]+)\//)?.[1])
  const proxy = http.createServer((req, res) => {const target = targetFor(req.url); if (target) proxyViewer(req, res, target); else {res.writeHead(404); res.end()}})
  servers.push(proxy)
  proxy.on('upgrade', (req, socket, head) => {const target = targetFor(req.url); if (target) proxyViewerUpgrade(req, socket, head, target); else socket.destroy()})
  const base = 'http://127.0.0.1:' + await listen(proxy)
  for (const member of roster.slice(0, 2)) {
    const response = await fetch(base + '/view/fleet/' + member.username + '/')
    assert.equal(await response.text(), member.username)
    const received = await new Promise((resolve, reject) => {
      const client = io(base, {path: '/view/fleet/' + member.username + '/socket.io', transports: ['websocket'], reconnection: false, timeout: 3000})
      clients.push(client)
      client.once('identity', resolve)
      client.once('connect_error', reject)
    })
    assert.equal(received, member.username, 'WebSocket streams must remain attached to the correct bot')
  }
  console.log('PASS twelve unique camera routes, stale/offline status, HTTP and WebSocket isolation (no Minecraft connection)')
}
main().catch(error => {console.error(error); process.exitCode = 1}).finally(async () => {
  for (const client of clients) client.close()
  for (const socket of sockets) socket.close()
  for (const server of servers) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve))}
  fs.rmSync(directory, {recursive: true, force: true})
})
