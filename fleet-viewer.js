const fs = require('node:fs')
const path = require('node:path')
const {members, ROLES} = require('./village-config')

const USERNAME = /^[A-Za-z0-9_]{1,16}$/

function viewerConfig(env = process.env) {
  const enabled = env.FLEET_VIEWER !== '0'
  const basePort = Number(env.FLEET_VIEWER_BASE_PORT || 3100)
  const viewDistance = Number(env.FLEET_VIEW_DISTANCE || 2)
  if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65471) throw new Error('FLEET_VIEWER_BASE_PORT must be 1024..65471')
  if (!Number.isInteger(viewDistance) || viewDistance < 1 || viewDistance > 8) throw new Error('FLEET_VIEW_DISTANCE must be 1..8')
  return {enabled, basePort, viewDistance}
}

function cameraFor(username, index, config = viewerConfig()) {
  if (typeof username !== 'string' || !USERNAME.test(username) || !Number.isInteger(index) || index < 1 || index > 64) throw new Error('Invalid fleet camera identity')
  if (!config.enabled) return null
  const port = config.basePort + index
  if (port === 3008 || port === Number(process.env.WEB_PORT || 3000)) throw new Error('Fleet camera port conflicts with the dashboard or single-bot viewer')
  const prefix = '/view/fleet/' + username
  return {port, prefix, url: prefix + '/'}
}

function readFleetStatus(directory, {now = Date.now(), maxAge = 10000} = {}) {
  const fallback = () => ({running: false, configured: 12, ready: 0, viewerEnabled: false, bots: members().map((member, i) => ({...member, index: i + 1, label: ROLES[member.role], ready: false, viewerReady: false}))})
  try {
    const file = path.join(directory, 'status.json')
    if (fs.statSync(file).size > 1024 * 1024) return fallback()
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const age = now - Date.parse(data.time)
    if (!Number.isFinite(age) || age < -5000 || age > maxAge || !Array.isArray(data.bots) || data.bots.length < 1 || data.bots.length > 64) return fallback()
    const usernames = new Set()
    for (const bot of data.bots) {
      if (typeof bot.username !== 'string' || !USERNAME.test(bot.username) || usernames.has(bot.username)) return fallback()
      usernames.add(bot.username)
      if (bot.viewer && (!Number.isInteger(bot.viewer.port) || bot.viewer.port < 1024 || bot.viewer.port > 65535 || bot.viewer.prefix !== '/view/fleet/' + bot.username || bot.viewer.url !== bot.viewer.prefix + '/')) return fallback()
    }
    let running = data.running === true && Number.isInteger(data.pid) && data.pid > 0
    if (running) {
      try {process.kill(data.pid, 0)} catch {running = false}
    }
    const bots = data.bots.map(bot => ({...bot, ready: running && !!bot.ready, viewerReady: running && !!bot.ready && !!bot.viewerReady && !!bot.viewer}))
    return {...data, running, configured: bots.length, ready: bots.filter(bot => bot.ready).length, bots}
  } catch {return fallback()}
}

function fleetViewerTarget(url, status) {
  const match = url.match(/^\/view\/fleet\/([A-Za-z0-9_]{1,16})\//)
  if (!match || !status.running) return null
  const bot = status.bots.find(bot => bot.username === match[1])
  return bot?.viewerReady && bot.viewer ? {port: bot.viewer.port, prefix: bot.viewer.prefix} : null
}

module.exports = {viewerConfig, cameraFor, readFleetStatus, fleetViewerTarget}
