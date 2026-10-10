import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import { BLUEPRINT_TEMPLATES, BUILD_MATERIALS, BlueprintDefinitionSchema, BlueprintInputSchema, WOOD_TYPES, WINDOW_MATERIALS, blueprint, blueprintPreset, materialRequirements, previewBlueprint, resolveBlueprint } from '../packages/contracts/src';

test('builtin oak and birch blueprints keep their exact previous ordered block placement', () => {
  const golden = {
    cabin: ['8df4ccbfdc5460ff1d4d761219aa9a8f63f6f85fdf5b298ad8fae9b4964bd7ff', 'cabb4585e231f9ff3409a22472a03bd84be83ac5b640ecaaf7ac56153047b1b1'],
    house: ['501ad93dfbbfd678606dd9225e33ab6d5be91c078633020cd15acec2ccd678de', '35998598fd42f13056d996ca4eba1d5a36bf105bfb7e60c6baf6ec10d8b613d8'],
    warehouse: ['1cdc9495aa51ed9d449ac5b657ef0b455a02ea85fd7219366aa11a8defe37250', '29bc35ee418a51dad27ee11cfc3653dfe548aa8612b6372eb4e567d9f03f19b8'],
    tower: ['7f15b659ade5c5c3dc97317580f0de43ffc0951470d888fe2ec2eb67d29ea284', 'e49df2ead60d4ce3de9d41545d18ba2e176469b2a216fff840760e08159ab5e6'],
    bridge: ['3bf50cfc3c806d2b9689dcc2df54e007c07f85719ab6201c8d7742b9fc774ce1', '1ca8b840ef183aa6e02c59b29c4fa17f0e0fddd43ba294b852787eec2213eb61'],
    castle: ['2db40f6cf48025ad17edccb7d68e77b3d6d4f7bd709a7fb183d427a2d89a4de1', '12c2884232439d33f6bfdafff37af8bc1c6c1cf6b174ac752c170b22d1f8c441'],
  };
  for (const template of BLUEPRINT_TEMPLATES) for (const [i, wood] of ['oak', 'birch'].entries()) assert.equal(createHash('sha256').update(JSON.stringify(blueprint(template, { x: -4, y: 70, z: -8 }, wood))).digest('hex'), golden[template][i]);
});

test('an unedited clone retains the original template placement, including tower access and warehouse chests', () => {
  for (const template of BLUEPRINT_TEMPLATES) assert.deepEqual(previewBlueprint(blueprintPreset(template), { x: 0, y: 64, z: 0 }), blueprint(template, { x: 0, y: 64, z: 0 }));
  for (const template of ['tower', 'warehouse'] as const) {
    const input = blueprintPreset(template); input.furniture = { chest: true, craftingTable: true, furnace: true, bed: true, lighting: true }; const blocks = previewBlueprint(input);
    const actual = (x: number, y: number, z: number) => blocks.find(b => b.position.x === x && b.position.y === y && b.position.z === z)?.name;
    if (template === 'tower') { assert.equal(actual(1, 1, 1), 'ladder'); assert.equal(actual(1, input.height, 1), 'ladder'); assert.equal(actual(1, 1, 2), 'chest'); }
    else { assert.equal(actual(1, 1, input.depth - 2), 'chest'); assert.equal(actual(input.width - 2, 1, input.depth - 2), 'chest'); }
    assert.equal(blocks.filter(b => b.name === 'white_bed').length, 2); assert.equal(blocks.filter(b => b.name === 'furnace').length, 1);
  }
});

test('edited template sizes and supported material choices produce valid bounded unique Minecraft cells', () => {
  const data = minecraftData('1.21.1'), origin = { x: -10, y: 64, z: -20 };
  for (const template of BLUEPRINT_TEMPLATES) {
    const input = blueprintPreset(template);
    if (template === 'tower') { input.width = 7; input.depth = 7; input.height = 16; }
    else if (template === 'bridge') { input.width = 5; input.depth = 17; }
    else if (template !== 'castle') { input.width = 6; input.depth = 8; input.height = 3; }
    input.wood = 'birch'; input.materials.floor = 'polished_andesite'; input.materials.wall = 'stone_bricks'; input.materials.roof = 'birch_planks'; input.materials.window = 'glass';
    const blocks = previewBlueprint(BlueprintInputSchema.parse(input), origin);
    assert.equal(new Set(blocks.map(b => `${b.position.x},${b.position.y},${b.position.z}`)).size, blocks.length);
    for (const b of blocks) { assert.ok(data.blocksByName[b.name], b.name); assert.ok(b.position.x >= origin.x && b.position.x < origin.x + input.width && b.position.z >= origin.z && b.position.z < origin.z + input.depth && b.position.y >= origin.y && b.position.y <= origin.y + input.height); }
    assert.equal(blocks.filter(b => b.position.y === origin.y && b.name === 'polished_andesite').length, input.width * input.depth);
  }
  for (const material of [...BUILD_MATERIALS, ...WINDOW_MATERIALS]) assert.ok(data.blocksByName[material]);
  for (const wood of WOOD_TYPES) for (const suffix of ['planks', 'door', 'fence']) assert.ok(data.blocksByName[`${wood}_${suffix}`]);
});

test('furniture switches remove only requested fixtures and beds still charge one actual item', () => {
  const input = blueprintPreset('cabin'), enabled = previewBlueprint(input);
  const none = previewBlueprint({ ...input, furniture: { chest: false, craftingTable: false, furnace: false, bed: false, lighting: false } });
  assert.equal(none.filter(b => ['chest', 'crafting_table', 'furnace', 'white_bed', 'wall_torch'].includes(b.name)).length, 0);
  assert.equal(materialRequirements(enabled).white_bed, 1); assert.equal(materialRequirements(enabled).oak_door, 1); assert.equal(none.filter(b => b.name === 'oak_door').length, 2);
  for (const field of Object.keys(input.furniture) as (keyof typeof input.furniture)[]) {
    const one = previewBlueprint({ ...input, furniture: { chest: false, craftingTable: false, furnace: false, bed: false, lighting: false, [field]: true } });
    assert.ok(one.length > none.length); assert.ok(one.filter(b => b.name === 'oak_door').length === 2);
  }
});

test('malformed, unsupported and unsafe editor inputs are rejected before saving', () => {
  const input = blueprintPreset('cabin');
  for (const patch of [{ width: 4 }, { width: 32 }, { height: 2 }, { height: 5 }, { depth: 4.5 }, { title: ' ' }, { wood: 'unknown' }, { blocks: [] }, { materials: { ...input.materials, floor: 'sand' } }, { materials: { ...input.materials, roof: 'tnt' } }, { furniture: { ...input.furniture, command: true } }]) assert.equal(BlueprintInputSchema.safeParse({ ...input, ...patch }).success, false);
  assert.equal(BlueprintInputSchema.safeParse({ ...blueprintPreset('bridge'), width: 4 }).success, false);
  assert.equal(BlueprintInputSchema.safeParse({ ...blueprintPreset('bridge'), furniture: input.furniture }).success, false);
  assert.equal(BlueprintInputSchema.safeParse({ ...blueprintPreset('castle'), width: 17 }).success, false);
  assert.equal(BlueprintInputSchema.safeParse({ ...blueprintPreset('tower'), width: 31, depth: 31, height: 16 }).success, false, 'proof cannot exceed the observed block budget');
});

test('custom design resolution needs a matching full definition and never overrides a builtin', () => {
  const definition = { ...blueprintPreset('warehouse'), id: randomUUID(), version: 1, createdAt: 100, updatedAt: 100 };
  assert.equal(resolveBlueprint(definition.id, definition).width, 7); assert.equal(resolveBlueprint(definition.id, definition).definition?.version, 1);
  assert.deepEqual(blueprint(definition.id, { x: 0, y: 0, z: 0 }, 'oak', definition), previewBlueprint(definition));
  assert.throws(() => resolveBlueprint(definition.id)); assert.throws(() => resolveBlueprint(randomUUID(), definition)); assert.throws(() => resolveBlueprint('warehouse', definition)); assert.throws(() => blueprint(definition.id, { x: NaN, y: 0, z: 0 }, 'oak', definition));
  assert.equal(BlueprintDefinitionSchema.safeParse({ ...definition, version: 0 }).success, false); assert.equal(BlueprintDefinitionSchema.safeParse({ ...definition, updatedAt: 99 }).success, false);
});
