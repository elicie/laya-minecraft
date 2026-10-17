import type { Bot } from "mineflayer";
import {
  boundedNightDestination,
  boundedNightTask,
  type Rules,
  type TaskSpec,
} from "../../contracts/src";
import { HOSTILES } from "./combat-policy";
import { vector, walkingFeet } from "./observations";
import { observedGroundStand } from "./observed-ground-walk";

export function verifiedWarehouseInterior(bot: Bot, rules: Rules): boolean {
  const base = rules.baseShelter;
  if (!base || base.world !== rules.world || base.dimension !== rules.dimension)
    return false;
  const p = walkingFeet(bot),
    xs = base.blocks.map((b) => b.position.x),
    zs = base.blocks.map((b) => b.position.z);
  if (
    p.y !== base.inside.y ||
    p.x <= Math.min(...xs) ||
    p.x >= Math.max(...xs) ||
    p.z <= Math.min(...zs) ||
    p.z >= Math.max(...zs)
  )
    return false;
  if (bot.blockAt(vector(base.door))?.getProperties().open !== false)
    return false;
  return (
    base.blocks.every(
      (b) => bot.blockAt(vector(b.position))?.name === b.name,
    ) &&
    !Object.values(bot.entities).some(
      (e) =>
        HOSTILES.has(e.name ?? "") &&
        Math.abs(e.position.y - p.y) < 2 &&
        e.position.x > Math.min(...xs) &&
        e.position.x < Math.max(...xs) &&
        e.position.z > Math.min(...zs) &&
        e.position.z < Math.max(...zs),
    )
  );
}

/** Night work stays near a real shelter and yields as soon as a threat appears. */
export function localNightConditions(bot: Bot, rules: Rules): boolean {
  const base = rules.baseShelter;
  if (
    !base ||
    base.world !== rules.world ||
    base.dimension !== rules.dimension ||
    bot.health < 18 ||
    bot.food < 18
  )
    return false;
  if (verifiedWarehouseInterior(bot, rules)) return true;
  const p = bot.entity.position;
  return (
    Math.hypot(p.x - base.outside.x, p.z - base.outside.z) <= 48 &&
    Math.abs(p.y - base.outside.y) <= 16 &&
    !Object.values(bot.entities).some(
      (e) => HOSTILES.has(e.name ?? "") && e.position.distanceTo(p) < 20,
    )
  );
}

export function localNightDestination(rules: Rules, value: unknown): boolean {
  return boundedNightDestination(rules, value);
}

export function localNightExitClear(bot: Bot, rules: Rules): boolean {
  const base = rules.baseShelter;
  return (
    !!base &&
    localNightConditions(bot, rules) &&
    observedGroundStand(bot, base.outside) &&
    !Object.values(bot.entities).some(
      (e) =>
        HOSTILES.has(e.name ?? "") &&
        e.position.distanceTo(vector(base.outside).offset(0.5, 0, 0.5)) < 20,
    )
  );
}

export function localNightTask(
  bot: Bot,
  rules: Rules,
  task: TaskSpec,
): boolean {
  return localNightConditions(bot, rules) && boundedNightTask(rules, task);
}

export function localNightGuard(bot: Bot, rules: Rules, role: string): boolean {
  return (
    role === "guard" &&
    localNightConditions(bot, rules) &&
    bot.inventory
      .items()
      .some((i) => i.count > 0 && /_(sword|axe)$/.test(i.name)) &&
    observedGroundStand(bot, bot.entity.position)
  );
}
