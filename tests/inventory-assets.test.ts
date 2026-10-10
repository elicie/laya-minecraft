import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { createCanvas, loadImage } from 'canvas';
import { buildInventoryAtlas } from '../scripts/inventory-atlas';
import { getItemIcon, itemIconStyle, type InventoryIconManifest } from '../apps/web/src/lib/item-icons';

const assets = resolve('apps/web/public');
const manifestPath = resolve('apps/web/src/lib/inventory-atlas.json');
const fixture = async () => ({ manifest: JSON.parse(await readFile(manifestPath, 'utf8')) as InventoryIconManifest, image: await loadImage(resolve(assets, 'inventory-atlas.png')) });

test('every manifest coordinate is a complete tile inside the standalone atlas', async () => {
  const { manifest, image } = await fixture();
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.minecraftVersion, '1.21.1');
  assert.equal(image.width, manifest.width); assert.equal(image.height, manifest.height);
  assert.equal(Object.keys(manifest.items).length, 1333);
  for (const icon of [...Object.values(manifest.items), manifest.fallback]) {
    assert.ok(Number.isInteger(icon.x) && Number.isInteger(icon.y));
    assert.equal(icon.x % manifest.tileSize, 0); assert.equal(icon.y % manifest.tileSize, 0);
    assert.ok(icon.x >= 0 && icon.y >= 0 && icon.x + manifest.tileSize <= image.width && icon.y + manifest.tileSize <= image.height);
    assert.ok(['item', 'block', 'fallback'].includes(icon.kind)); assert.ok(icon.label.length > 0);
  }
});

test('real inventory materials, tools, food and entity-rendered objects have visible original texture icons', async () => {
  const { manifest, image } = await fixture(), canvas = createCanvas(32, 32), ctx = canvas.getContext('2d');
  for (const [name, kind] of Object.entries({ dirt: 'block', oak_planks: 'block', oak_log: 'block', crafting_table: 'block', furnace: 'block', wooden_pickaxe: 'item', rotten_flesh: 'item', bread: 'item', chest: 'block', trapped_chest: 'block', ender_chest: 'block', shield: 'item', white_bed: 'block', red_bed: 'block' })) {
    const icon = manifest.items[name]!; assert.equal(icon.kind, kind, name); assert.notDeepEqual({ x: icon.x, y: icon.y }, { x: manifest.fallback.x, y: manifest.fallback.y }, name);
    ctx.clearRect(0, 0, 32, 32); ctx.drawImage(image, icon.x, icon.y, 32, 32, 0, 0, 32, 32);
    const pixels = ctx.getImageData(0, 0, 32, 32).data, alpha = [...pixels].filter((_, index) => index % 4 === 3 && pixels[index]! > 0);
    assert.ok(alpha.length > 40 && alpha.length < 1024, `${name} must be a visible transparent icon`);
  }
  assert.notDeepEqual(manifest.items.white_bed, manifest.items.red_bed);
});

test('flat tools and food preserve the public sprite pixels without invented textures', async () => {
  const { manifest, image } = await fixture(), textureRoot = resolve(dirname(require.resolve('prismarine-viewer/package.json')), 'public/textures/1.21.1/items');
  for (const name of ['wooden_pickaxe', 'rotten_flesh', 'bread']) {
    const icon = manifest.items[name]!, actual = createCanvas(32, 32), expected = createCanvas(32, 32), source = await loadImage(resolve(textureRoot, `${name}.png`));
    actual.getContext('2d').drawImage(image, icon.x, icon.y, 32, 32, 0, 0, 32, 32);
    const ctx = expected.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(source, 0, 0, source.width, Math.min(source.width, source.height), 2, 2, 28, 28);
    assert.deepEqual(actual.toBuffer('raw'), expected.toBuffer('raw'), name);
  }
});

test('state aliases and identical pixels share atlas tiles while retaining item identity', async () => {
  const { manifest } = await fixture();
  for (const [original, alias] of [['copper_block', 'waxed_copper_block'], ['stone', 'infested_stone']]) {
    const left = manifest.items[original!]!, right = manifest.items[alias!]!;
    assert.equal(left.kind, 'block'); assert.equal(right.kind, 'block');
    assert.deepEqual({ x: left.x, y: left.y }, { x: right.x, y: right.y }); assert.notEqual(left.label, right.label);
  }
  const rendered = Object.values(manifest.items).filter(item => item.kind !== 'fallback');
  assert.ok(new Set(rendered.map(item => `${item.x}:${item.y}`)).size < rendered.length);
});

test('unknown names, unsupported special models and prototype properties use an honest local fallback', () => {
  for (const name of ['future_26_item', '__proto__', 'constructor', 'player_head', 'white_banner']) {
    const icon = getItemIcon(name); assert.equal(icon.kind, 'fallback'); assert.equal(icon.src, '/inventory-atlas.png');
    if (name === 'future_26_item' || name === '__proto__' || name === 'constructor') assert.equal(icon.label, name);
  }
  assert.equal(getItemIcon(null).kind, 'fallback'); assert.equal(getItemIcon(undefined).kind, 'fallback');
  const icon = getItemIcon('dirt'), style = itemIconStyle('dirt', 16);
  assert.equal(style.width, 16); assert.equal(style.height, 16); assert.equal(style.backgroundImage, 'url(/inventory-atlas.png)');
  assert.equal(style.backgroundSize, `${icon.atlasWidth / 2}px ${icon.atlasHeight / 2}px`); assert.equal(style.backgroundPosition, `${-icon.x / 2}px ${-icon.y / 2}px`);
});

test('the checked-in atlas and manifest reproduce from the installed public assets', async () => {
  const { png, manifest } = await buildInventoryAtlas();
  assert.deepEqual(png, await readFile(resolve(assets, 'inventory-atlas.png')));
  assert.equal(`${JSON.stringify(manifest, null, 2)}\n`, await readFile(manifestPath, 'utf8'));
  const duplicate = await buildInventoryAtlas({ items: [{ name: 'dirt', displayName: 'Dirt' }, { name: 'dirt', displayName: 'Dirt' }, { name: 'future_26_item', displayName: 'Unknown future item' }] });
  assert.deepEqual(Object.keys(duplicate.manifest.items), ['dirt', 'future_26_item']); assert.equal(duplicate.manifest.items.future_26_item!.kind, 'fallback');
});
