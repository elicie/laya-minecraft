import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import blockLoader from 'prismarine-block';
import minecraftData from 'minecraft-data';
import { createViewerMaterials } from '../packages/minecraft/src/viewer-materials';

const version = '1.21.4', Block = blockLoader(version), data = minecraftData(version);
const state = (name: string, properties = {}) => Block.fromProperties(data.blocksByName[name]!.id, properties, 0).stateId;
const texture = { u: 0.25, v: 0.5, su: 0.0625, sv: 0.0625 };
const cube = { textures: { all: texture }, elements: [{ from: [0, 0, 0], to: [16, 16, 16] }] };
async function fixture(atlasVersion = version) {
  const root = await mkdtemp(join(tmpdir(), 'laya-materials-'));
  await Promise.all(['textures', 'blocksStates'].map(dir => mkdir(join(root, dir))));
  await writeFile(join(root, 'textures', `${atlasVersion}.png`), 'fixture');
  await writeFile(join(root, 'blocksStates', `${atlasVersion}.json`), JSON.stringify({
    oak_planks: { variants: { '': { model: cube } } },
    oak_door: { variants: { 'open=false': { model: cube }, 'open=true': { model: cube, y: 90 } } },
    torch: { variants: { '': { model: { textures: { particle: texture }, elements: [{ from: [7, 0, 7], to: [9, 10, 9] }] } } } },
    oak_fence: { multipart: [{ when: { OR: [{ north: 'true' }, { south: 'true' }] }, apply: { model: cube } }, { apply: { model: cube } }] },
  }));
  return root;
}

test('viewer uses actual source state/properties and keeps door, slab, stair bounds', async () => {
  const root = await fixture();
  try {
    const materials = await createViewerMaterials(version, { assetsRoot: root });
    const closed = materials.material(state('oak_door', { facing: 'east', half: 'lower', hinge: 'left', open: false, powered: false }));
    const opened = materials.material(state('oak_door', { facing: 'east', half: 'lower', hinge: 'left', open: true, powered: false }));
    assert.equal(closed.name, 'oak_door'); assert.equal(closed.properties?.open, false);
    assert.equal(opened.properties?.open, true); assert.notEqual(closed.stateId, opened.stateId);
    assert.notDeepEqual(closed.boxes, opened.boxes); assert.equal(closed.shape, 'boxes');
    assert.equal(closed.opaque, false); assert.equal(opened.fallback, true);
    const slab = materials.material(state('oak_slab', { type: 'bottom', waterlogged: false }));
    assert.equal(slab.boxes?.[0]?.[4], 0.5); assert.equal(slab.opaque, false);
    const stairs = materials.material(state('oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: false }));
    assert.ok(stairs.boxes!.length > 1); assert.equal(stairs.shape, 'boxes');
    assert.equal(materials.material(closed.stateId), closed, 'repeated states reuse bounded cached metadata');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('viewer decorations, fluids, glass and multipart do not become opaque solid cubes', async () => {
  const root = await fixture();
  try {
    const materials = await createViewerMaterials(version, { assetsRoot: root });
    const torch = materials.material(state('torch'));
    assert.equal(torch.shape, 'boxes'); assert.deepEqual(torch.boxes, [[7 / 16, 0, 7 / 16, 9 / 16, 10 / 16, 9 / 16]]);
    assert.equal(torch.opaque, false); assert.ok(torch.faces?.up);
    const water = materials.material(state('water', { level: 0 }));
    assert.equal(water.shape, 'slab'); assert.equal(water.transparent, true); assert.equal(water.opaque, false);
    const glass = materials.material(state('glass'));
    assert.equal(glass.opaque, false); assert.equal(glass.transparent, true);
    const fence = materials.material(state('oak_fence', { east: false, north: true, south: false, west: false, waterlogged: false }));
    assert.equal(fence.shape, 'boxes'); assert.ok(fence.faces?.north); assert.equal(fence.fallback, true);
    const barrier = materials.material(state('barrier'));
    assert.equal(barrier.shape, 'empty'); assert.equal(barrier.opaque, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('older atlas uses block names while source state IDs and properties remain from actual version', async () => {
  const root = await fixture();
  try {
    const actualVersion = '1.21.5', actualData = minecraftData(actualVersion), ActualBlock = blockLoader(actualVersion);
    const actual = ActualBlock.fromProperties(actualData.blocksByName.oak_planks!.id, {}, 0);
    const materials = await createViewerMaterials(actualVersion, { assetsRoot: root });
    const result = materials.material(actual.stateId);
    assert.equal(result.stateId, actual.stateId); assert.equal(result.name, actual.name);
    assert.equal(materials.atlasVersion, version); assert.equal(materials.approximate, true);
    assert.equal(result.fallback, true); assert.deepEqual(result.faces?.east, texture);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing assets retain observed source geometry and explicit visual fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'laya-materials-missing-'));
  try {
    const materials = await createViewerMaterials(version, { assetsRoot: root });
    const result = materials.material(state('oak_planks'));
    assert.equal(materials.atlasPath, undefined); assert.equal(materials.approximate, true);
    assert.equal(result.shape, 'cube'); assert.equal(result.fallback, true); assert.equal(result.faces, undefined);
    assert.equal(materials.material(state('air')).shape, 'empty');
  } finally { await rm(root, { recursive: true, force: true }); }
});
