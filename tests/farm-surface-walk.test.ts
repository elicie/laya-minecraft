import test from "node:test";
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { RulesSchema, type Position } from "../packages/contracts/src";
import { farmSurfaceWalk } from "../packages/minecraft/src/farm-surface-walk";
import {
  ConditionWait,
  type ActionServices,
} from "../packages/minecraft/src/services";

function fixture() {
  const plots = [
      { x: 1, y: 62, z: 0 },
      { x: 2, y: 62, z: 0 },
      { x: 2, y: 62, z: 1 },
    ],
    controls: Record<string, boolean> = {},
    changes: { name: string; value: boolean }[] = [];
  let aim = new Vec3(1.5, 64.5, 0.5),
    unknown = false;
  const onPlot = (p: Position) =>
    plots.some((q) => q.x === Math.floor(p.x) && q.z === Math.floor(p.z));
  const bot = {
    entity: { position: new Vec3(1.5, 62.9375, 0.5), onGround: true },
    entities: {},
    pathfinder: { setGoal() {} },
    clearControlStates() {
      for (const k of Object.keys(controls)) delete controls[k];
    },
    setControlState(name: string, value: boolean) {
      controls[name] = value;
      changes.push({ name, value });
    },
    async lookAt(p: Vec3) {
      aim = p;
    },
    blockAt(p: Position) {
      const y = Math.floor(p.y),
        crop = onPlot(p);
      if (unknown && crop && Math.floor(p.x) === 2) return null;
      const name =
        y < 62
          ? "dirt"
          : y === 62
            ? crop
              ? "farmland"
              : "dirt"
            : y === 63 && crop
              ? "wheat"
              : "air";
      return {
        name,
        boundingBox: name === "wheat" || name === "air" ? "empty" : "block",
        shapes:
          name === "air" || name === "wheat"
            ? []
            : [[0, 0, 0, 1, name === "farmland" ? 0.9375 : 1, 1]],
      };
    },
  } as unknown as Bot;
  const s = {
    bot,
    rules: RulesSchema.parse({}),
    checkpoint: {},
    signal: new AbortController().signal,
    observations: [],
    evidence: [],
    check() {},
    async pause() {
      if (controls.forward) {
        const p = bot.entity.position,
          d = Math.hypot(aim.x - p.x, aim.z - p.z),
          step = Math.min(0.15, d);
        p.x += ((aim.x - p.x) / d) * step;
        p.z += ((aim.z - p.z) / d) * step;
        p.y = onPlot(p) ? 62.9375 : 63;
      }
    },
  } as unknown as ActionServices;
  return {
    s,
    bot,
    plots,
    changes,
    controls,
    setUnknown() {
      unknown = true;
    },
  };
}

test("dense registered crops use cardinal walking without jumping, sprinting or world changes", async () => {
  const f = fixture();
  assert.equal(
    await farmSurfaceWalk(f.s, { x: 2, y: 63, z: 1 }, f.plots, async () =>
      assert.fail("direct crop route needs no dry-bank travel"),
    ),
    true,
  );
  assert.ok(
    f.bot.entity.position.distanceTo(new Vec3(2.5, 62.9375, 1.5)) < 0.15,
  );
  assert.ok(f.changes.some((c) => c.name === "forward" && c.value));
  assert.ok(
    f.changes.every((c) => !["jump", "sprint"].includes(c.name) || !c.value),
  );
  assert.deepEqual(f.controls, {});
  assert.equal((f.s.checkpoint.farmSurfaceWalk as any).jumped, false);
});

for (const defect of ["unknown", "threat", "height"] as const)
  test(`crop walking stops for ${defect} and clears controls`, async () => {
    const f = fixture();
    if (defect === "unknown") f.setUnknown();
    if (defect === "height") f.bot.entity.position.y = 63.8;
    if (defect === "threat")
      f.bot.entities[1] = {
        name: "zombie",
        position: new Vec3(2, 63, 1),
      } as any;
    await assert.rejects(
      farmSurfaceWalk(f.s, { x: 2, y: 63, z: 1 }, f.plots, async () => {}),
      ConditionWait,
    );
    assert.deepEqual(f.controls, {});
  });

test("a dry-route completion on an elevated bank cannot start a flat crop route", async () => {
  const f = fixture();
  f.bot.entity.position = new Vec3(0.5, 64, 0.5);
  await assert.rejects(
    farmSurfaceWalk(f.s, { x: 2, y: 63, z: 1 }, f.plots, async () => {}),
    ConditionWait,
  );
  assert.equal(f.changes.length, 0);
  assert.deepEqual(f.controls, {});
});

test("unregistered destinations outside the farm use the existing route planner", async () => {
  const f = fixture();
  f.bot.entity.position = new Vec3(-2.5, 63, 0.5);
  assert.equal(
    await farmSurfaceWalk(f.s, { x: -3, y: 63, z: 0 }, f.plots, async () =>
      assert.fail(),
    ),
    false,
  );
  assert.equal(f.changes.length, 0);
});
