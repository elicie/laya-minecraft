const assert = require('node:assert/strict')
const fs = require('node:fs'), http = require('node:http'), path = require('node:path')
const {members, ROLES} = require('../village-config')
const {cameraFor} = require('../fleet-viewer')
const playwright = require(process.env.PLAYWRIGHT_PATH || '/tmp/laya-browser/node_modules/playwright-core')

// Exercise the dashboard lifecycle without connecting a bot or changing a world.
const bots = members().map((member, i) => ({...member, label: ROLES[member.role], ready: true, viewerReady: true, health: 20, food: 18, position: {x: i, y: 64, z: 10}, viewer: {...cameraFor(member.username, i + 1), instance: 'first'}}))
let status = {running: true, configured: 12, ready: 12, viewerEnabled: true, server: 'test:25565', village: {center: {x: 0, y: 64, z: 0}}, bots}
let unavailable = false, browser
const errors = []
const staticFiles = {'/fleet': 'fleet.html', '/fleet.js': 'fleet.js', '/fleet.css': 'fleet.css'}
const server = http.createServer((req, res) => {
  if (req.url === '/api/fleet') {
    res.writeHead(unavailable ? 503 : 200, {'Content-Type': 'application/json'})
    return res.end(JSON.stringify(status))
  }
  if (req.url.startsWith('/view/fleet/')) {
    res.writeHead(200, {'Content-Type': 'text/html'})
    return res.end('<!doctype html><title>Isolated camera fixture</title><canvas></canvas>')
  }
  const file = staticFiles[req.url]
  if (!file) {res.writeHead(404); return res.end()}
  res.writeHead(200, {'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'})
  fs.createReadStream(path.join(__dirname, '../web', file)).pipe(res)
})

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await playwright.chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || '/home/elicie/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox']})
  const page = await browser.newPage({viewport: {width: 1600, height: 1100}})
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:' + server.address().port + '/fleet')
  await page.waitForFunction(() => document.querySelectorAll('iframe[src]').length === 1)
  assert.equal(await page.locator('.is-primary').getAttribute('data-username'), 'Manager')
  assert.match(await page.locator('iframe[src]').getAttribute('src'), /\/Manager\//)
  assert.equal(await page.locator('.camera-card').count(), 12, 'all roles remain visible with one stream')
  await page.locator('[data-username="Builder1"] .camera-select').click()
  assert.equal(await page.locator('iframe[src]').count(), 1, 'switching must unload the previous camera')
  assert.match(await page.locator('iframe[src]').getAttribute('src'), /\/Builder1\//)
  await page.locator('#managerView').click()
  assert.match(await page.locator('iframe[src]').getAttribute('src'), /\/Manager\//)
  await page.locator('#allViews').click()
  await page.waitForFunction(() => document.querySelectorAll('iframe[src]').length === 12)
  const sources = await page.locator('iframe').evaluateAll(frames => frames.map(frame => frame.getAttribute('src')))
  assert.equal(new Set(sources).size, 12, 'each role must keep its own camera')
  await page.evaluate(() => {window.firstFrame = document.querySelector('iframe')})
  await page.locator('.camera-open').first().click()
  await page.locator('[role="dialog"]').waitFor()
  assert.equal(await page.locator('iframe[src]').count(), 1, 'enlarged camera must suspend the hidden streams')
  assert.equal(await page.evaluate(() => window.firstFrame === document.querySelector('iframe')), true, 'enlarging must retain the renderer')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('[role="dialog"]').count(), 0)
  assert.equal(await page.locator('iframe[src]').count(), 12)
  await page.locator('#pauseViews').click()
  assert.equal(await page.locator('iframe[src]').count(), 0, 'pause must unload all streams')
  await page.locator('#pauseViews').click()
  await page.waitForFunction(() => document.querySelectorAll('iframe[src]').length === 12)
  assert.deepEqual(await page.locator('iframe').evaluateAll(frames => frames.map(frame => frame.getAttribute('src'))), sources)
  bots[0].viewer.instance = 'restarted'
  await page.waitForFunction(() => document.querySelector('iframe').getAttribute('src').includes('restarted'))
  assert.deepEqual((await page.locator('iframe').evaluateAll(frames => frames.map(frame => frame.getAttribute('src')))).slice(1), sources.slice(1))
  unavailable = true
  await page.waitForFunction(() => document.querySelectorAll('iframe[src]').length === 0)
  assert.equal(await page.locator('.camera-health').first().textContent(), '—', 'failed status must clear stale health')
  unavailable = false
  await page.waitForFunction(() => document.querySelectorAll('iframe[src]').length === 12)
  status = {...status, running: false, ready: 0}
  await page.waitForFunction(() => document.querySelectorAll('iframe[src]').length === 0)
  assert.equal(await page.locator('.camera-card').count(), 12, 'offline roles remain visible')
  await page.setViewportSize({width: 390, height: 844})
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page must not overflow horizontally')
  assert.equal(await page.locator('.camera-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 1)
  assert.deepEqual(errors, [])
  console.log('PASS Manager default with one stream, camera switching, optional twelve cameras, retained enlarged renderer, pause/resume, restart, status failure/recovery, offline roles and mobile layout (no Minecraft connection)')
}
main().catch(error => {console.error(error); process.exitCode = 1}).finally(async () => {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})
