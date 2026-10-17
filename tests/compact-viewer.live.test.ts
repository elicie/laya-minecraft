import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { Vec3 } from 'vec3';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { createCompactViewerServer } from '../packages/minecraft/src/viewer-stream';
import type { ViewerMessage, ViewerSection } from '../packages/minecraft/src/viewer-protocol';

const host = process.env.MC_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Read-only viewer validation requires minecraft-laya-validation on 127.0.0.1:25566');
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('actual loaded terrain reaches the compact browser renderer with exact version states and no gameplay or fixture commands', { timeout: 90000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const bot = await createCompatibleBot({ host, port: 25566, username: `LayaVx${randomUUID().slice(0, 8)}`, version: process.env.MC_VERSION ?? '1.21.1', auth: 'offline' });
  let viewer: Awaited<ReturnType<typeof createCompactViewerServer>> | undefined, socket: WebSocket | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const spawnDeadline = AbortSignal.timeout(20000);
    await once(bot, 'spawn', { signal: spawnDeadline });
    const deadline = Date.now() + 10000;
    while (!bot.world.getColumnAt(bot.entity.position) && Date.now() < deadline) await wait(50);
    assert.ok(bot.world.getColumnAt(bot.entity.position));
    viewer = await createCompactViewerServer(bot, { port: 0, prefix: '/viewer/actual', ...(process.env.LAYA_VIEWER_ASSET_ROOT ? { assetsRoot: process.env.LAYA_VIEWER_ASSET_ROOT } : {}) });
    const wire: ViewerMessage[] = [], connectedAt = Date.now();
    socket = new WebSocket(`ws://127.0.0.1:${viewer.port}/viewer/actual/stream`);
    socket.on('message', raw => wire.push(JSON.parse(raw.toString()) as ViewerMessage)); await once(socket, 'open');
    while (!wire.some(frame => frame.type === 'section') && Date.now() - connectedAt < 10000) await wait(20);
    assert.equal(wire[0]?.type, 'hello'); assert.equal(wire[1]?.type, 'camera');
    const hello = wire[0]; assert.ok(hello?.type === 'hello'); assert.equal(hello.version, bot.version);
    const sections = wire.filter((frame): frame is ViewerSection => frame.type === 'section'); assert.ok(sections.length);
    let compared = 0;
    for (const section of sections) {
      const indices = Buffer.from(section.voxels, 'base64'); assert.equal(indices.length, 8192);
      for (let n = 0; n < 4096 && compared < 12; n++) {
        const material = section.palette[indices.readUInt16LE(n * 2)]!;
        if (material.shape === 'empty') continue;
        const p = new Vec3(section.origin.x + (n & 15), section.origin.y + (n >> 8), section.origin.z + ((n >> 4) & 15));
        const actual = bot.blockAt(p); if (!actual) continue;
        assert.equal(material.stateId, actual.stateId); assert.equal(material.name, actual.name); compared++;
      }
    }
    // The first section can be actual air. Let the loaded ground band follow.
    if (!compared) {
      await wait(1000);
      for (const section of wire.filter((frame): frame is ViewerSection => frame.type === 'section')) {
        const bytes = Buffer.from(section.voxels, 'base64');
        for (let n = 0; n < 4096 && compared < 12; n++) { const material = section.palette[bytes.readUInt16LE(n * 2)]!; if (material.shape === 'empty') continue; const p = new Vec3(section.origin.x + (n & 15), section.origin.y + (n >> 8), section.origin.z + ((n >> 4) & 15)); const actual = bot.blockAt(p); if (actual) { assert.equal(actual.stateId, material.stateId); assert.equal(actual.name, material.name); compared++; } }
      }
    }
    assert.ok(compared > 0, 'actual terrain must be compared; an empty sky packet is not render proof');
    browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } }), errors: string[] = [], failedResponses: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) failedResponses.push(`${response.status()} ${response.url()}`); });
    const startedAt = Date.now(); await page.goto(`http://127.0.0.1:${viewer.port}/viewer/actual/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const telemetry = (window as unknown as { layaViewerTelemetry?: { status: string; triangles: number; renderedSections: number; cameraReady: boolean; textureReady: boolean } }).layaViewerTelemetry;
      return telemetry?.status === 'terrain-ready' && telemetry.triangles > 0 && telemetry.renderedSections > 0 && telemetry.cameraReady && telemetry.textureReady;
    }, undefined, { timeout: 30000 });
    const telemetry = await page.evaluate(() => (window as unknown as { layaViewerTelemetry: unknown }).layaViewerTelemetry);
    assert.deepEqual(errors, []); assert.deepEqual(failedResponses, []); await page.screenshot({ path: '/tmp/laya-compact-viewer-live.png' });
    console.log('Actual compact viewer render proof', JSON.stringify({ version: bot.version, position: bot.entity.position, comparedBlocks: compared, firstTerrainBytes: Buffer.byteLength(JSON.stringify(sections[0])), elapsedMs: Date.now() - startedAt, telemetry, screenshot: '/tmp/laya-compact-viewer-live.png' }));
  } finally { await browser?.close(); socket?.terminate(); viewer?.close(); bot.quit('Read-only compact viewer validation complete'); }
});
