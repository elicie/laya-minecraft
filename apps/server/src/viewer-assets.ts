import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';

export interface ViewerAssets {
  readonly basePath: string;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  redirect(req: IncomingMessage, res: ServerResponse, relativePath: string): boolean;
}
export interface ViewerAssetsOptions { publicRoot?: string; maxCompressedCacheBytes?: number; }
const types: Record<string, string> = { '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const staticPath = (name: string): boolean => name === 'index.js' || name === 'worker.js' || name === 'index.js.LICENSE.txt' || /^blocksStates\/\d+(?:\.\d+){1,2}\.json$/.test(name) || /^textures\/\d+(?:\.\d+){1,2}(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.\/-]*)?\.png$/.test(name);
function safeName(value: string): string | undefined {
  let decoded: string; try { decoded = decodeURIComponent(value); } catch { return; }
  if (decoded.includes('\\') || decoded.includes('%') || decoded.includes('\0') || decoded.startsWith('/') || decoded.split('/').some(part => !part || part === '.' || part === '..')) return;
  return staticPath(decoded) ? decoded : undefined;
}
function acceptsGzip(req: IncomingMessage): boolean {
  const values = (req.headers['accept-encoding'] ?? '').toLowerCase().split(',').map(value => {
    const [name, ...params] = value.trim().split(';'), quality = params.find(part => part.trim().startsWith('q='));
    return { name, quality: quality === undefined ? 1 : Number(quality.trim().slice(2)) };
  });
  const found = values.find(value => value.name === 'gzip') ?? values.find(value => value.name === '*');
  return !!found && Number.isFinite(found.quality) && found.quality > 0;
}
function failure(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-length': '0', 'x-content-type-options': 'nosniff' }); res.end();
}

/** Original distribution bytes are read, never modified, rebuilt or monkey-patched. */
export async function createViewerAssets(options: ViewerAssetsOptions = {}): Promise<ViewerAssets> {
  // Defer CommonJS resolution so Vite can provide its own explicit ESM root.
  const root = await realpath(options.publicRoot ?? join(dirname(require.resolve('prismarine-viewer/package.json')), 'public'));
  const files = new Set<string>();
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name), name = relative(root, file).split(sep).join('/');
      if (entry.isDirectory()) { if (name === 'textures' || name.startsWith('textures/') || name === 'blocksStates') await scan(file); }
      else if (entry.isFile() && safeName(name)) files.add(name);
      if (files.size > 50000) throw new Error('Viewer static manifest exceeds its bounded file limit');
    }
  }
  await scan(root);
  const hash = createHash('sha256');
  hash.update('laya-viewer-assets-v1\0');
  try { hash.update(await readFile(join(root, '..', 'package.json'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const name of ['index.js', 'worker.js']) if (!files.has(name)) throw new Error(`Viewer distribution is missing ${name}`);
  // Hash every served byte, including same-named PNG/JSON updates. Bound
  // parallel reads and stream large bundles rather than retaining raw copies.
  const manifest = [...files].sort(), digests = new Array<string>(manifest.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, manifest.length) }, async () => {
    for (;;) {
      const index = next++; if (index >= manifest.length) return;
      const name = manifest[index]!, content = createHash('sha256');
      if (['.js', '.json'].includes(extname(name))) for await (const chunk of createReadStream(join(root, name))) content.update(chunk);
      else content.update(await readFile(join(root, name)));
      digests[index] = content.digest('hex');
    }
  }));
  manifest.forEach((name, index) => hash.update(`${name}\0${digests[index]}\n`));
  const basePath = `/viewer-assets/${hash.digest('hex')}`;
  const compressed = new Map<string, Promise<Buffer>>(), sizes = new Map<string, number>();
  const cacheLimit = options.maxCompressedCacheBytes ?? 16 * 1024 * 1024;
  async function gzip(file: string, name: string): Promise<Buffer> {
    const cached = compressed.get(name); if (cached) return cached;
    const promise = new Promise<Buffer>((resolveBuffer, reject) => {
      const source = createReadStream(file), zip = createGzip(), chunks: Buffer[] = [];
      source.on('error', error => { zip.destroy(); reject(error); });
      zip.on('error', error => { source.destroy(); reject(error); });
      zip.on('data', (chunk: Buffer) => chunks.push(chunk));
      zip.on('end', () => resolveBuffer(Buffer.concat(chunks))); source.pipe(zip);
    });
    compressed.set(name, promise);
    try {
      const value = await promise; sizes.set(name, value.length);
      let total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
      for (const [key, size] of sizes) { if (total <= cacheLimit) break; compressed.delete(key); sizes.delete(key); total -= size; }
      return value;
    } catch (error) { compressed.delete(name); throw error; }
  }
  const asset = async (name: string) => {
    const file = await realpath(resolve(root, name));
    if (!file.startsWith(`${root}${sep}`)) throw new Error('Viewer asset escapes the distribution');
    const info = await stat(file);
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('Viewer asset size is invalid');
    const etag = `W/"${createHash('sha256').update(`${basePath}/${name}:${info.size}:${info.mtimeMs}`).digest('hex')}"`;
    return { file, info, etag };
  };
  return {
    basePath,
    async handle(req, res) {
      const path = (req.url ?? '').split('?')[0]!;
      if (!path.startsWith('/viewer-assets/')) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') { failure(res, 405); return true; }
      if (!path.startsWith(`${basePath}/`)) { failure(res, 404); return true; }
      const name = safeName(path.slice(basePath.length + 1));
      if (!name || !files.has(name)) { failure(res, 404); return true; }
      try {
        const { file, info, etag } = await asset(name), compressible = ['.js', '.json', '.txt'].includes(extname(name));
        const headers = { 'content-type': types[extname(name)]!, 'cache-control': 'public, max-age=31536000, immutable', etag, 'last-modified': info.mtime.toUTCString(), 'x-content-type-options': 'nosniff', ...(compressible ? { vary: 'Accept-Encoding' } : {}) };
        const ifNoneMatch = req.headers['if-none-match'];
        const modifiedSince = req.headers['if-modified-since'];
        const matches = typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
        const unchanged = ifNoneMatch === undefined && typeof modifiedSince === 'string' && Number.isFinite(Date.parse(modifiedSince)) && Math.floor(info.mtimeMs / 1000) <= Math.floor(Date.parse(modifiedSince) / 1000);
        if (matches || unchanged) { res.writeHead(304, headers); res.end(); return true; }
        const zipped = compressible && acceptsGzip(req) ? await gzip(file, name) : undefined;
        if (res.destroyed || res.writableEnded) return true;
        res.writeHead(200, { ...headers, 'content-length': zipped?.length ?? info.size, ...(zipped ? { 'content-encoding': 'gzip' } : {}) });
        if (req.method === 'HEAD') res.end();
        else if (zipped) res.end(zipped);
        else {
          const source = createReadStream(file); source.on('error', () => res.destroy());
          res.on('close', () => { if (!res.writableEnded) source.destroy(); }); source.pipe(res);
        }
      } catch { if (!res.headersSent) failure(res, 404); else res.destroy(); }
      return true;
    },
    redirect(req, res, relativePath) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      const name = safeName(relativePath); if (!name || !files.has(name)) return false;
      res.writeHead(307, { location: `${basePath}/${name}`, 'cache-control': 'no-store', 'content-length': '0' }); res.end(); return true;
    },
  };
}

export function viewerHtml(assetBase: string): string {
  if (!/^\/viewer-assets\/[a-f0-9]{64}\/?$/.test(assetBase)) throw new Error('Invalid shared viewer asset base');
  const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Laya Minecraft 3D</title><base href="${base}"><style>html{overflow:hidden}html,body{height:100%;margin:0;padding:0}canvas{height:100%;width:100%;font-size:0;margin:0;padding:0}</style></head><body><script src="index.js"></script></body></html>`;
}
