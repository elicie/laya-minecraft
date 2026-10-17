import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Bot, BotEvents } from 'mineflayer';
import { Vec3 } from 'vec3';
import { WebSocket, WebSocketServer } from 'ws';
import { createViewerMaterials } from './viewer-materials';
import { createViewerAssets, viewerHtml } from './viewer-assets';
import { VIEWER_PROTOCOL_VERSION, type ViewerMaterial, type ViewerMessage, type ViewerPosition, type ViewerSection } from './viewer-protocol';

interface Column { getBlockStateId(p: Vec3): number; }
interface TransmittedFrame { key: string; at: number; }
interface Client { socket: WebSocket; sent: Set<string>; removes: Set<string>; deltas: Map<string, Extract<ViewerMessage, { type: 'delta' }>>; reset: boolean; blockedAt?: number; camera?: TransmittedFrame; entities?: TransmittedFrame; }
const sectionId = (x: number, y: number, z: number) => `${x},${y},${z}`;
const parseId = (id: string) => id.split(',').map(Number) as [number, number, number];
const coordinate = (p: { x: number; y: number; z: number }): ViewerPosition => ({ x: p.x, y: p.y, z: p.z });
const MAX_BUFFER = 128 * 1024;

/** A section contains only actual public chunk state IDs, never JSON/NBT/light arrays. */
export function encodeViewerSection(column: Column, x: number, y: number, z: number, revision: number, material: (stateId: number) => ViewerMaterial): ViewerSection {
  const palette: ViewerMaterial[] = [], indices = new Map<number, number>(), bytes = Buffer.allocUnsafe(4096 * 2), p = new Vec3(0, 0, 0);
  for (let n = 0; n < 4096; n++) {
    p.x = n & 15; p.y = y * 16 + (n >> 8); p.z = (n >> 4) & 15;
    const state = column.getBlockStateId(p);
    if (!Number.isInteger(state) || state < 0) throw new Error('Loaded chunk returned an invalid block state');
    let index = indices.get(state); if (index === undefined) { index = palette.length; indices.set(state, index); palette.push(material(state)); }
    bytes.writeUInt16LE(index, n * 2);
  }
  return { type: 'section', id: sectionId(x, y, z), revision, origin: { x: x * 16, y: y * 16, z: z * 16 }, size: 16, palette, voxels: bytes.toString('base64') };
}
export function viewerSectionOrder(position: ViewerPosition, radius: number, minY: number, maxY: number): string[] {
  const cx = Math.floor(position.x / 16), cy = Math.floor(position.y / 16), cz = Math.floor(position.z / 16);
  const cells: { id: string; score: number }[] = [];
  for (let x = cx - radius; x <= cx + radius; x++) for (let z = cz - radius; z <= cz + radius; z++) for (const y of [cy, cy - 1, cy + 1]) {
    if (y * 16 < minY || y * 16 >= maxY) continue;
    cells.push({ id: sectionId(x, y, z), score: (x - cx) ** 2 + (z - cz) ** 2 + Math.abs(y - cy) * 0.4 });
  }
  return cells.sort((a, b) => a.score - b.score).map(cell => cell.id);
}

export interface CompactViewerOptions { port: number; prefix: string; viewDistance?: number; assetsRoot?: string; }
export async function createCompactViewerServer(bot: Bot, options: CompactViewerOptions) {
  const [materials, assets] = await Promise.all([createViewerMaterials(bot.version), createViewerAssets(options.assetsRoot ? { publicRoot: options.assetsRoot } : {})]);
  const radius = Math.max(1, Math.min(3, Math.floor(Number.isFinite(options.viewDistance) ? options.viewDistance! : 2))), clients = new Set<Client>();
  const cache = new Map<string, ViewerSection>(), revisions = new Map<string, number>(), missing = new Map<string, number>();
  const listeners: Array<[keyof BotEvents, (...args: unknown[]) => void]> = [];
  let streamId = randomUUID(), dimension = String(bot.game?.dimension ?? 'overworld'), desired: string[] = [], center = '', closed = false, pumping = false;
  const bounds = () => { const game = bot.game as Bot['game'] & { minY?: number; height?: number }; const minY = Number.isInteger(game?.minY) ? game.minY! : dimension === 'overworld' ? -64 : 0; return { minY, maxY: minY + (Number.isInteger(game?.height) ? game.height! : 384) }; };
  function send(client: Client, message: ViewerMessage): boolean {
    if (client.socket.readyState !== WebSocket.OPEN) return false;
    if (client.socket.bufferedAmount > MAX_BUFFER) { client.blockedAt ??= Date.now(); if (Date.now() - client.blockedAt > 15000) client.socket.close(1013, 'Viewer connection is too slow'); return false; }
    client.blockedAt = undefined; client.socket.send(JSON.stringify(message)); return true;
  }
  function camera(client: Client, force = false) {
    const p = bot.entity?.position; if (!p) return;
    const frame: Extract<ViewerMessage, { type: 'camera' }> = { type: 'camera', position: { x: p.x, y: p.y + 1.62, z: p.z }, yaw: Number.isFinite(bot.entity.yaw) ? bot.entity.yaw : 0, pitch: Number.isFinite(bot.entity.pitch) ? bot.entity.pitch : 0 };
    const key = JSON.stringify(frame), now = Date.now();
    if (!force && client.camera?.key === key && now - client.camera.at < 1000) return;
    if (send(client, frame)) client.camera = { key, at: now };
  }
  function hello(client: Client) {
    const loaded = new Map<string, boolean>();
    const sectionIds = desired.filter(id => {
      const [x, , z] = parseId(id), key = `${x},${z}`;
      if (!loaded.has(key)) { try { loaded.set(key, !!bot.world.getColumnAt(new Vec3(x * 16, 0, z * 16))); } catch { loaded.set(key, false); } }
      return loaded.get(key);
    });
    send(client, { type: 'hello', protocolVersion: VIEWER_PROTOCOL_VERSION, streamId, version: bot.version, dimension, ...bounds(), viewDistance: radius,
      sectionIds, ...(materials.atlasPath ? { atlasUrl: `${assets.basePath}/textures/${materials.atlasVersion}.png`, atlasVersion: materials.atlasVersion } : {}), approximate: materials.approximate });
    camera(client, true);
  }
  function updateDesired() {
    if (!bot.entity?.position) return;
    const p = bot.entity.position, key = `${Math.floor(p.x / 16)},${Math.floor(p.y / 16)},${Math.floor(p.z / 16)}`;
    if (String(bot.game?.dimension ?? 'overworld') !== dimension) {
      dimension = String(bot.game?.dimension ?? 'overworld'); streamId = randomUUID(); cache.clear(); revisions.clear(); missing.clear(); center = '';
      for (const client of clients) { client.sent.clear(); client.removes.clear(); client.deltas.clear(); client.reset = true; }
    }
    if (key === center) return; center = key;
    const b = bounds(); desired = viewerSectionOrder(coordinate(p), radius, b.minY, b.maxY); const keep = new Set(desired);
    for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
    for (const map of [revisions, missing]) for (const id of map.keys()) if (!keep.has(id)) map.delete(id);
    for (const client of clients) {
      for (const id of client.sent) if (!keep.has(id)) { client.sent.delete(id); client.removes.add(id); }
      for (const [key, delta] of client.deltas) if (!keep.has(delta.id)) client.deltas.delete(key);
    }
  }
  async function pump() {
    if (closed || pumping || clients.size === 0) return; pumping = true;
    try {
      updateDesired(); const started = performance.now();
      for (const client of clients) {
        if (performance.now() - started > 6) break;
        if (client.socket.readyState !== WebSocket.OPEN || client.socket.bufferedAmount > MAX_BUFFER) { camera(client); continue; }
        if (client.reset) { if (client.socket.bufferedAmount > MAX_BUFFER / 2) continue; send(client, { type: 'reset', streamId, dimension }); hello(client); client.reset = false; }
        for (const id of client.removes) { if (!send(client, { type: 'remove', id })) break; client.removes.delete(id); }
        let deltas = 0;
        for (const [key, delta] of [...client.deltas].sort(([, a], [, b]) => a.revision - b.revision)) { if (!send(client, delta)) break; client.deltas.delete(key); if (++deltas >= 16) break; }
        let checked = 0;
        for (const id of desired) {
          if (client.sent.has(id) || (missing.get(id) ?? 0) > Date.now()) continue;
          if (checked++ >= 4 || performance.now() - started > 6) break;
          let section = cache.get(id);
          if (!section) {
            try {
              const [x, y, z] = parseId(id), column = await bot.world.getColumnAt(new Vec3(x * 16, y * 16, z * 16)) as unknown as Column | null;
              if (closed || String(bot.game?.dimension ?? 'overworld') !== dimension || !desired.includes(id)) break;
              if (!column) { missing.set(id, Date.now() + 1000); continue; }
              section = encodeViewerSection(column, x, y, z, revisions.get(id) ?? 1, materials.material); cache.set(id, section); revisions.set(id, section.revision);
            } catch {
              // One unavailable/unsupported section must not block other actual terrain or bot behavior.
              missing.set(id, Date.now() + 1000);
              client.removes.add(id);
              send(client, { type: 'status', queued: desired.length - client.sent.size, sections: client.sent.size, reason: `Section ${id} is unavailable; other observed terrain continues.` });
              continue;
            }
          }
          if (send(client, section)) client.sent.add(id); break;
        }
      }
    } catch { /* Unknown/unloaded sections remain absent; next loaded event retries. */ }
    finally { pumping = false; }
  }
  const server = createServer((req, res) => {
    void (async () => {
      if (await assets.handle(req, res)) return;
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === options.prefix) { res.writeHead(302, { location: `${options.prefix}/` }); res.end(); return; }
      if (path === `${options.prefix}/` || path === `${options.prefix}/index.html`) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(viewerHtml(assets.basePath)); return; }
      if (path === `${options.prefix}/atlas.png` && materials.atlasPath) {
        assets.redirect(req, res, `textures/${materials.atlasVersion}.png`); return;
      }
      res.writeHead(404); res.end();
    })().catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: { threshold: 1024 } });
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== `${options.prefix}/stream` || clients.size >= 4) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', socket => {
    updateDesired();
    const client: Client = { socket, sent: new Set(), removes: new Set(), deltas: new Map(), reset: false }; clients.add(client); hello(client);
    socket.on('error', () => { clients.delete(client); socket.terminate(); }); socket.on('close', () => clients.delete(client));
    // Client data never changes the bot or server world. There is no command handler.
    void pump();
  });
  function listen(event: keyof BotEvents, callback: (...args: unknown[]) => void) { bot.on(event, callback); listeners.push([event, callback]); }
  listen('blockUpdate', (_old, raw) => {
    const block = raw as { position: Vec3; stateId: number } | null; if (!block || !Number.isInteger(block.stateId)) return;
    const p = block.position, id = sectionId(Math.floor(p.x / 16), Math.floor(p.y / 16), Math.floor(p.z / 16)); if (!desired.includes(id)) return;
    const revision = (revisions.get(id) ?? 1) + 1; revisions.set(id, revision); cache.delete(id);
    let material: ViewerMaterial;
    try { material = materials.material(block.stateId); }
    catch { missing.set(id, Date.now() + 1000); for (const client of clients) client.sent.delete(id); return; }
    const delta: Extract<ViewerMessage, { type: 'delta' }> = { type: 'delta', id, revision, position: { x: ((p.x % 16) + 16) % 16, y: ((p.y % 16) + 16) % 16, z: ((p.z % 16) + 16) % 16 }, material };
    for (const client of clients) if (client.sent.has(id)) {
      if (client.deltas.size >= 128) { for (const pending of client.deltas.values()) client.sent.delete(pending.id); client.deltas.clear(); client.sent.delete(id); }
      else client.deltas.set(`${id}:${delta.position.x},${delta.position.y},${delta.position.z}`, delta);
    }
  });
  for (const event of ['chunkColumnLoad', 'chunkColumnUnload'] as const) listen(event, raw => {
    const p = raw as Vec3, cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    for (const id of desired) {
      const [x, , z] = parseId(id); if (x !== cx || z !== cz) continue;
      revisions.set(id, (revisions.get(id) ?? 1) + 1); cache.delete(id); missing.delete(id);
      for (const client of clients) {
        client.sent.delete(id);
        for (const [key, delta] of client.deltas) if (delta.id === id) client.deltas.delete(key);
        if (event === 'chunkColumnUnload') client.removes.add(id);
      }
    }
  });
  const entityTimer = setInterval(() => {
    if (!clients.size || !bot.entity?.position) return;
    const entities = Object.values(bot.entities).filter(entity => entity.id !== bot.entity.id && entity.position && [entity.position.x, entity.position.y, entity.position.z].every(Number.isFinite) && entity.position.distanceTo(bot.entity.position) <= 48).slice(0, 80).map(entity => ({ id: entity.uuid ?? String(entity.id), name: entity.username ?? entity.name ?? 'entity', position: coordinate(entity.position), width: Number.isFinite(entity.width) ? entity.width : 0.6, height: Number.isFinite(entity.height) ? entity.height : 1.8, yaw: Number.isFinite(entity.yaw) ? entity.yaw : 0, kind: entity.type === 'player' ? 'player' as const : entity.type === 'mob' ? 'mob' as const : 'object' as const }));
    const key = JSON.stringify(entities), now = Date.now();
    for (const client of clients) {
      if (client.entities?.key === key && now - client.entities.at < 1000) continue;
      if (send(client, { type: 'entities', entities })) client.entities = { key, at: now };
    }
  }, 100); entityTimer.unref();
  const cameraTimer = setInterval(() => { for (const client of clients) camera(client); }, 50);
  const sectionTimer = setInterval(() => { void pump(); }, 20); cameraTimer.unref(); sectionTimer.unref();
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { close(); throw error; }
  const port = (server.address() as { port: number }).port;
  function close() {
    if (closed) return; closed = true; clearInterval(cameraTimer); clearInterval(sectionTimer); clearInterval(entityTimer);
    for (const [event, callback] of listeners) bot.removeListener(event, callback);
    for (const client of clients) client.socket.terminate(); clients.clear(); sockets.close(); if (server.listening) server.close(); server.closeAllConnections(); cache.clear();
  }
  return { version: bot.version, streamId, port, close };
}
