import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { createViewerAssets, viewerHtml, type ViewerAssets } from '../apps/server/src/viewer-assets';
import { createViewerAssets as sharedFactory, ViewerAssetsNotBuiltError } from '../packages/minecraft/src/viewer-assets';
import { proxyViewerHttp, type ViewerTarget } from '../apps/server/src/viewer-proxy';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'laya-viewer-assets-')), root = join(directory, 'public');
  mkdirSync(join(root, 'blocksStates'), { recursive: true }); mkdirSync(join(root, 'textures/1.21.4/entity'), { recursive: true });
  const worker = Buffer.from('/* original worker bytes */'.repeat(10000)), index = Buffer.from('const socketPath=window.location.pathname+"socket.io";');
  writeFileSync(join(root, 'worker.js'), worker); writeFileSync(join(root, 'index.js'), index);
  writeFileSync(join(root, 'three.module.js'), 'export class Scene {}'); writeFileSync(join(root, 'viewer.css'), 'body{margin:0}');
  writeFileSync(join(root, 'blocksStates/1.21.4.json'), JSON.stringify({ original: Array.from({ length: 100 }, (_, i) => i) }));
  writeFileSync(join(root, 'textures/1.21.4.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  writeFileSync(join(root, 'textures/1.21.4/entity/cow.png'), Buffer.from([137, 80, 78, 71, 4, 5]));
  writeFileSync(join(root, 'index.html'), 'upstream HTML must not supply the project iframe'); writeFileSync(join(root, 'secret.txt'), 'private-file');
  writeFileSync(join(directory, 'outside.png'), 'outside-distribution'); symlinkSync(join(directory, 'outside.png'), join(root, 'textures/1.21.4/entity/escape.png'));
  const assets = await createViewerAssets({ publicRoot: root });
  const server = createServer(async (req, res) => { if (!await assets.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { directory, root, worker, index, assets, base, async close() { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); } };
}
async function raw(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = get(url, { headers, method }, res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', reject); }); req.on('error', reject);
  });
}

test('isolated immutable assets preserve original bytes, gzip negotiation, HEAD and HTTP validators', async () => {
  const f = await fixture();
  try {
    const url = `${f.base}${f.assets.basePath}/worker.js`;
    const zipped = await raw(url, { 'accept-encoding': 'gzip' });
    assert.equal(zipped.status, 200); assert.equal(zipped.headers['content-encoding'], 'gzip'); assert.deepEqual(gunzipSync(zipped.body), f.worker);
    assert.match(zipped.headers['cache-control']!, /public.*immutable/); assert.equal(zipped.headers.vary, 'Accept-Encoding');
    assert.equal(Number(zipped.headers['content-length']), zipped.body.length); assert.ok(zipped.body.length < f.worker.length / 10);
    const identity = await raw(url, { 'accept-encoding': 'gzip;q=0, *;q=1' }); assert.equal(identity.headers['content-encoding'], undefined); assert.deepEqual(identity.body, f.worker);
    const head = await raw(url, { 'accept-encoding': 'gzip' }, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers['content-length'], zipped.headers['content-length']);
    const cached = await raw(url, { 'if-none-match': zipped.headers.etag! }); assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
    const byTime = await raw(url, { 'if-modified-since': zipped.headers['last-modified']! }); assert.equal(byTime.status, 304);
    const overriddenTime = await raw(url, { 'if-none-match': 'W/"different"', 'if-modified-since': zipped.headers['last-modified']! }); assert.equal(overriddenTime.status, 200);
    const png = await raw(`${f.base}${f.assets.basePath}/textures/1.21.4.png`, { 'accept-encoding': 'gzip' }); assert.equal(png.headers['content-encoding'], undefined); assert.equal(png.headers['content-type'], 'image/png');
    const css = await raw(`${f.base}${f.assets.basePath}/viewer.css`, { 'accept-encoding': 'gzip' }); assert.equal(css.headers['content-type'], 'text/css; charset=utf-8'); assert.equal(gunzipSync(css.body).toString(), 'body{margin:0}');
    assert.equal((await raw(`${f.base}${f.assets.basePath}/three.module.js`)).body.toString(), 'export class Scene {}');
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => raw(`${f.base}${f.assets.basePath}/index.js`, { 'accept-encoding': 'gzip' })));
    assert.ok(concurrent.every(value => gunzipSync(value.body).equals(f.index)));
  } finally { await f.close(); }
});

test('cache identity is shared across instances and changes when the shipped bundle content changes', async () => {
  const f = await fixture();
  try {
    const same = await createViewerAssets({ publicRoot: f.root }); assert.equal(same.basePath, f.assets.basePath);
    writeFileSync(join(f.root, 'worker.js'), 'changed public distribution');
    const changed = await createViewerAssets({ publicRoot: f.root }); assert.notEqual(changed.basePath, f.assets.basePath);
    writeFileSync(join(f.root, 'textures/1.21.4/entity/cow.png'), Buffer.from([137, 80, 78, 71, 9, 9]));
    const changedTexture = await createViewerAssets({ publicRoot: f.root }); assert.notEqual(changedTexture.basePath, changed.basePath, 'same-named texture bytes must change the immutable URL');
    writeFileSync(join(f.root, 'blocksStates/1.21.4.json'), '{"changed":true}');
    const changedModel = await createViewerAssets({ publicRoot: f.root }); assert.notEqual(changedModel.basePath, changedTexture.basePath, 'same-named model bytes must change the immutable URL');
  } finally { await f.close(); }
});

test('allowlist, version and filesystem boundaries reject traversal, double encoding, symlinks and dynamic endpoints', async () => {
  const f = await fixture();
  try {
    for (const suffix of ['../secret.txt', '%2e%2e/secret.txt', '%252e%252e/secret.txt', 'textures/1.21.4/entity/%2e%2e/%2e%2e/secret.png', 'textures/1.21.4/entity/escape.png', 'socket.io/', 'index.html', 'secret.txt', 'textures/1.21.4/../../secret.txt']) {
      assert.equal((await raw(`${f.base}${f.assets.basePath}/${suffix}`)).status, 404, suffix);
    }
    assert.equal((await raw(`${f.base}/viewer-assets/${'0'.repeat(64)}/worker.js`)).status, 404);
    assert.equal((await raw(`${f.base}${f.assets.basePath}/worker.js`, {}, 'POST')).status, 405);
  } finally { await f.close(); }
});

test('project iframe preserves the bot document URL and socket path while all relative assets use the shared base', async () => {
  const f = await fixture(); const target = { botId: 'bot-a', sessionId: 'session', port: 4099, prefix: '/viewer/bot-a' };
  const server = createServer((req, res) => proxyViewerHttp(req, res, target, f.assets.basePath));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await raw(`${base}/viewer/bot-a/?viewerSession=unchanged`), html = response.body.toString();
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(html, /<base href="\/viewer-assets\/[a-f0-9]{64}\/">/); assert.match(html, /src="index.js"/); assert.equal(html.includes('upstream HTML'), false);
    assert.match(html, /<script type="module"/); assert.match(html, /href="viewer.css"/); assert.match(html, /id="world"/); assert.match(html, /id="notice" role="status"/); assert.match(html, /id="details"/);
    const assetBase = /<base href="([^"]+)"/.exec(html)![1]!;
    assert.equal(new URL('worker.js', base + assetBase).pathname, `${f.assets.basePath}/worker.js`);
    assert.equal(new URL('blocksStates/1.21.4.json', base + assetBase).pathname, `${f.assets.basePath}/blocksStates/1.21.4.json`);
    assert.equal(new URL('/viewer/bot-a/', base).pathname + 'socket.io', '/viewer/bot-a/socket.io');
    assert.equal(new URL('stream', `${base}/viewer/bot-a/`).pathname, '/viewer/bot-a/stream');
    assert.equal((await raw(`${base}/viewer/bot-a/`, {}, 'HEAD')).body.length, 0);
    assert.throws(() => viewerHtml('https://external.invalid/worker.js')); assert.throws(() => viewerHtml('/viewer-assets/"onerror="bad'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test('shared factory uses the explicit compact distribution root and reports missing builds without library fallback', async () => {
  const f = await fixture(), previous = process.env.LAYA_VIEWER_ASSET_ROOT;
  try {
    assert.equal(sharedFactory, createViewerAssets, 'the API and bot viewer must share one implementation');
    process.env.LAYA_VIEWER_ASSET_ROOT = f.root;
    assert.equal((await sharedFactory()).basePath, f.assets.basePath);
    process.env.LAYA_VIEWER_ASSET_ROOT = join(f.directory, 'not-built');
    await assert.rejects(sharedFactory(), (error: unknown) => error instanceof ViewerAssetsNotBuiltError && error.statusCode === 503 && error.code === 'VIEWER_ASSETS_NOT_BUILT');
    rmSync(join(f.root, 'three.module.js'));
    await assert.rejects(sharedFactory({ publicRoot: f.root }), /three\.module\.js/);
  } finally { if (previous === undefined) delete process.env.LAYA_VIEWER_ASSET_ROOT; else process.env.LAYA_VIEWER_ASSET_ROOT = previous; await f.close(); }
});

test('legacy per-bot static paths redirect to the same asset URL without caching live Socket.IO traffic', async () => {
  const f = await fixture(); let upstreamPaths: string[] = [];
  const upstream = createServer((req, res) => { upstreamPaths.push(req.url!); res.writeHead(200, { 'cache-control': 'public, max-age=3600' }); res.end('original upstream'); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve)); const port = (upstream.address() as AddressInfo).port;
  const proxy = createServer((req, res) => {
    const match = req.url!.match(/^\/viewer\/(bot-[ab])\/(.*)$/)!;
    if (f.assets.redirect(req, res, match[2]!)) return;
    proxyViewerHttp(req, res, { botId: match[1]!, sessionId: 'session', prefix: `/viewer/${match[1]}`, port });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    const a = await raw(`${base}/viewer/bot-a/worker.js`), b = await raw(`${base}/viewer/bot-b/worker.js`);
    assert.equal(a.status, 307); assert.equal(a.headers.location, b.headers.location); assert.equal(a.headers.location, `${f.assets.basePath}/worker.js`); assert.deepEqual(upstreamPaths, []);
    const socket = await raw(`${base}/viewer/bot-a/socket.io/?transport=polling`); assert.equal(socket.status, 200); assert.equal(socket.headers['cache-control'], 'no-store'); assert.equal(socket.body.toString(), 'original upstream');
    const html = await raw(`${base}/viewer/bot-a/`); assert.equal(html.body.toString(), 'original upstream', 'undefined optional assetBase keeps the old caller behavior');
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); await new Promise<void>(resolve => upstream.close(() => resolve())); await f.close(); }
});
