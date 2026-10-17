import {
  PositionSchema,
  type Rules,
  type TaskSpec,
  type BotReport,
} from "./index";

export function boundedNightDestination(rules: Rules, value: unknown): boolean {
  const base = rules.baseShelter,
    p = PositionSchema.safeParse(value);
  return (
    !!base &&
    base.world === rules.world &&
    base.dimension === rules.dimension &&
    p.success &&
    Math.hypot(p.data.x - base.outside.x, p.data.z - base.outside.z) <= 48 &&
    Math.abs(p.data.y - base.outside.y) <= 16
  );
}
export function boundedNightTask(rules: Rules, task: TaskSpec): boolean {
  const near = (value: unknown) => boundedNightDestination(rules, value);
  if (task.kind === "craft" || task.kind === "smelt") return true;
  if (task.kind === "take" || task.kind === "store") {
    const d = task.params.destination as
      { position?: unknown; world?: unknown; dimension?: unknown } | undefined;
    return d
      ? d.world === rules.world &&
          d.dimension === rules.dimension &&
          near(d.position)
      : !!rules.warehouse && near(rules.warehouse.position);
  }
  if (task.kind === "home" || task.kind === "guard")
    return (
      near(task.params.position) ||
      (task.kind === "home" &&
        ["inside", "outside"].includes(String(task.params.basePassage)))
    );
  if (task.kind === "farm")
    return (
      Array.isArray(task.params.positions) &&
      task.params.positions.length > 0 &&
      task.params.positions.every(near)
    );
  if (task.kind === "build") {
    if (task.params.mode === "material-access") {
      const p = task.params.access as
        | { edits?: { position?: unknown; stand?: unknown }[]; exit?: unknown }
        | undefined;
      return (
        !!p?.edits?.length &&
        p.edits.every((e) => near(e.position) && near(e.stand)) &&
        near(p.exit)
      );
    }
    return (
      Array.isArray(task.params.requiredBlocks) &&
      task.params.requiredBlocks.length > 0 &&
      task.params.requiredBlocks.every(
        (b) =>
          !!b && typeof b === "object" && "position" in b && near(b.position),
      )
    );
  }
  return false;
}

/** Central scheduling may offer healthy shelter occupants local work. The
 * worker still proves the real building, door, current threats and task scope. */
export function canScheduleNightShelterWork(
  rules: Rules,
  report: BotReport,
  task?: TaskSpec,
): boolean {
  const base = rules.baseShelter,
    p = report.position,
    c = report.survivalRecovery?.checkpoint,
    night = c?.nightBase as
      { phase?: unknown; warehouseId?: unknown } | undefined;
  if (
    !base ||
    !p ||
    report.world !== rules.world ||
    report.dimension !== rules.dimension ||
    report.health < 20 ||
    report.food < (c?.expeditionFoodTarget === 19 ? 19 : 18) ||
    c?.nightBasePending !== true ||
    c.nightBurrowPending === true ||
    night?.phase !== "closed" ||
    night.warehouseId !== base.warehouseId
  )
    return false;
  if (
    report.isDay !== false &&
    !(
      typeof report.timeOfDay === "number" &&
      report.timeOfDay >= 9000 &&
      report.timeOfDay < 23000
    )
  )
    return false;
  const xs = base.blocks.map((b) => b.position.x),
    zs = base.blocks.map((b) => b.position.z);
  return (
    Math.floor(p.y) === base.inside.y &&
    p.x > Math.min(...xs) &&
    p.x < Math.max(...xs) &&
    p.z > Math.min(...zs) &&
    p.z < Math.max(...zs) &&
    (!task || boundedNightTask(rules, task))
  );
}
