import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMesh,
  decodeVoxels,
  sectionId,
  type MeshSection,
} from "../apps/web/src/viewer/mesh";
import type { ViewerMaterial } from "../packages/minecraft/src/viewer-protocol";
const air: ViewerMaterial = {
  stateId: 0,
  name: "air",
  shape: "empty",
  opaque: false,
  transparent: true,
  color: 0,
};
const stone: ViewerMaterial = {
  stateId: 1,
  name: "stone",
  shape: "cube",
  opaque: true,
  transparent: false,
  color: 0xffffff,
  faces: Object.fromEntries(
    ["up", "down", "north", "south", "east", "west"].map((face) => [
      face,
      { u: 0.1, v: 0.2, su: 0.05, sv: 0.05 },
    ]),
  ),
};
function section(x = 0): MeshSection {
  return {
    id: sectionId(x, 0, 0),
    revision: 1,
    origin: { x, y: 0, z: 0 },
    palette: [air, stone],
    voxels: new Uint16Array(4096),
  };
}
test("compact voxel decode preserves little-endian palette indexes and rejects absent cells", () => {
  const bytes = Buffer.alloc(8192);
  bytes.writeUInt16LE(258, 7 * 2);
  assert.equal(decodeVoxels(bytes.toString("base64"))[7], 258);
  assert.throws(() => decodeVoxels(Buffer.alloc(8191).toString("base64")));
  assert.equal(sectionId(-1, -17, 16), "-1,-2,1");
});
test("mesher culls only actual opaque neighbours including negative section boundaries", () => {
  const a = section(-16),
    b = section(0);
  a.voxels[15] = 1;
  b.voxels[0] = 1;
  const world = new Map([
    [a.id, a],
    [b.id, b],
  ]);
  assert.equal(buildMesh(a, world).opaque.length, 30);
  assert.equal(buildMesh(b, world).opaque.length, 30);
  world.delete(b.id);
  const result = buildMesh(a, world);
  assert.equal(result.opaque.length, 36);
  // Indexed winding points outwards, not inside the blocks.
  for (let face = 0; face < 6; face++) {
    const k = face * 12,
      p = result.positions,
      n = result.normals;
    const ax = p[k + 3]! - p[k]!,
      ay = p[k + 4]! - p[k + 1]!,
      az = p[k + 5]! - p[k + 2]!;
    const bx = p[k + 6]! - p[k]!,
      by = p[k + 7]! - p[k + 1]!,
      bz = p[k + 8]! - p[k + 2]!;
    assert.ok(
      (ay * bz - az * by) * n[k]! +
        (az * bx - ax * bz) * n[k + 1]! +
        (ax * by - ay * bx) * n[k + 2]! >
        0,
    );
  }
});
test("solid sections avoid internal faces; actual boxes, texture UV and untextured fallback remain visible", () => {
  const a = section();
  a.voxels.fill(1);
  let result = buildMesh(a, new Map([[a.id, a]]));
  assert.equal(result.opaque.length, 6 * 16 * 16 * 6);
  a.voxels.fill(0);
  a.voxels[0] = 1;
  a.palette[1] = { ...stone, shape: "boxes", boxes: [[0, 0.5, 0, 1, 1, 1]] };
  result = buildMesh(a, new Map([[a.id, a]]));
  const ys = result.positions.filter((_, i) => i % 3 === 1);
  assert.equal(Math.min(...ys), 0.5);
  assert.equal(Math.max(...ys), 1);
  assert.ok(Math.abs(result.uvs[0]! - 0.1) < 1e-6);
  a.palette[1] = { ...stone, faces: undefined, fallback: true };
  result = buildMesh(a, new Map([[a.id, a]]));
  assert.equal(result.untextured.length, 36);
  assert.equal(result.opaque.length, 0);
  assert.equal(result.fallbackBlocks, 1);
});
test("observed cross vegetation is double sided and translucent water uses a separate group", () => {
  const a = section();
  a.voxels[0] = 1;
  a.palette[1] = {
    ...stone,
    name: "short_grass",
    shape: "cross",
    opaque: false,
  };
  let result = buildMesh(a, new Map([[a.id, a]]));
  assert.equal(result.opaque.length, 24);
  a.palette[1] = { ...stone, name: "water", transparent: true, opaque: false };
  result = buildMesh(a, new Map([[a.id, a]]));
  assert.equal(result.transparent.length, 36);
  assert.equal(result.opaque.length, 0);
});
