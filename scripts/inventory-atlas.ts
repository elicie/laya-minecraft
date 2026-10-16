import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage, type Canvas, type Image } from 'canvas';
import minecraftData from 'minecraft-data';
import type { InventoryIconManifest, ItemIconEntry } from '../apps/web/src/lib/item-icons.types';

const VERSION = '1.21.1', TILE = 32, COLUMNS = 32;
type V3 = [number, number, number];
type FaceName = 'up' | 'down' | 'east' | 'west' | 'north' | 'south';
interface Face { texture: string; uv?: [number, number, number, number]; rotation?: number; tintindex?: number; }
interface Element { from: V3; to: V3; rotation?: { origin: V3; axis: 'x' | 'y' | 'z'; angle: number; rescale?: boolean }; shade?: boolean; faces: Partial<Record<FaceName, Face>>; }
interface Model { parent?: string; textures?: Record<string, string>; elements?: Element[]; }
interface ItemTexture { name: string; model: string; texture: string | null; }
interface ItemDefinition { name: string; displayName: string; }
interface ResolvedModel { textures: Record<string, string>; elements: Element[]; cross: boolean; }
interface BlockState { variants?: Record<string, { model: string } | { model: string }[]>; multipart?: { apply: { model: string } | { model: string }[]; when?: unknown }[]; }
const FACE_NORMAL: Record<FaceName, V3> = { up: [0, 1, 0], down: [0, -1, 0], east: [1, 0, 0], west: [-1, 0, 0], north: [0, 0, -1], south: [0, 0, 1] };
const modelKey = (name: string) => name.replace(/^minecraft:/, '').replace(/^(?:blocks?|items?)\//, '');
const textureKey = (name: string) => name.replace(/^minecraft:/, '').replace(/^block\//, 'blocks/').replace(/^item\//, 'items/');

function rotate(point: V3, rotation: Element['rotation'], vector = false): V3 {
  if (!rotation) return point;
  const origin: V3 = vector ? [0, 0, 0] : rotation.origin, angle = rotation.angle * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const [x, y, z] = point.map((n, i) => n - origin[i]!) as V3;
  let result: V3 = rotation.axis === 'x' ? [x, y * cos - z * sin, y * sin + z * cos] : rotation.axis === 'y' ? [x * cos + z * sin, y, -x * sin + z * cos] : [x * cos - y * sin, x * sin + y * cos, z];
  if (rotation.rescale && !vector) { const factor = 1 / Math.abs(cos); result = result.map((n, i) => i === 'xyz'.indexOf(rotation.axis) ? n : n * factor) as V3; }
  return result.map((n, i) => n + origin[i]!) as V3;
}
function corners(element: Element, face: FaceName): V3[] {
  const [x0, y0, z0] = element.from, [x1, y1, z1] = element.to;
  const values: Record<FaceName, V3[]> = {
    up: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
    down: [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]],
    south: [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]],
    north: [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]],
    east: [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]],
    west: [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]],
  };
  return values[face].map(p => rotate(p, element.rotation));
}
function defaultUv(element: Element, face: FaceName): [number, number, number, number] {
  const [x0, y0, z0] = element.from, [x1, y1, z1] = element.to;
  return face === 'up' || face === 'down' ? [x0, z0, x1, z1] : face === 'east' || face === 'west' ? [z0, 16 - y1, z1, 16 - y0] : [x0, 16 - y1, x1, 16 - y0];
}
const project = ([x, y, z]: V3) => ({ x: (x - z) * Math.sqrt(3) / 2, y: (x + z) / 2 - y });

export async function buildInventoryAtlas(options: { textureRoot?: string; items?: readonly ItemDefinition[] } = {}): Promise<{ png: Buffer; manifest: InventoryIconManifest }> {
  const viewerPackage = require.resolve('prismarine-viewer/package.json');
  const root = options.textureRoot ?? resolve(dirname(viewerPackage), 'public/textures', VERSION);
  const models = JSON.parse(await readFile(resolve(root, 'blocks_models.json'), 'utf8')) as Record<string, Model>;
  const states = JSON.parse(await readFile(resolve(root, 'blocks_states.json'), 'utf8')) as Record<string, BlockState>;
  const textures = JSON.parse(await readFile(resolve(root, 'items_textures.json'), 'utf8')) as ItemTexture[];
  const itemTextures = new Map(textures.map(item => [item.name, item]));
  const definitions = [...new Map((options.items ?? minecraftData(VERSION).itemsArray).map(item => [item.name, item])).values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const imageCache = new Map<string, Promise<Image | undefined>>(), modelCache = new Map<string, ResolvedModel | undefined>();
  const readTexture = (value: string) => {
    const key = textureKey(value);
    if (!/^(?:blocks|items|entity)\/[a-z0-9_/]+$/.test(key)) return Promise.resolve(undefined);
    if (!imageCache.has(key)) imageCache.set(key, loadImage(resolve(root, `${key}.png`)).catch(() => undefined));
    return imageCache.get(key)!;
  };
  const model = (name: string, seen = new Set<string>()): ResolvedModel | undefined => {
    const key = modelKey(name); if (modelCache.has(key)) return modelCache.get(key);
    if (seen.has(key) || seen.size > 32 || !models[key]) return;
    seen.add(key); const own = models[key]!, parent = own.parent ? model(own.parent, seen) : undefined;
    const result: ResolvedModel = { textures: { ...parent?.textures, ...own.textures }, elements: own.elements ?? parent?.elements ?? [], cross: key === 'cross' || !!parent?.cross };
    modelCache.set(key, result); return result;
  };
  const resolveTexture = (value: string, refs: Record<string, string>) => {
    const visited = new Set<string>();
    while (value.startsWith('#')) { if (visited.has(value) || visited.size > 32) return; visited.add(value); value = refs[value.slice(1)] ?? ''; }
    return value || undefined;
  };
  const stateModel = (name: string): ResolvedModel | undefined => {
    const state = states[name], candidate = state?.variants ? Object.values(state.variants)[0] : state?.multipart?.find(part => !part.when)?.apply;
    const selected = Array.isArray(candidate) ? candidate[0] : candidate;
    return selected ? model(selected.model) : undefined;
  };
  const sprites: Canvas[] = [];
  const missing = createCanvas(TILE, TILE), missingContext = missing.getContext('2d');
  // Own pixel glyph: no unrecognized item is assigned a fabricated texture.
  missingContext.fillStyle = '#9ca3af'; missingContext.fillRect(10, 7, 12, 3); missingContext.fillRect(19, 10, 3, 6); missingContext.fillRect(13, 15, 9, 3); missingContext.fillRect(13, 18, 3, 3); missingContext.fillRect(13, 24, 3, 3);
  sprites.push(missing);
  const pixelHash = (canvas: Canvas) => createHash('sha256').update(canvas.toBuffer('raw')).digest('hex');
  const uniqueSprites = new Map([[pixelHash(missing), 0]]);
  const entries = new Map<string, { index: number; kind: ItemIconEntry['kind'] }>();
  const drawSprite = async (source: string) => {
    const image = await readTexture(source); if (!image) return;
    const canvas = createCanvas(TILE, TILE), ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    const frameHeight = Math.min(image.width, image.height);
    ctx.drawImage(image, 0, 0, image.width, frameHeight, 2, 2, 28, 28);
    return canvas;
  };
  const drawBlock = async (name: string, resolved: ResolvedModel) => {
    type Polygon = { points: V3[]; texture: string; uv: [number, number, number, number]; tint?: string; shade: number; rotation: number };
    const polygons: Polygon[] = [];
    for (const element of resolved.elements) for (const [side, face] of Object.entries(element.faces) as [FaceName, Face][]) {
      const normal = rotate(FACE_NORMAL[side], element.rotation, true);
      if (normal[0] + normal[1] + normal[2] <= 1e-6) continue;
      const texture = resolveTexture(face.texture, resolved.textures); if (!texture || !await readTexture(texture)) return;
      const tint = face.tintindex !== undefined ? name === 'birch_leaves' ? '#80a755' : name === 'spruce_leaves' ? '#619961' : name.endsWith('_leaves') ? '#48b518' : '#91bd59' : undefined;
      polygons.push({ points: corners(element, side), texture, uv: face.uv ?? defaultUv(element, side), tint, shade: element.shade === false ? 1 : normal[1] > 0.5 ? 1 : normal[0] > 0.5 ? 0.65 : 0.8, rotation: face.rotation ?? 0 });
    }
    if (!polygons.length) return;
    const canvas = createCanvas(TILE, TILE), ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    const points = polygons.flatMap(p => p.points.map(project)), minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    const scale = Math.min(0.9, 28 / Math.max(maxX - minX, maxY - minY));
    polygons.sort((a, b) => a.points.reduce((sum, p) => sum + p[0] + p[1] + p[2], 0) - b.points.reduce((sum, p) => sum + p[0] + p[1] + p[2], 0));
    for (const polygon of polygons) {
      const image = (await readTexture(polygon.texture))!;
      const tile = createCanvas(16, 16), face = tile.getContext('2d'); face.imageSmoothingEnabled = false;
      const [u0, v0, u1, v1] = polygon.uv, w = Math.abs(u1 - u0), h = Math.abs(v1 - v0); if (!w || !h) continue;
      face.save(); face.translate(8, 8); face.rotate(polygon.rotation * Math.PI / 180); face.scale(u1 < u0 ? -1 : 1, v1 < v0 ? -1 : 1);
      face.drawImage(image, Math.min(u0, u1) / 16 * image.width, Math.min(v0, v1) / 16 * Math.min(image.height, image.width), w / 16 * image.width, h / 16 * Math.min(image.height, image.width), -8, -8, 16, 16); face.restore();
      if (polygon.tint) { const alpha = createCanvas(16, 16); alpha.getContext('2d').drawImage(tile, 0, 0); face.globalCompositeOperation = 'multiply'; face.fillStyle = polygon.tint; face.fillRect(0, 0, 16, 16); face.globalCompositeOperation = 'destination-in'; face.drawImage(alpha, 0, 0); face.globalCompositeOperation = 'source-over'; }
      if (polygon.shade < 1) { face.globalCompositeOperation = 'source-atop'; face.fillStyle = `rgba(0,0,0,${1 - polygon.shade})`; face.fillRect(0, 0, 16, 16); face.globalCompositeOperation = 'source-over'; }
      const quad = polygon.points.map(p => { const q = project(p); return { x: (q.x - (minX + maxX) / 2) * scale + TILE / 2, y: (q.y - (minY + maxY) / 2) * scale + TILE / 2 }; });
      const [a, b, , d] = quad;
      ctx.save(); ctx.beginPath(); for (let i = 0; i < quad.length; i++) { const p = quad[i]!; if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); } ctx.closePath(); ctx.clip();
      ctx.transform((b!.x - a!.x) / 16, (b!.y - a!.y) / 16, (d!.x - a!.x) / 16, (d!.y - a!.y) / 16, a!.x, a!.y); ctx.drawImage(tile, 0, 0); ctx.restore();
    }
    return canvas;
  };
  // Entity-rendered inventory objects have no block JSON mesh. These own meshes
  // map their original 64px entity UV layouts; they never substitute another item.
  const entityIcon = async (name: string): Promise<{ canvas?: Canvas; kind: ItemIconEntry['kind'] } | undefined> => {
    const uv = (u0: number, v0: number, u1: number, v1: number): Face['uv'] => [u0 / 4, v0 / 4, u1 / 4, v1 / 4];
    if (name === 'shield') {
      const texture = await readTexture('entity/shield_base_nopattern'); if (!texture) return;
      const canvas = createCanvas(TILE, TILE), ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(texture, 1, 1, 12, 22, 8, 2, 16, 28);
      return { canvas, kind: 'item' };
    }
    if (['chest', 'trapped_chest', 'ender_chest'].includes(name)) {
      const texture = `entity/chest/${name === 'chest' ? 'normal' : name === 'trapped_chest' ? 'trapped' : 'ender'}`;
      const elements: Element[] = [
        { from: [1, 0, 1], to: [15, 10, 15], faces: { up: { texture, uv: uv(14, 19, 28, 33) }, south: { texture, uv: uv(14, 33, 28, 43) }, east: { texture, uv: uv(0, 33, 14, 43) } } },
        { from: [1, 10, 1], to: [15, 15, 15], faces: { up: { texture, uv: uv(14, 0, 28, 14) }, south: { texture, uv: uv(14, 14, 28, 19) }, east: { texture, uv: uv(0, 14, 14, 19) } } },
        { from: [7, 8, 15], to: [9, 12, 16], faces: { up: { texture, uv: uv(1, 0, 3, 1) }, south: { texture, uv: uv(1, 1, 3, 5) }, east: { texture, uv: uv(0, 1, 1, 5) } } },
      ];
      return { canvas: await drawBlock(name, { textures: {}, elements, cross: false }), kind: 'block' };
    }
    const color = /^([a-z_]+)_bed$/.exec(name)?.[1];
    if (color) {
      const texture = `entity/bed/${color}`, elements: Element[] = [];
      for (let half = 0; half < 2; half++) {
        const v = half * 22, z = half * 16;
        elements.push({ from: [0, 3, z], to: [16, 9, z + 16], faces: { up: { texture, uv: uv(6, 6 + v, 22, 22 + v) }, east: { texture, uv: uv(0, 6 + v, 6, 22 + v), rotation: 90 }, south: { texture, uv: uv(6, v, 22, 6 + v) } } });
      }
      for (const x of [1, 12]) for (const z of [1, 28]) elements.push({ from: [x, 0, z], to: [x + 3, 3, z + 3], faces: { up: { texture, uv: uv(50, 0, 53, 3) }, east: { texture, uv: uv(50, 3, 53, 6) }, south: { texture, uv: uv(53, 3, 56, 6) } } });
      return { canvas: await drawBlock(name, { textures: {}, elements, cross: false }), kind: 'block' };
    }
  };
  for (const item of definitions) {
    const reference = itemTextures.get(item.name), direct = await readTexture(`items/${item.name}`);
    let canvas: Canvas | undefined, kind: ItemIconEntry['kind'] = 'fallback';
    if (direct) { canvas = await drawSprite(`items/${item.name}`); kind = 'item'; }
    else {
      const special = await entityIcon(item.name);
      const resolved = model(`${item.name}_inventory`) ?? model(item.name) ?? (reference ? model(reference.model) : undefined) ?? stateModel(item.name);
      if (special?.canvas) { canvas = special.canvas; kind = special.kind; }
      else if (resolved?.elements.length && !resolved.cross) { canvas = await drawBlock(item.name, resolved); kind = 'block'; }
      else if (resolved?.cross && reference?.texture) { canvas = await drawSprite(reference.texture); kind = 'item'; }
      // Flat inventory models without block geometry still have an explicit sprite.
      else if (reference?.texture && /^(?:minecraft:)?items?\//.test(reference.texture)) { canvas = await drawSprite(reference.texture); kind = 'item'; }
    }
    if (!canvas) { entries.set(item.name, { index: 0, kind: 'fallback' }); continue; }
    const hash = pixelHash(canvas); let index = uniqueSprites.get(hash);
    if (index === undefined) { index = sprites.length; uniqueSprites.set(hash, index); sprites.push(canvas); }
    entries.set(item.name, { index, kind });
  }
  const width = COLUMNS * TILE, height = Math.ceil(sprites.length / COLUMNS) * TILE, atlas = createCanvas(width, height), ctx = atlas.getContext('2d'); ctx.imageSmoothingEnabled = false;
  const coordinate = (index: number) => ({ x: index % COLUMNS * TILE, y: Math.floor(index / COLUMNS) * TILE });
  sprites.forEach((sprite, index) => { const p = coordinate(index); ctx.drawImage(sprite, p.x, p.y); });
  const manifest: InventoryIconManifest = { schemaVersion: 1, minecraftVersion: VERSION, source: 'prismarine-viewer/public/textures/1.21.1', sourcePackageVersion: JSON.parse(await readFile(viewerPackage, 'utf8')).version, tileSize: TILE, width, height,
    fallback: { ...coordinate(0), kind: 'fallback', label: 'Unknown item' }, items: Object.fromEntries(definitions.map(item => { const entry = entries.get(item.name) ?? { index: 0, kind: 'fallback' as const }; return [item.name, { ...coordinate(entry.index), kind: entry.kind, label: item.displayName }]; })) };
  return { png: atlas.toBuffer('image/png'), manifest };
}

export async function generateInventoryAssets(outputRoot = resolve('apps/web/public'), manifestRoot = resolve('apps/web/src/lib')): Promise<InventoryIconManifest> {
  const { png, manifest } = await buildInventoryAtlas(); await mkdir(outputRoot, { recursive: true }); await mkdir(manifestRoot, { recursive: true });
  await writeFile(resolve(outputRoot, 'inventory-atlas.png'), png); await writeFile(resolve(manifestRoot, 'inventory-atlas.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Inventory atlas: ${Object.keys(manifest.items).length} known names, ${Object.values(manifest.items).filter(e => e.kind !== 'fallback').length} textured icons, ${manifest.width}×${manifest.height}, ${png.length} bytes.`);
  return manifest;
}
if (require.main === module) generateInventoryAssets().catch(error => { console.error(error); process.exitCode = 1; });
