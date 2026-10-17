import type { Position, Rules } from "../../contracts/src";

/** Quarrying is separate from walking, construction and deliberate landscaping. */
export function protectedVillageCollection(
  rules: Rules,
  world: string,
  dimension: string,
  p: Position,
): boolean {
  const base = rules.baseShelter;
  if (
    !base ||
    base.world !== world ||
    base.dimension !== dimension ||
    rules.world !== world ||
    rules.dimension !== dimension
  )
    return false;
  const xs = base.blocks.map((b) => b.position.x),
    zs = base.blocks.map((b) => b.position.z);
  const farm = rules.baseAutonomy?.positions;
  if (
    farm?.length &&
    p.x >= Math.min(...farm.map((q) => q.x)) - 4 &&
    p.x <= Math.max(...farm.map((q) => q.x)) + 4 &&
    p.z >= Math.min(...farm.map((q) => q.z)) - 4 &&
    p.z <= Math.max(...farm.map((q) => q.z)) + 4
  )
    return true;
  // Retain the yard, its slopes and underground support, not just wall blocks.
  return (
    p.x >= Math.min(...xs) - 24 &&
    p.x <= Math.max(...xs) + 24 &&
    p.z >= Math.min(...zs) - 24 &&
    p.z <= Math.max(...zs) + 24
  );
}

/** A passable installed fixture is never permission to remove it for a utility. */
export function utilityVegetation(name: string): boolean {
  return [
    "short_grass",
    "tall_grass",
    "fern",
    "large_fern",
    "leaf_litter",
    "short_dry_grass",
    "tall_dry_grass",
  ].includes(name);
}
