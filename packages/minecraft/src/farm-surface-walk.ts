import type { Position } from "../../contracts/src";
import { vector, walkingFeet } from "./observations";
import { observedGroundStand } from "./observed-ground-walk";
import { HOSTILES } from "./combat-policy";
import { ConditionWait, type ActionServices } from "./services";

/** Walk through registered crops only on one level, without jumping. Enter and
 * leave via an observed dry bank at the same level, avoiding crop trampling. */
export async function farmSurfaceWalk(
  s: ActionServices,
  target: Position,
  plots: Position[],
  nearDry: (p: Position) => Promise<void>,
): Promise<boolean> {
  if (
    !plots.length ||
    plots.length > 32 ||
    plots.some((p) => p.y !== plots[0]!.y)
  )
    return false;
  const b = s.bot,
    y = plots[0]!.y + 1,
    keys = new Set(plots.map((p) => `${p.x},${p.z}`)),
    key = (p: Position) => `${p.x},${p.z}`;
  const start = walkingFeet(b),
    goal = walkingFeet(b, target),
    onFarm = (p: Position) => p.y === y && keys.has(key(p));
  if (!onFarm(start) && !onFarm(goal)) return false;
  const minX = Math.min(...plots.map((p) => p.x)) - 1,
    maxX = Math.max(...plots.map((p) => p.x)) + 1,
    minZ = Math.min(...plots.map((p) => p.z)) - 1,
    maxZ = Math.max(...plots.map((p) => p.z)) + 1;
  const clear = () =>
    !Object.values(b.entities).some(
      (e) =>
        HOSTILES.has(e.name ?? "") &&
        e.position.distanceTo(vector(b.entity.position)) < 12,
    );
  const stand = (p: Position) => {
    if (p.y !== y || p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ)
      return false;
    if (!keys.has(key(p))) return observedGroundStand(b, p, undefined, true);
    const soil = b.blockAt(vector(p).offset(0, -1, 0)),
      body = b.blockAt(vector(p)),
      head = b.blockAt(vector(p).offset(0, 1, 0)),
      below = b.blockAt(vector(p).offset(0, -2, 0));
    return (
      !!soil &&
      ["farmland", "dirt", "grass_block"].includes(soil.name) &&
      !!body &&
      ["air", "wheat", "carrots", "potatoes", "beetroots"].includes(
        body.name,
      ) &&
      body.boundingBox === "empty" &&
      !!head &&
      head.boundingBox === "empty" &&
      !!below &&
      below.boundingBox === "block" &&
      below.shapes.some(
        (a) =>
          a[0] === 0 &&
          a[1] === 0 &&
          a[2] === 0 &&
          a[3] === 1 &&
          a[4] === 1 &&
          a[5] === 1,
      )
    );
  };
  const path = (from: Position, to: Position): Position[] | undefined => {
    if (!stand(from) || !stand(to)) return;
    const queue: { p: Position; steps: Position[] }[] = [
        { p: from, steps: [] },
      ],
      seen = new Set([key(from)]);
    for (let i = 0; i < queue.length && i < 1024; i++) {
      const { p, steps } = queue[i]!;
      if (key(p) === key(to)) return steps;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const q = { x: p.x + dx!, y, z: p.z + dz! },
          k = key(q);
        if (!seen.has(k) && stand(q)) {
          seen.add(k);
          queue.push({ p: q, steps: [...steps, q] });
        }
      }
    }
  };
  const walk = async (steps: Position[]) => {
    b.pathfinder.setGoal(null);
    b.clearControlStates();
    try {
      for (const step of steps) {
        const soil = b.blockAt(vector(step).offset(0, -1, 0))!,
          height = Math.max(...soil.shapes.map((a) => a[4]!)),
          ground = step.y - 1 + height,
          aim = vector(step).offset(0.5, 0, 0.5);
        let arrived = false;
        for (let tick = 0; tick < 60; tick++) {
          s.check();
          if (
            !clear() ||
            !stand(walkingFeet(b)) ||
            !stand(step) ||
            Math.abs(b.entity.position.y - ground) > 0.16
          )
            throw new ConditionWait(
              "밭의 같은 높이 발판·작물·주변 위협 상태가 바뀌었습니다.",
              s.checkpoint,
            );
          if (
            Math.hypot(
              b.entity.position.x - aim.x,
              b.entity.position.z - aim.z,
            ) < 0.14 &&
            b.entity.onGround
          ) {
            arrived = true;
            break;
          }
          await b.lookAt(aim.offset(0, ground - step.y + 1.62, 0), true);
          b.setControlState("jump", false);
          b.setControlState("sprint", false);
          b.setControlState("forward", true);
          await s.pause(50);
        }
        b.clearControlStates();
        if (!arrived)
          throw new ConditionWait(
            "점프 없는 밭 보행의 실제 도착을 확인해야 합니다.",
            s.checkpoint,
          );
      }
    } finally {
      b.clearControlStates();
    }
    s.checkpoint.farmSurfaceWalk = {
      from: { x: start.x, y: start.y, z: start.z },
      to: target,
      steps: steps.length,
      jumped: false,
      observedAt: Date.now(),
    };
  };
  if (start.y === y && goal.y === y) {
    const direct = path(start, goal);
    if (direct) {
      await walk(direct);
      return true;
    }
  }
  const entries: Position[] = [];
  for (let x = minX; x <= maxX; x++)
    for (let z = minZ; z <= maxZ; z++) {
      const p = { x, y, z };
      if (
        !keys.has(key(p)) &&
        stand(p) &&
        plots.some((q) => Math.abs(q.x - x) + Math.abs(q.z - z) === 1)
      )
        entries.push(p);
    }
  entries.sort(
    (a, c) =>
      vector(a).distanceTo(vector(b.entity.position)) -
      vector(c).distanceTo(vector(b.entity.position)),
  );
  for (const entry of entries.slice(0, 12)) {
    const route = onFarm(goal)
      ? path(entry, goal)
      : onFarm(start)
        ? path(start, entry)
        : undefined;
    if (!route) continue;
    if (onFarm(goal)) {
      try {
        await nearDry(entry);
        // Public path completion can precede the final falling physics ticks.
        // Do not start the flat crop route from a neighboring elevated bank.
        b.pathfinder.setGoal(null);
        b.clearControlStates();
        for (let tick = 0; tick < 30; tick++) {
          s.check();
          const feet = walkingFeet(b);
          if (
            b.entity.onGround &&
            feet.equals(vector(entry)) &&
            Math.abs(b.entity.position.y - entry.y) < 0.16
          )
            break;
          await s.pause(50);
        }
        if (
          !b.entity.onGround ||
          !walkingFeet(b).equals(vector(entry)) ||
          Math.abs(b.entity.position.y - entry.y) > 0.16
        )
          continue;
      } catch (error) {
        s.check();
        if (!(error instanceof ConditionWait)) throw error;
        continue;
      }
      await walk(route);
      return true;
    }
    await walk(route);
    await nearDry(target);
    return true;
  }
  throw new ConditionWait(
    "작물을 밟아 뛰지 않고 연결되는 같은 높이의 밭 출입로가 필요합니다.",
    s.checkpoint,
  );
}
