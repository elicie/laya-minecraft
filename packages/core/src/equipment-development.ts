import type {
  Agent,
  Goal,
  GoalInput,
  Observation,
  Rules,
} from "../../contracts/src";
import { itemCount, sameContainer } from "../../contracts/src";
import { freshObservations } from "./verification";

/** One owned upgrade at a time, funded by actual surplus rather than an endless
 * bootstrap/wooden-sword loop. Missing ore is a material need, not fabricated stock. */
export function equipmentDevelopmentGoals(
  rules: Rules,
  agents: Agent[],
  goals: Goal[],
  observations: Observation[],
  now: number,
  epoch: string,
): GoalInput[] {
  if (
    !rules.autonomyEnabled ||
    !rules.warehouse ||
    !rules.baseShelter ||
    !rules.workstations.length
  )
    return [];
  if (
    goals.some(
      (g) =>
        g.input.params.equipmentDevelopment === true &&
        !["completed", "cancelled"].includes(g.state),
    )
  )
    return [];
  const warehouse = rules.warehouse;
  const stock = freshObservations({
    observations: observations.filter((o) => o.controllerEpoch === epoch),
    now,
    maxAgeMs: rules.observationMaxAgeMs,
    world: warehouse.world,
    dimension: warehouse.dimension,
  })
    .filter(
      (o) =>
        o.kind === "container" && sameContainer(o.data.container, warehouse),
    )
    .sort(
      (a, b) => b.observedAt - a.observedAt || b.receivedAt - a.receivedAt,
    )[0];
  if (
    stock?.kind !== "container" ||
    itemCount(stock.data.items, "bread") <
      (rules.baseAutonomy?.breadTarget ?? 8)
  )
    return [];
  const count = (item: string) => itemCount(stock.data.items, item);
  for (const agent of [...agents].sort(
    (a, b) =>
      Number(b.config.role === "guard") - Number(a.config.role === "guard"),
  )) {
    const report = agent.session?.report;
    if (
      !agent.config.enabled ||
      agent.session?.state !== "ready" ||
      !report?.ready ||
      report.world !== rules.world ||
      report.dimension !== rules.dimension ||
      now - agent.session.lastReportAt >= rules.statusTimeoutMs ||
      report.health < 18 ||
      report.food < 18 ||
      !agent.config.allowedActions.includes("craft")
    )
      continue;
    const last = goals
      .filter(
        (g) =>
          g.input.params.equipmentDevelopment === true &&
          g.input.requiredBotId === agent.id &&
          g.state === "completed",
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (last && agent.session.lastReportAt <= last.updatedAt) continue;
    const worn = [5, 6, 7, 8, 45].flatMap(
      (i) => report.inventoryView?.slots[i] ?? [],
    );
    const owned = [...report.inventory, ...worn],
      has = (item: string) => owned.some((i) => i.name === item && i.count > 0);
    const rank = (suffix: string) =>
      Math.max(
        0,
        ...owned
          .filter((i) => i.count > 0 && i.name.endsWith(`_${suffix}`))
          .map(
            (i) =>
              ({
                wooden: 1,
                golden: 1,
                stone: 2,
                iron: 3,
                diamond: 4,
                netherite: 5,
              })[i.name.split("_")[0]!] ?? 0,
          ),
      );
    const options: { item: string; cost: Record<string, number> }[] = [];
    if (agent.config.role === "guard") {
      if (rank("sword") < 2)
        options.push({
          item: "stone_sword",
          cost: { cobblestone: 2, stick: 1 },
        });
      if (!has("shield"))
        options.push({
          item: "shield",
          cost: { iron_ingot: 1, oak_planks: 6 },
        });
      if (rank("sword") < 3)
        options.push({ item: "iron_sword", cost: { iron_ingot: 2, stick: 1 } });
      for (const [part, cost] of [
        ["chestplate", 8],
        ["helmet", 5],
        ["leggings", 7],
        ["boots", 4],
      ] as const)
        if (rank(part) < 3)
          options.push({ item: `iron_${part}`, cost: { iron_ingot: cost } });
    } else if (["general", "builder", "gatherer"].includes(agent.config.role)) {
      const tool = agent.config.role === "gatherer" ? "axe" : "pickaxe";
      if (rank(tool) < 2)
        options.push({
          item: `stone_${tool}`,
          cost: { cobblestone: 3, stick: 2 },
        });
      if (rank(tool) < 3)
        options.push({
          item: `iron_${tool}`,
          cost: { iron_ingot: 3, stick: 2 },
        });
    }
    for (const option of options) {
      const inputs: { item: string; quantity: number }[] = [];
      let logs = 0,
        feasible = true;
      for (const [item, quantity] of Object.entries(option.cost)) {
        const missing = Math.max(
          0,
          quantity - itemCount(report.inventory, item),
        );
        if (!missing) continue;
        const take = Math.min(count(item), missing);
        if (take) inputs.push({ item, quantity: take });
        const rest = missing - take;
        if (rest && item === "stick") logs += Math.ceil(rest / 4);
        else if (rest && item === "oak_planks") logs += Math.ceil(rest / 4);
        else if (rest) feasible = false;
      }
      if (
        logs >
        Math.max(0, count("oak_log") - (rules.baseAutonomy?.woodTarget ?? 2))
      )
        feasible = false;
      if (!feasible) continue;
      if (logs) inputs.push({ item: "oak_log", quantity: logs });
      return [
        {
          kind: "craft",
          item: option.item,
          quantity: 1,
          requiredBotId: agent.id,
          preferredBotId: agent.id,
          source: "autonomous",
          priority: 30,
          title: `${agent.config.name} · ${option.item} 장비 발전`,
          params: {
            equipmentDevelopment: true,
            warehouseInputs: inputs,
            useBaseDoor: true,
            equipAfterCraft: option.item.endsWith("_sword"),
          },
        },
      ];
    }
  }
  return [];
}
