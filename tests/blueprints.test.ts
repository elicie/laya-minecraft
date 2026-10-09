import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { BLUEPRINTS, blueprint, materialRequirements } from '../packages/contracts/src/blueprints';

test('supported blueprints have unique cells and valid Minecraft blocks and materials', () => {
  const data = minecraftData('1.21.1');
  for (const kind of Object.keys(BLUEPRINTS)) {
    const blocks = blueprint(kind, { x: 0, y: 64, z: 0 });
    assert.ok(blocks.length > 0);
    assert.equal(new Set(blocks.map((b) => `${b.position.x},${b.position.y},${b.position.z}`)).size, blocks.length);
    for (const b of blocks) assert.ok(data.blocksByName[b.name], `${kind}: ${b.name}`);
    for (const item of Object.keys(materialRequirements(blocks))) assert.ok(data.itemsByName[item], `${kind}: ${item}`);
  }
});

test('house doors and bed occupy both generated cells without charging two items', () => {
  const blocks = blueprint('cabin', { x: -4, y: 70, z: -8 });
  assert.equal(blocks.filter((b) => b.name === 'oak_door').length, 2);
  assert.equal(materialRequirements(blocks).oak_door, 1);
  assert.equal(materialRequirements(blocks).white_bed, 1);
  assert.throws(() => blueprint('arbitrary_palace', { x: 0, y: 64, z: 0 }));
});
