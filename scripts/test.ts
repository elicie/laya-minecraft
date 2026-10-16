import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function tests(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? tests(path) : entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const live = process.argv.includes('--live');
const filters = process.argv.slice(2).filter((arg) => arg !== '--live');
const files = tests('tests').filter((path) => {
  const isLive = path.endsWith('.live.test.ts');
  return isLive === live && (filters.length === 0 || filters.some((filter) => path.includes(filter)));
}).sort();
if (files.length === 0) {
  console.error('No matching tests.');
  process.exit(1);
}
if (live && (process.env.MC_PORT !== '25566' || (process.env.MC_HOST ?? '127.0.0.1') !== '127.0.0.1')) {
  console.error('Live fixtures require MC_HOST=127.0.0.1 and MC_PORT=25566 (minecraft-laya-validation).');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit', env: process.env,
});
process.exit(result.status ?? 1);
