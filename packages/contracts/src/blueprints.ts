import type { ExpectedBlock, Position } from './index';

export const BLUEPRINTS = {
  cabin: { title: '작은 나무집', width: 5, depth: 5, height: 4 },
  house: { title: '넓은 나무집', width: 7, depth: 7, height: 4 },
  warehouse: { title: '창고 건물', width: 7, depth: 5, height: 4 },
  tower: { title: '전망대', width: 5, depth: 5, height: 7 },
  bridge: { title: '짧은 다리', width: 3, depth: 9, height: 1 },
  castle: { title: '성곽과 네 개의 탑', width: 15, depth: 15, height: 8 },
} as const;
export type BlueprintName = keyof typeof BLUEPRINTS;

export function blueprint(design: string, origin: Position, wood = 'oak'): ExpectedBlock[] {
  if (!(design in BLUEPRINTS)) throw new Error('지원하는 설계도를 선택해 주세요.');
  if (!/^[a-z_]+$/.test(wood)) throw new Error('목재 종류가 올바르지 않습니다.');
  const name = design as BlueprintName;
  const d = BLUEPRINTS[name];
  const cells = new Map<string, ExpectedBlock>();
  const add = (x: number, y: number, z: number, block: string) => {
    const position = { x: Math.floor(origin.x) + x, y: Math.floor(origin.y) + y, z: Math.floor(origin.z) + z };
    cells.set(`${position.x},${position.y},${position.z}`, { position, name: block });
  };
  const plank = `${wood}_planks`;
  if (name === 'bridge') {
    for (let x = 0; x < d.width; x++) for (let z = 0; z < d.depth; z++) {
      add(x, 0, z, plank);
      if (x === 0 || x === d.width - 1) add(x, 1, z, `${wood}_fence`);
    }
  } else if (name === 'castle') {
    for (let x = 0; x < 15; x++) for (let z = 0; z < 15; z++) add(x, 0, z, 'cobblestone');
    for (let y = 1; y <= 3; y++) for (let k = 0; k < 15; k++) {
      for (const [x, z] of [[k, 0], [k, 14], [0, k], [14, k]]) {
        if (z === 0 && x === 7 && y <= 2) continue;
        add(x, y, z, 'stone_bricks');
      }
    }
    for (let k = 0; k < 15; k += 2) for (const [x, z] of [[k, 0], [k, 14], [0, k], [14, k]]) add(x, 4, z, 'stone_bricks');
    for (const [ox, oz] of [[0, 0], [11, 0], [0, 11], [11, 11]]) {
      for (let y = 1; y <= 6; y++) for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
        if (x === 0 || x === 3 || z === 0 || z === 3 || y === 6) add(ox + x, y, oz + z, 'stone_bricks');
      }
      for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) if ((x + z) % 2 === 0 && (x === 0 || x === 3 || z === 0 || z === 3)) add(ox + x, 7, oz + z, 'stone_bricks');
      for (let y = 1; y <= 6; y++) add(ox + 1, y, oz + 1, 'ladder');
    }
    for (let y = 1; y <= 4; y++) for (let x = 5; x <= 9; x++) for (let z = 5; z <= 10; z++) {
      if (x === 5 || x === 9 || z === 5 || z === 10 || y === 4) {
        if (z === 5 && x === 7 && y <= 2) continue;
        add(x, y, z, y === 2 && (x === 5 || x === 9) && z === 7 ? 'glass_pane' : 'stone_bricks');
      }
    }
    for (const z of [0, 5]) { add(7, 1, z, `${wood}_door`); add(7, 2, z, `${wood}_door`); }
    add(6, 1, 6, 'chest'); add(8, 1, 6, 'crafting_table'); add(6, 1, 9, 'furnace');
    add(7, 1, 9, 'white_bed'); add(8, 1, 9, 'white_bed');
  } else {
    const mid = Math.floor(d.width / 2);
    for (let y = 0; y <= d.height; y++) for (let x = 0; x < d.width; x++) for (let z = 0; z < d.depth; z++) {
      const edge = x === 0 || z === 0 || x === d.width - 1 || z === d.depth - 1;
      if (!(y === 0 || y === d.height || edge)) continue;
      if (z === 0 && x === mid && (y === 1 || y === 2)) continue;
      if (name === 'tower' && x === 1 && z === 1 && y === d.height) continue;
      const window = y === 2 && ((x === 0 || x === d.width - 1) && z === Math.floor(d.depth / 2) || x === mid && z === d.depth - 1);
      add(x, y, z, window ? 'glass_pane' : y === 0 ? 'cobblestone' : plank);
    }
    add(mid, 1, 0, `${wood}_door`); add(mid, 2, 0, `${wood}_door`);
    if (name === 'tower') {
      for (let y = 1; y <= d.height; y++) add(1, y, 1, 'ladder');
    } else {
      add(1, 1, 1, 'chest'); add(d.width - 2, 1, 1, 'crafting_table');
      if (name === 'warehouse') {
        add(1, 1, d.depth - 2, 'chest'); add(d.width - 2, 1, d.depth - 2, 'chest');
      } else {
        add(1, 1, d.depth - 2, 'furnace');
        add(d.width - 3, 1, d.depth - 2, 'white_bed'); add(d.width - 2, 1, d.depth - 2, 'white_bed');
      }
      add(1, 2, 1, 'wall_torch'); add(d.width - 2, 2, d.depth - 2, 'wall_torch');
    }
  }
  return [...cells.values()];
}

export function materialRequirements(blocks: readonly ExpectedBlock[]): Record<string, number> {
  const items: Record<string, number> = {};
  for (const b of blocks) {
    const item = b.name === 'wall_torch' ? 'torch' : b.name;
    items[item] = (items[item] ?? 0) + 1;
  }
  for (const [item, count] of Object.entries(items)) if (item.endsWith('_door') || item.endsWith('_bed')) items[item] = Math.ceil(count / 2);
  return items;
}
