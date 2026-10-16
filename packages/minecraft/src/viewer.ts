import { EventEmitter } from 'node:events';
import type { Bot, BotEvents } from 'mineflayer';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import chunkLoader from 'prismarine-chunk';
import { Vec3 } from 'vec3';
import { get } from 'node:http';

interface Column { toJson(): string; getBlockStateId(p: Vec3): number; getBiome(p: Vec3): number; setBlockStateId(p: Vec3, id: number): void; setBiome(p: Vec3, id: number): void; }
interface Palette { type: string; value?: number; palette?: number[]; }
interface Section { data: string; noSizePrefix?: boolean; hasFluidCount?: boolean; fluidCount?: number; }
interface SerializedColumn { sections: string[]; biomes: string[]; minY: number; }
interface ViewerApi { supportedVersions: string[]; mineflayer(bot: unknown, options: { port: number; prefix: string; firstPerson: boolean; viewDistance: number }): void; }
const viewerApi = require('prismarine-viewer') as ViewerApi;

export function createRenderAdapter(bot: Bot, targetVersion = viewerApi.supportedVersions.at(-1)!) {
  const sourceData = minecraftData(bot.version), targetData = minecraftData(targetVersion);
  const SourceBlock = blockLoader(bot.version), TargetBlock = blockLoader(targetVersion);
  const TargetChunk = chunkLoader(targetVersion) as unknown as { fromJson(json: string): Column };
  const states = new Map<number, number>(), biomes = new Map<number, number>();
  const cache = new Map<string, { source: Column; converted: Column }>();
  const listeners: Array<[keyof BotEvents, (...args: unknown[]) => void]> = [];
  const stateId = (id: number): number => {
    const cached = states.get(id); if (cached !== undefined) return cached;
    const source = SourceBlock.fromStateId(id, 0);
    const target = targetData.blocksByName[source.name];
    let mapped = target?.defaultState ?? (source.boundingBox === 'empty' ? targetData.blocksByName.air.defaultState : targetData.blocksByName.stone.defaultState);
    if (target) {
      const names = new Set(target.states?.map((s) => s.name));
      const properties = Object.fromEntries(Object.entries(source.getProperties()).filter(([name]) => names.has(name)).map(([name, value]) => [name, typeof value === 'boolean' ? String(value) : value]));
      try { mapped = TargetBlock.fromProperties(target.name, properties, 0).stateId; } catch { /* keep valid target default */ }
    }
    states.set(id, mapped); return mapped;
  };
  const biomeId = (id: number): number => {
    const cached = biomes.get(id); if (cached !== undefined) return cached;
    const mapped = targetData.biomesByName[sourceData.biomes[id]?.name]?.id ?? targetData.biomesByName.plains.id;
    biomes.set(id, mapped); return mapped;
  };
  function palette(json: string, map: (value: number) => number) {
    const data = JSON.parse(json) as Palette;
    if (data.type === 'single' && data.value !== undefined) data.value = map(data.value);
    else if (data.type === 'indirect' && data.palette) data.palette = data.palette.map(map);
    return { json: JSON.stringify(data), direct: data.type === 'direct' };
  }
  function convertColumn(column: Column): Column {
    const data = JSON.parse(column.toJson()) as SerializedColumn;
    const directSections: number[] = [], directBiomes: number[] = [];
    data.sections = data.sections.map((json, index) => {
      const section = JSON.parse(json) as Section;
      const converted = palette(section.data, stateId);
      section.data = converted.json; section.noSizePrefix = false; section.hasFluidCount = false; section.fluidCount = 0;
      if (converted.direct) directSections.push(index);
      return JSON.stringify(section);
    });
    data.biomes = data.biomes.map((json, index) => { const converted = palette(json, biomeId); if (converted.direct) directBiomes.push(index); return converted.json; });
    const converted = TargetChunk.fromJson(JSON.stringify(data));
    for (const section of directSections) for (let n = 0; n < 4096; n++) {
      const p = new Vec3(n & 15, data.minY + section * 16 + (n >> 8), (n >> 4) & 15);
      converted.setBlockStateId(p, stateId(column.getBlockStateId(p)));
    }
    for (const section of directBiomes) for (let y = 0; y < 16; y += 4) for (let z = 0; z < 16; z += 4) for (let x = 0; x < 16; x += 4) {
      const p = new Vec3(x, data.minY + section * 16 + y, z); converted.setBiome(p, biomeId(column.getBiome(p)));
    }
    return converted;
  }
  const key = (p: Vec3) => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`;
  class RenderAdapter extends EventEmitter {
    version = targetVersion;
    username = bot.username;
    viewer?: { close(): void };
    get entity() { return bot.entity; }
    get entities() { return bot.entities; }
    world = {
      getColumnAt: async (p: Vec3) => {
        const column = await bot.world.getColumnAt(p) as unknown as Column | null;
        if (!column) return null;
        const k = key(p), old = cache.get(k); if (old?.source === column) return old.converted;
        const converted = convertColumn(column); cache.set(k, { source: column, converted });
        if (cache.size > 64) cache.delete(cache.keys().next().value!);
        return converted;
      },
      raycast: (...args: Parameters<Bot['world']['raycast']>) => bot.world.raycast(...args),
    };
  }
  const adapter = new RenderAdapter();
  function listen(event: keyof BotEvents, callback: (...args: unknown[]) => void) { bot.on(event, callback); listeners.push([event, callback]); }
  for (const event of ['move', 'entitySpawn', 'entityMoved', 'entityGone'] as const) listen(event, (...args) => adapter.emit(event, ...args));
  for (const event of ['chunkColumnLoad', 'chunkColumnUnload'] as const) listen(event, (p) => { cache.delete(key(p as Vec3)); adapter.emit(event, p); });
  listen('blockUpdate', (old, updated) => {
    const block = updated as { stateId: number; position: Vec3 } | null;
    if (!block) return;
    const id = stateId(block.stateId), p = block.position;
    cache.get(key(p))?.converted.setBlockStateId(new Vec3(p.x & 15, p.y, p.z & 15), id);
    adapter.emit('blockUpdate', old, { position: p, stateId: id });
  });
  return { adapter, stateId, convertColumn, dispose: () => { for (const [event, callback] of listeners) bot.removeListener(event, callback); cache.clear(); adapter.removeAllListeners(); } };
}

export async function createBotViewer(bot: Bot, options: { port: number; prefix: string }) {
  const render = createRenderAdapter(bot);
  try {
    viewerApi.mineflayer(render.adapter, { ...options, firstPerson: true, viewDistance: 4 });
    await new Promise<void>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${options.port}${options.prefix}/`, (response) => { response.resume(); response.statusCode === 200 ? resolve() : reject(new Error('화면 서버가 준비되지 않았습니다.')); });
      request.setTimeout(3000, () => request.destroy(new Error('화면 서버 연결 시간이 초과됐습니다.')));
      request.on('error', reject);
    });
  } catch (error) { render.adapter.viewer?.close(); render.dispose(); throw error; }
  return { version: render.adapter.version, close: () => { render.adapter.viewer?.close(); render.dispose(); } };
}
