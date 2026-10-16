import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preparationProofPositions, validateBuildSitePreparation,
  type BuildSitePreparation, type ExpectedBlock, type Position,
} from '../packages/contracts/src';

const key = (p: Position) => `${p.x},${p.y},${p.z}`;
function fixture(overrides: Partial<BuildSitePreparation> = {}) {
  const plan: BuildSitePreparation = {
    design: 'warehouse', origin: { x: 10, y: 4, z: 10 }, entrance: { x: 13, y: 4, z: 9 },
    near: { x: 10.5, y: 4, z: 9.5 }, observedAt: 1000,
    path: [10, 11, 12, 13].map(x => ({ x, y: 4, z: 9 })),
    edits: [
      { position: { x: 12, y: 4, z: 12 }, before: 'grass_block', after: 'air' },
      { position: { x: 14, y: 3, z: 12 }, before: 'air', after: 'dirt' },
    ],
    ...overrides,
  };
  const blocks = new Map<string, ExpectedBlock>(preparationProofPositions(plan).map(position =>
    [key(position), { position, name: position.y < plan.origin.y ? 'dirt' : 'air' }]));
  const set = (position: Position, name: string) => blocks.set(key(position), { position, name });
  for (const p of plan.path) { set(p, 'air'); set({ ...p, y: p.y + 1 }, 'air'); set({ ...p, y: p.y - 1 }, 'dirt'); }
  for (const edit of plan.edits) set(edit.position, edit.before);
  return { plan, blocks, set, validate: (allowCompletedEdits = false) =>
    validateBuildSitePreparation(plan, [...blocks.values()], { allowCompletedEdits }) };
}

test('a supported cut-and-fill warehouse plan keeps the whole foundation and an actual connected exit', () => {
  const f = fixture(), result = f.validate();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.proofPositions.some(p => p.x === 14 && p.y === 0 && p.z === 12));
    assert.ok(result.cells.some(c => c.requirement === 'ground' && c.position.x === 9 && c.position.z === 9));
  }
});

test('terrain preparation refuses to undermine facilities, crops, fluids and falling blocks', () => {
  for (const name of ['chest', 'crafting_table', 'furnace', 'oak_planks', 'oak_log', 'farmland', 'wheat', 'water', 'lava', 'sand', 'gravel']) {
    const f = fixture(); f.set({ x: 11, y: 4, z: 12 }, name);
    assert.equal(f.validate().ok, false, name);
  }
});

test('ordinary meadow grass and ferns can be cleared without treating crops as vacant terrain', () => {
  for (const name of ['short_grass', 'tall_grass', 'fern', 'large_fern']) {
    const f = fixture(); f.plan.edits[0]!.before = name; f.set(f.plan.edits[0]!.position, name);
    assert.equal(f.validate().ok, true, name);
  }
  for (const name of ['wheat', 'carrots', 'potatoes', 'beetroots']) {
    const f = fixture(); f.plan.edits[0]!.before = name; f.set(f.plan.edits[0]!.position, name);
    assert.equal(f.validate().ok, false, name);
  }
});

test('a meadow plant in a shallow depression can be removed before filling, including an interrupted air intermediate', () => {
  for (const name of ['short_grass', 'tall_grass', 'fern', 'large_fern']) {
    const f = fixture(), edit = f.plan.edits[1]!;
    edit.before = name; f.set(edit.position, name);
    assert.equal(f.validate().ok, true, name);
    f.set(edit.position, 'air');
    assert.equal(f.validate().ok, false, 'a proposal needs the actual before state');
    assert.equal(f.validate(true).ok, true, 'resumption preserves the confirmed removal and still needs to fill');
    f.set(edit.position, 'dirt'); assert.equal(f.validate(true).ok, true);
  }
  for (const name of ['wheat', 'carrots', 'potatoes', 'beetroots', 'farmland', 'oak_log', 'chest']) {
    const f = fixture(), edit = f.plan.edits[1]!;
    edit.before = name; f.set(edit.position, name);
    assert.equal(f.validate().ok, false, name);
  }
});

test('fill preserves neighboring facilities too, even when no adjacent block would be dug', () => {
  const f = fixture(); f.set({ x: 15, y: 3, z: 12 }, 'chest');
  assert.equal(f.validate().ok, false);
});

test('a ground patch cannot cover a cave, liquid or unloaded foundation', () => {
  for (const name of ['air', 'water', 'lava', 'gravel']) {
    const f = fixture(); f.set({ x: 14, y: 2, z: 12 }, name);
    assert.equal(f.validate().ok, false, name);
  }
  const f = fixture(); f.blocks.delete(key({ x: 14, y: 0, z: 12 }));
  assert.equal(f.validate().ok, false, 'unobserved deep support must not be assumed');
});

test('up to three fill layers need observed solid support below every filled column', () => {
  const f = fixture();
  for (const y of [1, 2]) {
    const position = { x: 14, y, z: 12 };
    f.plan.edits.push({ position, before: 'air', after: 'dirt' }); f.set(position, 'air');
  }
  assert.equal(f.validate().ok, true);
  f.set({ x: 14, y: 0, z: 12 }, 'air');
  assert.equal(f.validate().ok, false);
});

test('a changed block rejects the plan, while an exact completed edit may be resumed', () => {
  const f = fixture(); f.set(f.plan.edits[0]!.position, 'air');
  assert.equal(f.validate().ok, false);
  assert.equal(f.validate(true).ok, true);
  f.set(f.plan.edits[1]!.position, 'chest');
  assert.equal(f.validate(true).ok, false);
});

test('natural grass regrowth on newly filled dirt remains valid completed ground', () => {
  const f = fixture();
  f.set(f.plan.edits[0]!.position, 'air'); f.set(f.plan.edits[1]!.position, 'grass_block');
  assert.equal(f.validate(true).ok, true);
  f.set(f.plan.edits[1]!.position, 'farmland');
  assert.equal(f.validate(true).ok, false, 'an external land-use change must remain protected');
});

test('bot body, head and its original standing support cannot be terrain edits', () => {
  for (const y of [4, 5]) {
    const f = fixture(), position = { x: 10, y, z: 9 };
    f.plan.edits.push({ position, before: 'dirt', after: 'air' }); f.set(position, 'dirt');
    assert.equal(f.validate().ok, false);
  }
  const f = fixture(), position = { x: 10, y: 3, z: 9 };
  f.plan.edits.push({ position, before: 'air', after: 'dirt' }); f.set(position, 'air');
  assert.equal(f.validate().ok, false);
});

test('route preparation may clear an escape step below the final elevated plot', () => {
  const f = fixture({
    origin: { x: 10, y: 6, z: 10 }, entrance: { x: 13, y: 6, z: 9 }, near: { x: 10.5, y: 4, z: 7.5 },
    path: [{ x: 10, y: 4, z: 7 }, { x: 11, y: 4, z: 7 }, { x: 12, y: 5, z: 7 }, { x: 13, y: 6, z: 7 }, { x: 13, y: 6, z: 8 }, { x: 13, y: 6, z: 9 }],
    edits: [{ position: { x: 11, y: 4, z: 7 }, before: 'dirt', after: 'air' }],
  });
  assert.equal(f.validate().ok, true);
});

test('an otherwise connected 65-step detour cannot take editing outside the 32-block search area', () => {
  const f = fixture({
    origin: { x: 11, y: 4, z: 9 }, entrance: { x: 14, y: 4, z: 8 },
    path: [
      ...Array.from({ length: 34 }, (_, i) => ({ x: 10 + i, y: 4, z: 9 })),
      { x: 43, y: 4, z: 8 },
      ...Array.from({ length: 29 }, (_, i) => ({ x: 42 - i, y: 4, z: 8 })),
    ],
  });
  assert.ok(f.plan.path.length <= 65);
  assert.equal(f.validate().ok, false);
});

test('duplicate edits, out-of-area edits and excessive excavation are rejected', () => {
  const duplicate = fixture(); duplicate.plan.edits.push({ ...duplicate.plan.edits[0]! });
  assert.equal(duplicate.validate().ok, false);
  const outside = fixture(); outside.plan.edits.push({ position: { x: 100, y: 4, z: 100 }, before: 'dirt', after: 'air' });
  assert.equal(outside.validate().ok, false);
  const deep = fixture(), position = { x: 12, y: 7, z: 12 };
  deep.plan.edits.push({ position, before: 'stone', after: 'air' }); deep.set(position, 'stone');
  assert.equal(deep.validate().ok, false);
  const excessive = fixture(); excessive.plan.edits = Array.from({ length: 193 }, () => excessive.plan.edits[0]!);
  assert.equal(excessive.validate().ok, false);
});
