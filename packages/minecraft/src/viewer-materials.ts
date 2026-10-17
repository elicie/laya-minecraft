import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import blockLoader from 'prismarine-block';
import type { ViewerFace, ViewerMaterial, ViewerUv } from './viewer-protocol';

const faces: ViewerFace[] = ['east', 'west', 'up', 'down', 'south', 'north'];
const assets = join(dirname(require.resolve('prismarine-viewer')), 'public');
const atlasCache = new Map<string, Promise<{ version?: string; path?: string; definitions: Record<string, unknown> }>>();
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const first = (value: unknown): unknown => Array.isArray(value) ? value[0] : value;
async function atlas(version: string, root: string) {
  for (const candidate of [...new Set([version, '1.21.4'])]) {
    if (!/^\d+(?:\.\d+){1,2}$/.test(candidate)) continue;
    const image = join(root, 'textures', `${candidate}.png`), definitions = join(root, 'blocksStates', `${candidate}.json`);
    try { await access(image); return { version: candidate, path: image, definitions: JSON.parse(await readFile(definitions, 'utf8')) as Record<string, unknown> }; }
    catch { /* Missing version assets retain explicit color/shape fallback. */ }
  }
  return { definitions: {} as Record<string, unknown> };
}
function model(value: unknown, properties: Record<string, string | number | boolean>): { data?: Record<string, unknown>; fallback: boolean } {
  const entry = record(value), variants = record(entry?.variants);
  if (variants) {
    const selected = Object.entries(variants).filter(([condition]) => !condition || condition.split(',').every(term => { const [name, expected] = term.split('='); return String(properties[name!]) === expected; })).sort(([a], [b]) => b.length - a.length)[0];
    const variant = record(first(selected?.[1]));
    return { data: record(variant?.model), fallback: !selected || !!variant?.x || !!variant?.y };
  }
  if (Array.isArray(entry?.multipart)) {
    const selected = entry.multipart.map(record).find(part => part && matches(part.when, properties));
    return { data: record(record(first(selected?.apply))?.model), fallback: true };
  }
  return { fallback: true };
}
function matches(condition: unknown, properties: Record<string, string | number | boolean>): boolean {
  const terms = record(condition);
  if (!terms) return condition === undefined;
  return Object.entries(terms).every(([key, value]) => {
    if (key === 'OR') return Array.isArray(value) && value.some(term => matches(term, properties));
    if (key === 'AND') return Array.isArray(value) && value.every(term => matches(term, properties));
    return typeof value === 'string' && value.split('|').includes(String(properties[key]));
  });
}
function visualBoxes(elements: unknown[]): number[][] | undefined {
  if (!elements.length || elements.length > 8) return;
  const boxes: number[][] = [];
  for (const item of elements) {
    const element = record(item);
    if (element?.rotation || !Array.isArray(element?.from) || !Array.isArray(element?.to)) return;
    const bounds = [...element.from, ...element.to];
    if (bounds.length !== 6 || !bounds.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 16)) return;
    if (![0, 1, 2].every(i => bounds[i] < bounds[i + 3])) return;
    boxes.push(bounds.map(n => n / 16));
  }
  return boxes;
}
function uv(value: unknown): ViewerUv | undefined {
  const object = record(value);
  if (!object || !['u', 'v', 'su', 'sv'].every(key => typeof object[key] === 'number' && Number.isFinite(object[key]))) return undefined;
  return { u: object.u as number, v: object.v as number, su: object.su as number, sv: object.sv as number };
}
function color(name: string): number {
  if (name.includes('water')) return 0x6da5e1;
  if (name.includes('lava') || name.includes('fire')) return 0xff932e;
  if (name.includes('leaves') || name === 'grass_block' || /grass|fern|vine|crop|wheat|carrot|potato/.test(name)) return 0x9acb73;
  if (/dirt|mud|farmland/.test(name)) return 0x9c7852;
  if (/log|planks|wood/.test(name)) return 0xc5a375;
  if (/sand/.test(name)) return 0xe6d79e;
  if (/snow|quartz/.test(name)) return 0xe4edf1;
  return 0xb4b6b2;
}

/** Actual source state IDs/properties stay intact; atlas lookup is only by name. */
export async function createViewerMaterials(version: string, options: { assetsRoot?: string } = {}) {
  const root = options.assetsRoot ?? assets, key = `${root}\0${version}`;
  let loaded = atlasCache.get(key);
  if (!loaded) {
    loaded = atlas(version, root); atlasCache.set(key, loaded);
    if (atlasCache.size > 8) atlasCache.delete(atlasCache.keys().next().value!);
  }
  const texture = await loaded, Block = blockLoader(version), cache = new Map<number, ViewerMaterial>();
  function material(stateId: number): ViewerMaterial {
    const saved = cache.get(stateId); if (saved) return saved;
    const block = Block.fromStateId(stateId, 0), name = block.name ?? 'unknown', properties = block.getProperties() as Record<string, string | number | boolean>;
    const empty = ['air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void'].includes(name);
    const selected = model(texture.definitions[name], properties), textures = record(selected.data?.textures), elements = Array.isArray(selected.data?.elements) ? selected.data.elements : [];
    let boxes = block.shapes.filter(box => box.length === 6 && box.every(n => Number.isFinite(n) && n >= -1 && n <= 2)).slice(0, 8).map(box => box.map(n => Math.max(0, Math.min(1, n))));
    if (!empty && !boxes.length && !selected.fallback) boxes = visualBoxes(elements) ?? boxes;
    const cube = boxes.length === 1 && boxes[0]!.every((n, index) => n === (index < 3 ? 0 : 1));
    const fluid = name === 'water' || name === 'lava', cross = !empty && !fluid && boxes.length === 0;
    const shape: ViewerMaterial['shape'] = empty ? 'empty' : fluid ? 'slab' : cube ? 'cube' : cross ? 'cross' : 'boxes';
    const element = record(elements[0]), elementFaces = record(element?.faces), mapped: Partial<Record<ViewerFace, ViewerUv>> = {};
    for (const face of faces) { const textureUv = uv(record(elementFaces?.[face])?.texture) ?? uv(textures?.[face]) ?? uv(textures?.all) ?? uv(textures?.particle); if (textureUv) mapped[face] = textureUv; }
    const fallback = texture.version !== version || selected.fallback || !selected.data || !cube && !empty;
    const result: ViewerMaterial = { stateId, name, opaque: !empty && cube && !block.transparent, transparent: block.transparent || fluid || cross, color: Object.keys(mapped).length ? /leaves|fern|vine|wheat/.test(name) ? 0x9acb73 : name === 'water' ? 0x6da5e1 : 0xffffff : color(name), shape, properties,
      ...(!empty && !cube && !cross ? { boxes: fluid ? [[0, 0, 0, 1, 0.9, 1]] : boxes } : {}), ...(Object.keys(mapped).length ? { faces: mapped } : {}), ...(fallback ? { fallback: true } : {}) };
    cache.set(stateId, result); if (cache.size > 8192) cache.delete(cache.keys().next().value!); return result;
  }
  return { material, atlasPath: texture.path, atlasVersion: texture.version, approximate: texture.version !== version };
}
