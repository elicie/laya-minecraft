import {
  UtilityCleanupPlanSchema,
  type Position,
  type ResultPayload,
  type TaskSpec,
} from "../../contracts/src";
import { ConditionWait, type ActionServices } from "./services";
import { HOSTILES } from "./combat-policy";
import { observedGroundStand } from "./observed-ground-walk";
import { observationBase, vector } from "./observations";

/** Explicit cleanup of temporary tables. Shared stations, building blocks and
 * every other block type remain protected; no generic terrain excavation. */
export async function cleanupUtilities(
  task: TaskSpec,
  s: ActionServices,
  protectedPosition: (p: Position) => boolean,
): Promise<ResultPayload> {
  const plan = UtilityCleanupPlanSchema.parse(task.params.cleanup),
    base = s.rules.baseShelter;
  if (
    task.source !== "user" ||
    !base ||
    plan.positions.some(
      (p) =>
        Math.hypot(p.x - base.outside.x, p.z - base.outside.z) > 96 ||
        protectedPosition(p),
    )
  )
    throw new ConditionWait(
      "명시한 임시 제작대만 정리하며 공용 시설과 건물은 보존합니다.",
      s.checkpoint,
    );
  const clear = () =>
    s.bot.health >= 18 &&
    s.bot.food >= 18 &&
    !Object.values(s.bot.entities).some(
      (e) =>
        HOSTILES.has(e.name ?? "") &&
        e.position.distanceTo(s.bot.entity.position) < 20,
    );
  s.checkpoint.safeDetourRequired = true;
  for (const p of plan.positions) {
    s.check();
    if (!clear())
      throw new ConditionWait(
        "제작대 정리 전 실제 체력·허기와 주변 위협을 확인해야 합니다.",
        s.checkpoint,
      );
    const before = s.bot.blockAt(vector(p));
    if (before?.name === "air") continue;
    if (before?.name !== "crafting_table")
      throw new ConditionWait(
        "정리 대상으로 확인한 제작대가 다른 블록으로 바뀌었습니다.",
        s.checkpoint,
      );
    await s.near(p, 2);
    s.check();
    const actual = s.bot.blockAt(vector(p));
    if (
      !clear() ||
      !observedGroundStand(s.bot, s.bot.entity.position) ||
      actual?.name !== "crafting_table" ||
      !s.bot.canSeeBlock(actual) ||
      !s.bot.canDigBlock(actual) ||
      protectedPosition(p)
    )
      throw new ConditionWait(
        "실제 안전한 발판에서 닿는 임시 제작대만 정리합니다.",
        s.checkpoint,
      );
    const stock = s.bot.inventory
        .items()
        .filter((i) => i.name === "crafting_table")
        .reduce((n, i) => n + i.count, 0),
      axe = s.bot.inventory.items().find((i) => i.name.endsWith("_axe"));
    if (axe) await s.bot.equip(axe, "hand");
    s.check();
    s.progress(
      "임시 제작대 정리",
      "공용 제작대를 보존하고 지정한 임시 제작대를 회수합니다.",
    );
    await s.bot.dig(actual);
    await s.pause(150);
    s.check();
    if (s.bot.blockAt(vector(p))?.name !== "air")
      throw new ConditionWait(
        "제작대 회수의 실제 빈 공간을 확인해야 합니다.",
        s.checkpoint,
      );
    await s.recoverDrops?.(vector(p), "crafting_table", stock + 1);
    s.observations.push(s.observeInventory(), {
      ...observationBase(s.rules.world, s.rules.dimension),
      kind: "blocks",
      data: { blocks: [{ position: p, name: "air" }] },
    });
    s.checkpoint.utilityCleanupCompleted = [
      ...(Array.isArray(s.checkpoint.utilityCleanupCompleted)
        ? s.checkpoint.utilityCleanupCompleted
        : []),
      p,
    ];
  }
  return {
    outcome: "completed",
    checkpoint: s.checkpoint,
    observations: s.observations,
    evidence: s.evidence,
    reason: "지정한 임시 제작대를 정리하고 공용 작업대를 보존했습니다.",
  };
}
