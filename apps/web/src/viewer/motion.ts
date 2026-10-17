import type { ViewerPosition } from "../../../../packages/minecraft/src/viewer-protocol";

/** Smooth only observed positions. Never extrapolate past a received target. */
export function smoothObservedPosition(
  display: ViewerPosition,
  target: ViewerPosition,
  elapsedMs: number,
): boolean {
  const distanceSquared =
    (target.x - display.x) ** 2 +
    (target.y - display.y) ** 2 +
    (target.z - display.z) ** 2;
  // Teleports and respawn jumps should not fly through intervening terrain.
  if (distanceSquared >= 16 ** 2) {
    Object.assign(display, target);
    return false;
  }
  const alpha = 1 - Math.exp(-Math.max(0, Math.min(100, elapsedMs)) / 70);
  let moving = false;
  for (const axis of ["x", "y", "z"] as const) {
    const delta = target[axis] - display[axis];
    if (Math.abs(delta) <= 0.002) {
      display[axis] = target[axis];
      continue;
    }
    display[axis] += delta * alpha;
    if (Math.abs(target[axis] - display[axis]) <= 0.002)
      display[axis] = target[axis];
    else moving = true;
  }
  return moving;
}
