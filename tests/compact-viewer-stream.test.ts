import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Bot } from 'mineflayer';
import chunkLoader from 'prismarine-chunk';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import WebSocket from 'ws';
import { createCompactViewerServer, encodeViewerSection, viewerSectionOrder } from '../packages/minecraft/src/viewer-stream';
import type { ViewerMaterial, ViewerMessage, ViewerSection } from '../packages/minecraft/src/viewer-protocol';

const material = (stateId: number): ViewerMaterial => ({ stateId, name: `state_${stateId}`, opaque: stateId !== 0, transparent: stateId === 0, color: 0xffffff, shape: stateId ? 'cube' : 'empty' });
function state(section: ViewerSection, x: number, y: number, z: number) { return section.palette[Buffer.from(section.voxels, 'base64').readUInt16LE(2 * (x + 16 * (z + 16 * y)))]!.stateId; }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, reason: string, timeout = 4000) { const deadline = Date.now() + timeout; while (!predicate() && Date.now() < deadline) await delay(10); assert.ok(predicate(), reason); }

function fixture() {
  const events = new EventEmitter(), Chunk = chunkLoader('1.21.1'), column = new Chunk({ x: 0, z: 0, minY: -64, worldHeight: 384 });
  const data = minecraftData('1.21.1');
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) column.setBlockStateId(new Vec3(x, 63, z), data.blocksByName.grass_block!.defaultState!);
  column.setBlockStateId(new Vec3(1, 64, 2), data.blocksByName.oak_log!.defaultState!);
  const columns = new Map<string, { getBlockStateId(p: Vec3): number }>([['0,0', column]]);
  const bot = Object.assign(events, { version: '1.21.1', username: 'ObservedBot', entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 1, pitch: 0.1 }, game: { dimension: 'overworld', minY: -64, height: 384 }, entities: {}, world: { getColumnAt(p: Vec3) { return columns.get(`${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`) ?? null; } } }) as unknown as Bot;
  const dir = mkdtempSync(join(tmpdir(), 'laya-viewer-assets-unit-'));
  for (const name of ['index.html', 'index.js', 'worker.js', 'viewer.js', 'mesh-worker.js', 'three.module.js', 'viewer.css']) writeFileSync(join(dir, name), name.endsWith('.html') ? '<!doctype html><p>own renderer</p>' : '/* own fixture asset */');
  mkdirSync(join(dir, 'textures'));
  for (const version of ['1.21.1', '1.21.4']) copyFileSync(join(dirname(require.resolve('prismarine-viewer')), 'public', 'textures', `${version}.png`), join(dir, 'textures', `${version}.png`));
  return { bot, events, data, column, columns, dir };
}

test('compact encoding preserves exact source state IDs, negative section heights and canonical xyz order without changing the chunk', () => {
  const f = fixture();
  try {
    const before = f.column.toJson(), section = encodeViewerSection(f.column, 0, 4, 0, 7, material);
    assert.equal(section.size, 16); assert.equal(section.revision, 7); assert.equal(Buffer.from(section.voxels, 'base64').length, 8192);
    assert.equal(state(section, 1, 0, 2), f.data.blocksByName.oak_log!.defaultState); assert.equal(state(section, 2, 0, 1), f.data.blocksByName.air!.defaultState);
    f.column.setBlockStateId(new Vec3(3, -1, 4), f.data.blocksByName.stone!.defaultState!);
    const negative = encodeViewerSection(f.column, -2, -1, -3, 1, material); assert.deepEqual(negative.origin, { x: -32, y: -16, z: -48 }); assert.equal(state(negative, 3, 15, 4), f.data.blocksByName.stone!.defaultState);
    const wide = encodeViewerSection({ getBlockStateId(p) { return p.x === 3 ? 70000 : 0; } }, 0, 0, 0, 1, material); assert.equal(state(wide, 3, 0, 0), 70000, 'wire indices are not truncated source state IDs');
    assert.equal(before.includes('sections'), true); const after = f.column.toJson(); encodeViewerSection(f.column, 0, 4, 0, 1, material); assert.equal(f.column.toJson(), after);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('initial work stays bounded to 25 nearest columns and the visible height band, with the current column first', () => {
  const sections = viewerSectionOrder({ x: -0.5, y: 64, z: 0.5 }, 2, -64, 320);
  assert.equal(sections.length, 75); assert.equal(sections[0], '-1,4,0');
  assert.deepEqual(new Set(sections.map(id => id.split(',')[1])), new Set(['3', '4', '5']));
  assert.equal(new Set(sections.map(id => { const [x, , z] = id.split(','); return `${x},${z}`; })).size, 25);
  assert.ok(sections.slice(0, 3).every(id => id.startsWith('-1,') && id.endsWith(',0')));
});

test('native viewer sends camera before compact actual terrain, coalesces deltas, observes real entities and removes unloaded terrain', async () => {
  const f = fixture(), originalListeners = f.events.eventNames().length;
  const server = await createCompactViewerServer(f.bot, { port: 0, prefix: '/viewer/test', assetsRoot: f.dir });
  const messages: ViewerMessage[] = [], socket = new WebSocket(`ws://127.0.0.1:${server.port}/viewer/test/stream`);
  socket.on('message', raw => messages.push(JSON.parse(raw.toString()) as ViewerMessage));
  try {
    await once(socket, 'open'); await until(() => messages.some(message => message.type === 'section' && message.id === '0,4,0'), 'loaded current section must arrive');
    assert.equal(messages[0]!.type, 'hello'); assert.equal(messages[1]!.type, 'camera');
    const hello = messages[0]; assert.ok(hello?.type === 'hello'); assert.equal(hello.version, '1.21.1'); assert.equal(hello.viewDistance, 2);
    assert.ok(hello.atlasUrl?.startsWith('/viewer-assets/'));
    const atlas = await fetch(`http://127.0.0.1:${server.port}${hello.atlasUrl}`);
    assert.equal(atlas.status, 200); assert.equal(atlas.headers.get('content-type'), 'image/png'); assert.ok(atlas.headers.get('cache-control')?.includes('immutable'));
    assert.deepEqual([...new Uint8Array(await atlas.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const legacyAtlas = await fetch(`http://127.0.0.1:${server.port}/viewer/test/atlas.png`, { redirect: 'manual' }); assert.equal(legacyAtlas.status, 307); assert.equal(legacyAtlas.headers.get('location'), hello.atlasUrl);
    const camera = messages[1]; assert.ok(camera?.type === 'camera'); assert.equal(camera.position.y, 65.62);
    const section = messages.find((message): message is ViewerSection => message.type === 'section' && message.id === '0,4,0')!;
    assert.equal(state(section, 1, 0, 2), f.data.blocksByName.oak_log!.defaultState);
    assert.ok(Buffer.byteLength(JSON.stringify(section)) < 30000); assert.equal(JSON.stringify(section).includes('blockEntities'), false);
    const p = new Vec3(1, 64, 2), stone = f.data.blocksByName.stone!.defaultState!, dirt = f.data.blocksByName.dirt!.defaultState!;
    for (const stateId of [stone, dirt, stone]) { f.column.setBlockStateId(p, stateId); f.events.emit('blockUpdate', null, { position: p, stateId }); }
    await until(() => messages.some(message => message.type === 'delta' && message.material.stateId === stone), 'actual block update delta must arrive');
    const delta = messages.filter(message => message.type === 'delta'); assert.equal(delta.length, 1, 'repeated updates to one coordinate coalesce');
    f.bot.entities[2] = { id: 2, uuid: 'friend-uuid', username: 'ActualFriend', name: 'player', type: 'player', position: new Vec3(2.5, 64, 0.5), width: 0.6, height: 1.8 } as never;
    await until(() => messages.some(message => message.type === 'entities' && message.entities.some(entity => entity.name === 'ActualFriend')), 'only actual observed entities must arrive');
    socket.send(JSON.stringify({ action: 'dig', position: p })); assert.equal(f.column.getBlockStateId(p), stone, 'client data has no game action handler');
    f.events.emit('chunkColumnUnload', new Vec3(0, 0, 0)); await until(() => messages.some(message => message.type === 'remove' && message.id === '0,4,0'), 'unloaded terrain must be removed');
  } finally { socket.terminate(); server.close(); rmSync(f.dir, { recursive: true, force: true }); }
  assert.equal(f.events.eventNames().length, originalListeners, 'all project observer listeners are removed on close');
});

test('a changed dimension resets client terrain and a failed listen does not leak observers', async () => {
  const f = fixture(), server = await createCompactViewerServer(f.bot, { port: 0, prefix: '/viewer/reset', assetsRoot: f.dir });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/viewer/reset/stream`), messages: ViewerMessage[] = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString()) as ViewerMessage));
  try {
    await once(socket, 'open'); await until(() => messages.some(message => message.type === 'section'), 'initial terrain');
    const before = f.events.listenerCount('blockUpdate');
    await assert.rejects(createCompactViewerServer(f.bot, { port: server.port, prefix: '/viewer/conflict', assetsRoot: f.dir }), /EADDRINUSE/);
    assert.equal(f.events.listenerCount('blockUpdate'), before);
    f.bot.game.dimension = 'the_nether'; await until(() => messages.some(message => message.type === 'reset' && message.dimension === 'the_nether'), 'dimension reset must precede replacement terrain');
    const index = messages.findIndex(message => message.type === 'reset'); assert.equal(messages[index + 1]!.type, 'hello');
  } finally { socket.terminate(); server.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('column reload advances revision and reconnect hello removes terrain outside the actual loaded current area', async () => {
  const f = fixture(), server = await createCompactViewerServer(f.bot, { port: 0, prefix: '/viewer/reload', assetsRoot: f.dir });
  const messages: ViewerMessage[] = [], socket = new WebSocket(`ws://127.0.0.1:${server.port}/viewer/reload/stream`);
  let reconnect: WebSocket | undefined;
  socket.on('message', raw => messages.push(JSON.parse(raw.toString()) as ViewerMessage));
  try {
    await once(socket, 'open'); await until(() => messages.some(message => message.type === 'section' && message.id === '0,4,0'), 'first loaded column');
    const previous = messages.find((message): message is ViewerSection => message.type === 'section' && message.id === '0,4,0')!;
    f.column.setBlockStateId(new Vec3(1, 64, 2), f.data.blocksByName.dirt!.defaultState!); f.events.emit('chunkColumnLoad', new Vec3(0, 0, 0));
    await until(() => messages.some(message => message.type === 'section' && message.id === '0,4,0' && message.revision > previous.revision), 'same-id reload must not be ignored as an old revision');
    const updated = messages.filter((message): message is ViewerSection => message.type === 'section' && message.id === '0,4,0').at(-1)!;
    assert.equal(state(updated, 1, 0, 2), f.data.blocksByName.dirt!.defaultState);
    const closed = once(socket, 'close'); socket.terminate(); await closed;
    f.columns.delete('0,0'); f.columns.set('8,0', f.column); f.bot.entity.position = new Vec3(128.5, 64, 0.5);
    const after: ViewerMessage[] = []; reconnect = new WebSocket(`ws://127.0.0.1:${server.port}/viewer/reload/stream`);
    reconnect.on('message', raw => after.push(JSON.parse(raw.toString()) as ViewerMessage)); await once(reconnect, 'open');
    await until(() => after.some(message => message.type === 'hello'), 'reconnection hello');
    const hello = after[0]; assert.ok(hello?.type === 'hello'); assert.deepEqual(hello.sectionIds, ['8,4,0', '8,3,0', '8,5,0']);
    assert.equal(hello.sectionIds.includes(previous.id), false, 'same-stream retained scene receives authoritative pruning');
  } finally { reconnect?.terminate(); socket.terminate(); server.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('invalid observed section stays absent without starving other actual terrain or crashing bot event listeners', async () => {
  const f = fixture();
  f.columns.set('0,0', { getBlockStateId(p) { if (p.y >= 64 && p.y < 80) throw new Error('Public loaded section unavailable'); return f.column.getBlockStateId(p); } });
  const server = await createCompactViewerServer(f.bot, { port: 0, prefix: '/viewer/unavailable', assetsRoot: f.dir });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/viewer/unavailable/stream`), messages: ViewerMessage[] = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString()) as ViewerMessage));
  try {
    await once(socket, 'open'); await until(() => messages.some(message => message.type === 'section' && message.id === '0,3,0'), 'valid ground section still arrives');
    assert.equal(messages.some(message => message.type === 'section' && message.id === '0,4,0'), false, 'unavailable cells must not become invented air');
    assert.ok(messages.some(message => message.type === 'status' && message.reason.includes('0,4,0')));
  } finally { socket.terminate(); server.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('more than 128 pending cell updates recover with a bounded fresh full section', async () => {
  const f = fixture(), server = await createCompactViewerServer(f.bot, { port: 0, prefix: '/viewer/overflow', assetsRoot: f.dir });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/viewer/overflow/stream`), messages: ViewerMessage[] = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString()) as ViewerMessage));
  try {
    await once(socket, 'open'); await until(() => messages.some(message => message.type === 'section' && message.id === '0,4,0'), 'initial section');
    const stone = f.data.blocksByName.stone!.defaultState!;
    for (let n = 0; n < 140; n++) { const position = new Vec3(n & 15, 64, n >> 4); f.column.setBlockStateId(position, stone); f.events.emit('blockUpdate', null, { position, stateId: stone }); }
    await until(() => messages.some(message => message.type === 'section' && message.id === '0,4,0' && message.revision >= 141), 'overflow must request one fresh authoritative section');
    const fresh = messages.filter((message): message is ViewerSection => message.type === 'section' && message.id === '0,4,0').at(-1)!;
    assert.equal(state(fresh, 0, 0, 0), stone); assert.equal(state(fresh, 11, 0, 8), stone);
    assert.ok(messages.filter(message => message.type === 'delta').length <= 128);
  } finally { socket.terminate(); server.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('camera samples at 20Hz and entities at 10Hz, while unchanged frames only heartbeat once per second', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 10000 });
  const f = fixture(), server = await createCompactViewerServer(f.bot, { port: 0, prefix: '/viewer/motion', assetsRoot: f.dir });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/viewer/motion/stream`), messages: ViewerMessage[] = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString()) as ViewerMessage));
  const count = (type: ViewerMessage['type']) => messages.filter(message => message.type === type).length;
  try {
    await once(socket, 'open'); await until(() => count('camera') === 1, 'initial camera');
    f.bot.entity.yaw = 0.5;
    t.mock.timers.tick(49); await delay(20); assert.equal(count('camera'), 1);
    t.mock.timers.tick(1); await until(() => count('camera') === 2, 'camera orientation changes on the 50ms sample');
    assert.equal(count('entities'), 0);
    f.bot.entities[2] = { id: 2, uuid: 'moving-mob', name: 'cow', type: 'mob', position: new Vec3(3, 64, 1), width: 0.9, height: 1.4 } as never;
    t.mock.timers.tick(50); await until(() => count('entities') === 1, 'first entity sample at 100ms');
    const cow = f.bot.entities[2]!; cow.position.x = 4;
    t.mock.timers.tick(99); await delay(20); assert.equal(count('entities'), 1);
    t.mock.timers.tick(1); await until(() => count('entities') === 2, 'changed entity sample at 200ms');
    const moving = messages.filter(message => message.type === 'entities').at(-1)!; assert.ok(moving.type === 'entities'); assert.equal(moving.entities[0]!.position.x, 4);
    // All intermediate 50/100ms samples stay suppressed when actual observations are unchanged.
    const stationaryCamera = count('camera'), stationaryEntities = count('entities');
    t.mock.timers.tick(500); await delay(25);
    assert.equal(count('camera'), stationaryCamera); assert.equal(count('entities'), stationaryEntities);
    t.mock.timers.tick(600); await until(() => count('camera') === stationaryCamera + 1 && count('entities') === stationaryEntities + 1, 'one-second stationary heartbeat');
    f.bot.entity.position.x = 0.75;
    t.mock.timers.tick(50); await until(() => count('camera') === stationaryCamera + 2, 'motion resumes immediately at the next 20Hz sample');
  } finally { socket.terminate(); server.close(); rmSync(f.dir, { recursive: true, force: true }); t.mock.timers.reset(); }
});
