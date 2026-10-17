import { test } from "node:test";
import assert from "node:assert/strict";
import { smoothObservedPosition } from "../apps/web/src/viewer/motion";
test("observed entity motion is gradual, never extrapolates and settles at the exact target", () => {
  const display = { x: 0, y: 1, z: 0 },
    target = { x: 4, y: 2, z: -2 };
  assert.equal(smoothObservedPosition(display, target, 16), true);
  assert.ok(display.x > 0 && display.x < 4);
  assert.ok(display.z < 0 && display.z > -2);
  let moving = true;
  for (let frame = 0; frame < 120; frame++)
    moving = smoothObservedPosition(display, target, 1000 / 60);
  assert.deepEqual(display, target);
  assert.equal(moving, false);
  for (let frame = 0; frame < 120; frame++)
    assert.equal(smoothObservedPosition(display, { ...target }, 16), false);
});
test("large observed teleport snaps without a fake journey and new entity state is independent", () => {
  const display = { x: 0, y: 64, z: 0 },
    target = { x: 64, y: 72, z: -64 };
  assert.equal(smoothObservedPosition(display, target, 0), false);
  assert.deepEqual(display, target);
  const boundary = { x: 0, y: 0, z: 0 };
  assert.equal(
    smoothObservedPosition(boundary, { x: 16, y: 0, z: 0 }, 0),
    false,
  );
  assert.equal(boundary.x, 16);
  const replacement = { x: 1, y: 2, z: 3 };
  assert.equal(
    smoothObservedPosition(replacement, { ...replacement }, 16),
    false,
  );
  assert.deepEqual(display, target);
});
