import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createViewerAssets } from '../packages/minecraft/src/viewer-assets';

const configFile = resolve('apps/web/vite.config.ts');
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
async function configuredServer(kind: 'dev' | 'preview') {
  const vite = await import('vite');
  const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'test', isPreview: kind === 'preview' }, configFile);
  assert.ok(loaded);
  const options: unknown[] = loaded.config.plugins ?? [];
  const plugins = (await Promise.all(options)).flat(Infinity) as import('vite').Plugin[];
  const plugin = plugins.find(value => value?.name === 'laya-compact-viewer-assets'); assert.ok(plugin);
  const hook = kind === 'dev' ? plugin.configureServer : plugin.configurePreviewServer; assert.equal(typeof hook, 'function');
  let middleware: Middleware | undefined;
  (hook as (server: { middlewares: { use(value: Middleware): void } }) => void)({ middlewares: { use(value) { middleware = value; } } });
  assert.ok(middleware);
  const server = createServer((req, res) => middleware!(req, res, () => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>UI</title>'); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(done => server.close(() => done())) };
}

test('Vite dev and preview serve immutable compact assets directly and initialize their shared factory lazily once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'laya-vite-viewer-'));
  const root = join(directory, 'compact-viewer');
  const previous = process.env.LAYA_VIEWER_ASSET_ROOT;
  try {
    for (const kind of ['dev', 'preview'] as const) {
      rmSync(root, { recursive: true, force: true });
      process.env.LAYA_VIEWER_ASSET_ROOT = root;
      const server = await configuredServer(kind), { base } = server;
      try {
        assert.equal((await fetch(`${base}/`)).status, 200, `${kind}: ordinary UI must not initialize missing assets`);
        mkdirSync(root); writeFileSync(join(root, 'index.js'), 'console.log("compact-viewer")');
        writeFileSync(join(root, 'worker.js'), '/* compact worker */'.repeat(1000));
        writeFileSync(join(root, 'three.module.js'), 'export class Scene {}'); writeFileSync(join(root, 'viewer.css'), 'body{margin:0}');
        const assets = await createViewerAssets({ publicRoot: root }), assetUrl = `${base}${assets.basePath}/worker.js`;
        const response = await fetch(assetUrl);
        assert.equal(response.status, 200); assert.equal(response.headers.get('content-encoding'), 'gzip');
        assert.match(response.headers.get('cache-control')!, /immutable/); assert.equal(await response.text(), '/* compact worker */'.repeat(1000));
        assert.equal((await fetch(assetUrl, { headers: { 'if-none-match': response.headers.get('etag')! } })).status, 304);
        assert.equal((await fetch(`${base}${assets.basePath}/viewer.css`, { method: 'HEAD' })).headers.get('content-type'), 'text/css; charset=utf-8');
        process.env.LAYA_VIEWER_ASSET_ROOT = join(directory, 'different-missing-root');
        assert.equal((await fetch(assetUrl)).status, 200, `${kind}: later requests reuse the initialized factory`);
      } finally { await server.close(); }
    }
  } finally { if (previous === undefined) delete process.env.LAYA_VIEWER_ASSET_ROOT; else process.env.LAYA_VIEWER_ASSET_ROOT = previous; rmSync(directory, { recursive: true, force: true }); }
});

test('Vite asset errors explicitly report an unbuilt distribution while unrelated UI routes still work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'laya-vite-missing-viewer-'));
  const previous = process.env.LAYA_VIEWER_ASSET_ROOT;
  process.env.LAYA_VIEWER_ASSET_ROOT = join(directory, 'not-built');
  const server = await configuredServer('dev');
  try {
    const response = await fetch(`${server.base}/viewer-assets/${'0'.repeat(64)}/index.js`);
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'VIEWER_ASSETS_NOT_BUILT');
    assert.equal((await fetch(`${server.base}/`)).status, 200);
  } finally { await server.close(); if (previous === undefined) delete process.env.LAYA_VIEWER_ASSET_ROOT; else process.env.LAYA_VIEWER_ASSET_ROOT = previous; rmSync(directory, { recursive: true, force: true }); }
});
