import type {
  ViewerFace,
  ViewerMaterial,
  ViewerPosition,
} from "../../../../packages/minecraft/src/viewer-protocol";

export interface MeshSection {
  id: string;
  revision: number;
  origin: ViewerPosition;
  palette: ViewerMaterial[];
  voxels: Uint16Array;
}
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  opaque: Uint32Array;
  transparent: Uint32Array;
  untextured: Uint32Array;
  fallbackBlocks: number;
}
const faces: {
  name: ViewerFace;
  normal: number[];
  points: number[][];
  shade: number;
}[] = [
  {
    name: "east",
    normal: [1, 0, 0],
    points: [
      [1, 0, 1],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
    ],
    shade: 0.82,
  },
  {
    name: "west",
    normal: [-1, 0, 0],
    points: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    shade: 0.82,
  },
  {
    name: "up",
    normal: [0, 1, 0],
    points: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
    shade: 1,
  },
  {
    name: "down",
    normal: [0, -1, 0],
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    shade: 0.55,
  },
  {
    name: "south",
    normal: [0, 0, 1],
    points: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    shade: 0.72,
  },
  {
    name: "north",
    normal: [0, 0, -1],
    points: [
      [1, 0, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    shade: 0.72,
  },
];
const fullBox = [0, 0, 0, 1, 1, 1];
const full = (material: ViewerMaterial) =>
  material.shape === "cube" ||
  material.boxes?.some(
    (box) => box.length === 6 && box.every((v, i) => v === fullBox[i]),
  );
export const sectionId = (x: number, y: number, z: number) =>
  `${Math.floor(x / 16)},${Math.floor(y / 16)},${Math.floor(z / 16)}`;
export function decodeVoxels(encoded: string): Uint16Array {
  const decoded = atob(encoded);
  if (decoded.length !== 8192)
    throw new Error("지형 구역의 크기가 올바르지 않습니다.");
  const result = new Uint16Array(4096);
  for (let i = 0; i < 4096; i++)
    result[i] =
      decoded.charCodeAt(i * 2) | (decoded.charCodeAt(i * 2 + 1) << 8);
  return result;
}
export function buildMesh(
  section: MeshSection,
  sections: ReadonlyMap<string, MeshSection>,
): MeshData {
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    colors: number[] = [],
    opaque: number[] = [],
    transparent: number[] = [],
    untextured: number[] = [];
  let fallbackBlocks = 0;
  function materialAt(x: number, y: number, z: number) {
    const wx = section.origin.x + x,
      wy = section.origin.y + y,
      wz = section.origin.z + z;
    const neighbor = sections.get(sectionId(wx, wy, wz));
    if (!neighbor) return undefined;
    const index =
      wx -
      neighbor.origin.x +
      16 * (wz - neighbor.origin.z + 16 * (wy - neighbor.origin.y));
    return neighbor.palette[neighbor.voxels[index]!];
  }
  function quad(
    points: number[][],
    normal: number[],
    material: ViewerMaterial,
    name: ViewerFace,
    shade: number,
    reverse = false,
  ) {
    if (positions.length / 3 > 200_000)
      throw new Error("표시할 지형의 표면이 너무 복잡합니다.");
    const index = positions.length / 3,
      texture = material.faces?.[name];
    const tint = texture
      ? /leaves|vine|grass|fern/.test(material.name)
        ? 0x91bd59
        : 0xffffff
      : material.color;
    const rgb = [
      ((tint >> 16) & 255) / 255,
      ((tint >> 8) & 255) / 255,
      (tint & 255) / 255,
    ];
    for (let i = 0; i < 4; i++) {
      positions.push(...points[i]!);
      normals.push(...normal);
      colors.push(...rgb.map((value) => value * shade));
      const a = [0, 1, 1, 0][i]!,
        b = [1, 1, 0, 0][i]!;
      uvs.push(
        texture ? texture.u + texture.su * a : 0,
        texture ? texture.v + texture.sv * b : 0,
      );
    }
    const indices = !texture
      ? untextured
      : material.transparent && /water|lava|glass|ice/.test(material.name)
        ? transparent
        : opaque;
    indices.push(index, index + 1, index + 2, index, index + 2, index + 3);
    if (reverse)
      indices.push(index + 2, index + 1, index, index + 3, index + 2, index);
  }
  for (let y = 0; y < 16; y++)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) {
        const material =
          section.palette[section.voxels[x + 16 * (z + 16 * y)]!];
        if (!material || material.shape === "empty") continue;
        if (material.fallback) fallbackBlocks++;
        if (material.shape === "cross") {
          const textureFace = material.faces?.north
            ? "north"
            : material.faces?.up
              ? "up"
              : "east";
          quad(
            [
              [x, y, z],
              [x + 1, y, z + 1],
              [x + 1, y + 1, z + 1],
              [x, y + 1, z],
            ],
            [0.707, 0, -0.707],
            material,
            textureFace,
            0.9,
            true,
          );
          quad(
            [
              [x + 1, y, z],
              [x, y, z + 1],
              [x, y + 1, z + 1],
              [x + 1, y + 1, z],
            ],
            [-0.707, 0, -0.707],
            material,
            textureFace,
            0.9,
            true,
          );
          continue;
        }
        const boxes = material.boxes?.length
          ? material.boxes
          : material.shape === "slab"
            ? [[0, 0, 0, 1, 0.5, 1]]
            : [fullBox];
        for (const box of boxes)
          for (const face of faces) {
            const axis = face.normal.findIndex((v) => v !== 0),
              positive = face.normal[axis]! > 0;
            const boundary =
              box[axis + (positive ? 3 : 0)] === (positive ? 1 : 0);
            const neighbor = boundary
              ? materialAt(
                  x + face.normal[0]!,
                  y + face.normal[1]!,
                  z + face.normal[2]!,
                )
              : undefined;
            if (
              neighbor &&
              full(neighbor) &&
              (neighbor.opaque || neighbor.stateId === material.stateId)
            )
              continue;
            const points = face.points.map((point) =>
              point.map(
                (v, i) => [x, y, z][i]! + box[i]! + (box[i + 3]! - box[i]!) * v,
              ),
            );
            quad(points, face.normal, material, face.name, face.shade);
          }
      }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    colors: new Float32Array(colors),
    opaque: new Uint32Array(opaque),
    transparent: new Uint32Array(transparent),
    untextured: new Uint32Array(untextured),
    fallbackBlocks,
  };
}
