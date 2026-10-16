import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

test('Mineflayer matches the original published source integrity manifest', () => {
  const manifest = JSON.parse(readFileSync('integrity/mineflayer-4.39.0.json', 'utf8')) as {
    version: string; files: Record<string, string>;
  };
  const root = join(process.cwd(), 'node_modules', 'mineflayer');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  assert.equal(pkg.version, manifest.version);
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), expected, path);
  }
});
