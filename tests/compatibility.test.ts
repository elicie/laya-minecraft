import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import minecraftData from 'minecraft-data';
import { createDeserializer, createSerializer, states } from 'minecraft-protocol';
import { protocolCompatibility, resolveBotCompatibility } from '../packages/minecraft/src/compatibility';

const fixturePath = join(process.cwd(), 'tests/fixtures/protocol-767-recipes.bin.gz');
const recipePacket = () => Buffer.concat([Buffer.from([0x77]), gunzipSync(readFileSync(fixturePath))]);

test('compatibility builds an isolated public option for protocol 767 only', () => {
  const original = structuredClone(minecraftData('1.21.1').protocol);
  const compatibility = protocolCompatibility('1.21.1');
  assert.deepEqual(compatibility.corrections, ['protocol-767-recipe-serializer-ids']);
  assert.ok(compatibility.customPackets);
  assert.deepEqual(minecraftData('1.21.1').protocol, original);
  assert.ok(protocolCompatibility('1.21').customPackets);
  assert.equal(protocolCompatibility('1.21.3').customPackets, undefined);
  assert.equal(protocolCompatibility('1.20.4').customPackets, undefined);
  assert.throws(() => protocolCompatibility('not-a-minecraft-version'), /unavailable/);
});

test('unmodified upstream decoder reproduces the captured recipe failure', () => {
  // Each protocol version is cached by minecraft-protocol. A separate process
  // tests the original decoder without replacing or clearing library caches.
  const source = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs'), zlib = require('node:zlib');
    const mc = require('minecraft-protocol');
    const reader = mc.createDeserializer({ state: mc.states.PLAY, version: '1.21.1', isServer: false });
    const packet = Buffer.concat([Buffer.from([0x77]), zlib.gunzipSync(fs.readFileSync(process.argv[1]))]);
    assert.throws(() => reader.parsePacketBuffer(packet), error => error.partialReadError === true);
  `;
  execFileSync(process.execPath, ['-e', source, fixturePath], { cwd: process.cwd() });
});

test('public corrected decoder reads the whole real packet and preserves all recipe kinds', () => {
  const customPackets = protocolCompatibility('1.21.1').customPackets;
  const reader = createDeserializer({ state: states.PLAY, version: '1.21.1', isServer: false, customPackets });
  const packet = recipePacket();
  const decoded = reader.parsePacketBuffer(packet) as {
    metadata: { size: number };
    data: { name: string; params: { recipes: { name: string; type: string; data?: { result?: { itemId: number } } }[] } };
  };
  assert.equal(decoded.data.name, 'declare_recipes');
  assert.equal(decoded.metadata.size, packet.length);
  assert.equal(decoded.data.params.recipes.length, 1290);
  const kinds = new Set(decoded.data.params.recipes.map((recipe) => recipe.type));
  assert.equal(kinds.size, 23);
  assert.equal(kinds.has('minecraft:crafting_special_banneraddpattern'), false);
  for (const kind of ['crafting_special_shielddecoration', 'smelting', 'stonecutting', 'smithing_transform', 'smithing_trim', 'crafting_decorated_pot']) {
    assert.ok(kinds.has(`minecraft:${kind}`), kind);
  }
  const stoneBricks = decoded.data.params.recipes.find((recipe) => recipe.name === 'minecraft:stone_bricks_from_stone_stonecutting');
  assert.equal(stoneBricks?.type, 'minecraft:stonecutting');
  assert.equal(stoneBricks?.data?.result?.itemId, minecraftData('1.21.1').itemsByName.stone_bricks.id);
  const serializer = createSerializer({ state: states.PLAY, version: '1.21.1', isServer: true, customPackets });
  assert.deepEqual(serializer.createPacketBuffer(decoded.data), packet);
  assert.throws(() => reader.parsePacketBuffer(packet.subarray(0, -1)), (error: unknown) =>
    error instanceof Error && (error as Error & { partialReadError?: boolean }).partialReadError === true);
});

test('automatic version detection checks numeric protocol and leaves later layouts alone', async () => {
  let probeOptions: unknown;
  const ping = async (options: unknown) => {
    probeOptions = options;
    return { description: '', players: { max: 20, online: 0 }, version: { name: 'Custom display name', protocol: 767 }, latency: 0 };
  };
  const resolved = await resolveBotCompatibility({ username: 'TestBot', host: 'example.test', port: 25566 }, { ping });
  assert.equal(resolved.version, '1.21.1');
  assert.deepEqual(probeOptions, { host: 'example.test', port: 25566, closeTimeout: 5000, noPongTimeout: 1000 });
  const later = await resolveBotCompatibility({ username: 'TestBot' }, {
    ping: async () => ({ description: '', players: { max: 20, online: 0 }, version: { name: '1.21.3', protocol: 768 }, latency: 0 }),
  });
  assert.equal(later.version, '1.21.3');
  assert.equal(later.customPackets, undefined);
  await assert.rejects(resolveBotCompatibility({ username: 'TestBot' }, {
    ping: async () => ({ description: '', players: { max: 20, online: 0 }, version: { name: 'unknown', protocol: 99999 }, latency: 0 }),
  }), /unsupported/);
});

test('explicit versions avoid extra probes and unknown custom codecs are never merged blindly', async () => {
  const ping = async (): Promise<never> => { throw new Error('Must not probe'); };
  const explicit = await resolveBotCompatibility({ username: 'TestBot', version: '1.20.4' }, { ping });
  assert.equal(explicit.version, '1.20.4');
  assert.equal(explicit.customPackets, undefined);
  await assert.rejects(resolveBotCompatibility({ username: 'TestBot', customPackets: { custom: true } }), /cannot be combined/);
  await assert.rejects(resolveBotCompatibility({ username: 'TestBot' }, { ping: async () => { throw new Error('ETIMEDOUT'); } }), /ETIMEDOUT/);
});
