import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentSchema,
  RulesSchema,
  type Observation,
  GoalInputSchema,
  type Goal,
} from "../packages/contracts/src";
import { blueprint } from "../packages/contracts/src/blueprints";
import { warehouseShelter } from "../packages/core/src/warehouse-shelter";
import { equipmentDevelopmentGoals } from "../packages/core/src/equipment-development";
import { planGoal } from "../packages/core/src/planning";
function fixture() {
  const now = 100000,
    world = "127.0.0.1:25566",
    warehouse = {
      id: "w",
      world,
      dimension: "overworld",
      position: { x: 1, y: 64, z: 1 },
    },
    blocks = blueprint("warehouse", { x: 0, y: 63, z: 0 }),
    rules = RulesSchema.parse({
      world,
      warehouse,
      baseShelter: warehouseShelter(warehouse, blocks),
      workstations: [
        {
          name: "crafting_table",
          world,
          dimension: "overworld",
          position: { x: 5, y: 64, z: 2 },
        },
      ],
    });
  const agent = AgentSchema.parse({
    id: "guard",
    config: { name: "GuardUnit", role: "guard" },
    session: {
      id: "s",
      state: "ready",
      lastReportAt: now,
      rulesVersion: 1,
      report: {
        ready: true,
        position: { x: 3, y: 64, z: -1 },
        world,
        dimension: "overworld",
        health: 20,
        food: 20,
        inventory: [
          { name: "wooden_sword", count: 1 },
          { name: "stick", count: 2 },
        ],
        action: "guard",
        reason: "ready",
        mode: "idle",
        capabilities: ["craft", "take", "home"],
        rulesVersion: 1,
      },
    },
    status: "ready",
    pendingCommandIds: [],
    viewer: { state: "stopped" },
    createdAt: 1,
    updatedAt: now,
  });
  const stock: Observation = {
    id: "o",
    observedAt: now,
    receivedAt: now,
    controllerEpoch: "e",
    botId: "guard",
    sessionId: "s",
    world,
    dimension: "overworld",
    kind: "container",
    data: {
      container: warehouse,
      items: [
        { name: "bread", count: 8 },
        { name: "cobblestone", count: 3 },
        { name: "oak_log", count: 4 },
      ],
    },
  };
  return { now, rules, agent, stock };
}
test("an existing wooden sword upgrades from actual surplus, using the same actor through take and craft", () => {
  const f = fixture(),
    inputs = equipmentDevelopmentGoals(
      f.rules,
      [f.agent],
      [],
      [f.stock],
      f.now,
      "e",
    );
  assert.equal(inputs.length, 1);
  const input = GoalInputSchema.parse(inputs[0]);
  assert.equal(input.item, "stone_sword");
  assert.equal(input.requiredBotId, "guard");
  assert.deepEqual(input.params.warehouseInputs, [
    { item: "cobblestone", quantity: 2 },
  ]);
  const goal: Goal = {
    id: "upgrade",
    input,
    title: "upgrade",
    state: "queued",
    taskIds: [],
    createdAt: f.now,
    updatedAt: f.now,
    progress: { current: 0 },
    generation: 0,
  };
  let i = 0;
  const plan = planGoal(goal, f.rules, () => `t${++i}`);
  assert.equal(plan.waiting, undefined);
  assert.ok(
    plan.tasks.some(
      (t) => t.kind === "take" && t.params.item === "cobblestone",
    ),
  );
  assert.ok(
    plan.tasks.some(
      (t) => t.kind === "craft" && t.params.item === "stone_sword",
    ),
  );
  assert.equal(
    plan.tasks.some((t) => t.kind === "store"),
    false,
  );
});
test("upgrades retain the food reserve, require fresh real stock and never duplicate an unfinished equipment search", () => {
  const f = fixture();
  f.stock.data.items.find((i) => i.name === "bread")!.count = 7;
  assert.deepEqual(
    equipmentDevelopmentGoals(f.rules, [f.agent], [], [f.stock], f.now, "e"),
    [],
  );
  f.stock.data.items.find((i) => i.name === "bread")!.count = 8;
  assert.deepEqual(
    equipmentDevelopmentGoals(
      f.rules,
      [f.agent],
      [],
      [f.stock],
      f.now,
      "other",
    ),
    [],
  );
  const pending = {
    id: "old",
    input: { params: { equipmentDevelopment: true } },
    state: "condition-wait",
  } as unknown as Goal;
  assert.deepEqual(
    equipmentDevelopmentGoals(
      f.rules,
      [f.agent],
      [pending],
      [f.stock],
      f.now,
      "e",
    ),
    [],
  );
});
test("iron and shields progress only when their actual ingredients exist; ore is never counted as an ingot", () => {
  const f = fixture();
  f.agent.session!.report!.inventory.push({ name: "stone_sword", count: 1 });
  f.stock.data.items.push({ name: "raw_iron", count: 64 });
  assert.deepEqual(
    equipmentDevelopmentGoals(f.rules, [f.agent], [], [f.stock], f.now, "e"),
    [],
  );
  f.stock.data.items.push({ name: "iron_ingot", count: 1 });
  const next = equipmentDevelopmentGoals(
    f.rules,
    [f.agent],
    [],
    [f.stock],
    f.now,
    "e",
  )[0]!;
  assert.equal(next.item, "shield");
  assert.deepEqual(next.params!.warehouseInputs, [
    { item: "iron_ingot", quantity: 1 },
    { item: "oak_log", quantity: 2 },
  ]);
});
