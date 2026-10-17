import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { RulesSchema, type TaskSpec } from "../packages/contracts/src";
import { blueprint } from "../packages/contracts/src/blueprints";
import { warehouseShelter } from "../packages/core/src/warehouse-shelter";
import {
  localNightTask,
  localNightGuard,
  localNightExitClear,
  verifiedWarehouseInterior,
} from "../packages/minecraft/src/night-work";
import {
  protectedVillageCollection,
  utilityVegetation,
} from "../packages/minecraft/src/village-policy";
function fixture() {
  const world = "127.0.0.1:25566",
    blocks = blueprint("warehouse", { x: 0, y: 63, z: 0 }),
    warehouse = {
      id: "w",
      world,
      dimension: "overworld",
      position: { x: 1, y: 64, z: 1 },
    },
    base = warehouseShelter(warehouse, blocks)!,
    rules = RulesSchema.parse({ world, warehouse, baseShelter: base }),
    cells = new Map(
      blocks.map((b) => [
        `${b.position.x},${b.position.y},${b.position.z}`,
        b.name,
      ]),
    );
  const raw = {
    health: 20,
    food: 20,
    entity: {
      position: new Vec3(
        base.outside.x + 0.5,
        base.outside.y,
        base.outside.z + 0.5,
      ),
    },
    entities: {} as Record<string, { name: string; position: Vec3 }>,
    inventory: { items: () => [{ name: "wooden_sword", count: 1 }] },
    blockAt(p: Vec3) {
      const q = p.floored(),
        name =
          cells.get(`${q.x},${q.y},${q.z}`) ??
          (q.y < base.outside.y ? "grass_block" : "air");
      return {
        name,
        position: q,
        boundingBox: ["air", "wall_torch", "torch"].includes(name)
          ? "empty"
          : "block",
        shapes: ["air", "wall_torch", "torch"].includes(name)
          ? []
          : [[0, 0, 0, 1, 1, 1]],
        getProperties: () => ({ open: false }),
      };
    },
  };
  const task = (
    kind: TaskSpec["kind"],
    params: TaskSpec["params"] = {},
  ): TaskSpec => ({
    id: "t",
    goalId: "g",
    kind,
    params,
    completion: { kind: "manual", reason: "policy" },
    dependencies: [],
    reservationKeys: [],
  });
  return { raw, bot: raw as unknown as Bot, rules, base, task };
}
test("night work permits bounded farming, crafting and an armed local guard, while remote resource trips stay excluded", () => {
  const f = fixture();
  assert.equal(
    localNightTask(f.bot, f.rules, f.task("craft", { item: "stone_sword" })),
    true,
  );
  assert.equal(
    localNightTask(
      f.bot,
      f.rules,
      f.task("farm", { positions: [{ x: 30, y: 62, z: 10 }] }),
    ),
    true,
  );
  assert.equal(localNightGuard(f.bot, f.rules, "guard"), true);
  assert.equal(
    localNightTask(f.bot, f.rules, f.task("collect", { item: "cobblestone" })),
    false,
  );
  assert.equal(
    localNightTask(
      f.bot,
      f.rules,
      f.task("guard", { position: { x: 200, y: 64, z: 0 } }),
    ),
    false,
  );
  f.raw.health = 17;
  assert.equal(localNightTask(f.bot, f.rules, f.task("craft")), false);
  f.raw.health = 20;
  f.raw.food = 17;
  assert.equal(localNightGuard(f.bot, f.rules, "guard"), false);
});
test("nearby enemies stop outdoor work and exit, while a verified closed building still permits indoor crafting", () => {
  const f = fixture();
  f.raw.entities.z = {
    name: "zombie",
    position: f.raw.entity.position.offset(15, 0, 0),
  };
  assert.equal(localNightGuard(f.bot, f.rules, "guard"), false);
  f.raw.entity.position = new Vec3(
    f.base.inside.x + 0.5,
    f.base.inside.y,
    f.base.inside.z + 0.5,
  );
  assert.equal(verifiedWarehouseInterior(f.bot, f.rules), true);
  assert.equal(localNightTask(f.bot, f.rules, f.task("craft")), true);
  assert.equal(localNightExitClear(f.bot, f.rules), false);
});
test("village quarry protection includes the yard and deep supports without banning offsite collection or other worlds", () => {
  const f = fixture();
  assert.equal(
    protectedVillageCollection(f.rules, f.rules.world, "overworld", {
      x: 15,
      y: 20,
      z: 0,
    }),
    true,
  );
  assert.equal(
    protectedVillageCollection(f.rules, f.rules.world, "overworld", {
      x: 80,
      y: 64,
      z: 0,
    }),
    false,
  );
  assert.equal(
    protectedVillageCollection(f.rules, "another-world", "overworld", {
      x: 0,
      y: 64,
      z: 0,
    }),
    false,
  );
  assert.equal(utilityVegetation("short_grass"), true);
  for (const name of [
    "torch",
    "wall_torch",
    "crafting_table",
    "wheat",
    "oak_planks",
  ])
    assert.equal(utilityVegetation(name), false, name);
});
