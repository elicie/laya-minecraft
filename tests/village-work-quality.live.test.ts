import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Vec3 } from "vec3";
import { pathfinder, Movements } from "mineflayer-pathfinder";
import {
  WorkerLaunchSchema,
  type WorkerMessage,
  type TaskSpec,
} from "../packages/contracts/src";
import { blueprint } from "../packages/contracts/src/blueprints";
import { warehouseShelter } from "../packages/core/src/warehouse-shelter";
import { createCompatibleBot } from "../packages/minecraft/src/compatibility";
import { MinecraftWorker } from "../packages/minecraft/src/worker";
import { MineflayerExecutor } from "../packages/minecraft/src/actions";
import { ConditionWait } from "../packages/minecraft/src/services";
if (process.env.MC_HOST !== "127.0.0.1" || process.env.MC_PORT !== "25566")
  throw Error("Disposable minecraft-laya-validation:25566 only.");
const rcon = (command: string) =>
    execFileSync(
      "docker",
      ["exec", "minecraft-laya-validation", "rcon-cli", command],
      { encoding: "utf8" },
    ),
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function verifyLab() {
  assert.equal(
    execFileSync(
      "docker",
      [
        "inspect",
        "-f",
        '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}',
        "minecraft-laya-validation",
      ],
      { encoding: "utf8" },
    ).trim(),
    "25566",
  );
}
function buildWarehouse(x: number, z: number) {
  const world = "127.0.0.1:25566",
    origin = { x, y: 80, z },
    blocks = blueprint("warehouse", origin),
    warehouse = {
      id: "quality-house",
      world,
      dimension: "overworld",
      position: { x: x + 1, y: 81, z: z + 1 },
    },
    base = warehouseShelter(warehouse, blocks)!,
    table = blocks.find((b) => b.name === "crafting_table")!;
  for (const b of blocks.filter(
    (b) => !b.name.endsWith("_door") && b.name !== "wall_torch",
  ))
    rcon(`setblock ${b.position.x} ${b.position.y} ${b.position.z} ${b.name}`);
  for (const half of ["lower", "upper"])
    rcon(
      `setblock ${base.door.x} ${base.door.y + (half === "upper" ? 1 : 0)} ${base.door.z} oak_door[facing=south,half=${half},open=false]`,
    );
  for (const b of blocks.filter((b) => b.name === "wall_torch"))
    rcon(
      `setblock ${b.position.x} ${b.position.y} ${b.position.z} wall_torch[facing=${b.position.x === x + 1 ? "east" : "west"}]`,
    );
  assert.ok(table);
  return { world, warehouse, base, table };
}

test(
  "an unarmored real worker leaves its night wait to craft a stone sword, shield and helmet at one shared station",
  { timeout: 65000 },
  async () => {
    verifyLab();
    const cycle = rcon("gamerule doDaylightCycle").includes("true"),
      spawning = rcon("gamerule doMobSpawning").includes("true");
    rcon("forceload add 30000 30000 30031 30031");
    rcon("fill 30000 79 30000 30031 88 30031 air");
    rcon("fill 30000 79 30000 30031 79 30031 grass_block");
    rcon("gamerule doMobSpawning false");
    rcon("gamerule doDaylightCycle false");
    rcon("time set 1000");
    rcon(
      "execute positioned 30010 80 30010 run kill @e[type=!player,distance=..30]",
    );
    const house = buildWarehouse(30005, 30005),
      messages: WorkerMessage[] = [],
      bot = await createCompatibleBot({
        host: "127.0.0.1",
        port: 25566,
        version: "1.21.1",
        auth: "offline",
        username: "LayaNightWork",
      });
    bot.loadPlugin(pathfinder);
    const launch = WorkerLaunchSchema.parse({
        botId: "quality-builder",
        sessionId: "quality-session",
        controllerEpoch: "quality-epoch",
        config: {
          name: "LayaNightWork",
          role: "builder",
          connection: {
            host: "127.0.0.1",
            port: 25566,
            version: "1.21.1",
            auth: "offline",
          },
        },
        rules: {
          world: house.world,
          warehouse: house.warehouse,
          baseShelter: house.base,
          autonomyEnabled: false,
          workstations: [
            {
              name: "crafting_table",
              position: house.table.position,
              world: house.world,
              dimension: "overworld",
            },
          ],
        },
      }),
      worker = new MinecraftWorker(launch, bot, (m) => messages.push(m), {
        timers: false,
      });
    const craft = async (item: string, equipAfterCraft = false) => {
      const task: TaskSpec = {
          id: `craft-${item}`,
          goalId: `gear-${item}`,
          source: "user",
          kind: "craft",
          params: { item, quantity: 1, equipAfterCraft },
          completion: { kind: "inventory", item, minimum: 1 },
          dependencies: [],
          reservationKeys: [],
        },
        attemptId = randomUUID();
      await worker.receive({
        protocolVersion: 1,
        messageId: randomUUID(),
        controllerEpoch: launch.controllerEpoch,
        botId: launch.botId,
        sessionId: launch.sessionId,
        sentAt: Date.now(),
        type: "task.assign",
        taskId: task.id,
        attemptId,
        payload: {
          task,
          checkpoint: { preservedSearchSpend: { moves: 17 } },
          rulesVersion: launch.rules.version,
        },
      });
      for (
        let i = 0;
        i < 240 &&
        !messages.some(
          (m) => m.type === "task.result" && m.attemptId === attemptId,
        );
        i++
      ) {
        worker.pollSafety();
        await sleep(50);
      }
      const result = messages.find(
        (m): m is Extract<WorkerMessage, { type: "task.result" }> =>
          m.type === "task.result" && m.attemptId === attemptId,
      );
      assert.ok(
        result,
        JSON.stringify(
          messages
            .filter(
              (m) =>
                m.type === "task.rejected" ||
                m.type === "task.interrupted" ||
                m.type === "bot.error",
            )
            .slice(-4),
        ),
      );
      assert.equal(result.payload.outcome, "completed");
      assert.deepEqual(result.payload.checkpoint.preservedSearchSpend, {
        moves: 17,
      });
      assert.equal(bot.health, 20);
    };
    try {
      await once(bot, "spawn");
      rcon(
        `tp LayaNightWork ${house.base.inside.x + 0.5} ${house.base.inside.y} ${house.base.inside.z + 0.5}`,
      );
      rcon("clear LayaNightWork");
      rcon("give LayaNightWork wooden_sword 1");
      rcon("give LayaNightWork cobblestone 2");
      rcon("give LayaNightWork stick 1");
      for (
        let i = 0;
        i < 160 &&
        (!messages.some((m) => m.type === "bot.ready") ||
          bot.entity.onGround !== true ||
          bot.entity.position.distanceTo(
            new Vec3(
              house.base.inside.x + 0.5,
              house.base.inside.y,
              house.base.inside.z + 0.5,
            ),
          ) > 0.1 ||
          !bot.inventory.items().some((i) => i.name === "cobblestone"));
        i++
      )
        await sleep(50);
      rcon("gamerule doDaylightCycle true");
      rcon("time set 14000");
      for (
        let i = 0;
        i < 80 && (!bot.time.doDaylightCycle || bot.time.isDay);
        i++
      )
        await sleep(50);
      const report = () =>
        (
          worker as unknown as { report(): { action: string; reason: string } }
        ).report();
      for (let i = 0; i < 100 && report().action !== "창고 야간 대피"; i++) {
        worker.pollSafety();
        await sleep(50);
      }
      assert.equal(
        report().action,
        "창고 야간 대피",
        JSON.stringify({
          report: report(),
          position: bot.entity.position,
          time: bot.time.timeOfDay,
        }),
      );
      await craft("stone_sword", true);
      assert.equal(bot.heldItem?.name, "stone_sword");
      assert.ok(bot.inventory.items().some((i) => i.name === "wooden_sword"));
      rcon("give LayaNightWork iron_ingot 1");
      rcon("give LayaNightWork oak_planks 6");
      await sleep(150);
      await craft("shield");
      for (
        let i = 0;
        i < 80 && bot.inventory.slots[45]?.name !== "shield";
        i++
      ) {
        worker.pollSafety();
        await sleep(50);
      }
      assert.equal(bot.inventory.slots[45]?.name, "shield");
      await sleep(150);
      rcon("give LayaNightWork iron_ingot 5");
      await sleep(150);
      await craft("iron_helmet");
      for (
        let i = 0;
        i < 80 && bot.inventory.slots[5]?.name !== "iron_helmet";
        i++
      ) {
        worker.pollSafety();
        await sleep(50);
      }
      assert.equal(bot.inventory.slots[5]?.name, "iron_helmet");
      await sleep(150);
      rcon(
        `summon zombie ${house.base.outside.x + 15.5} ${house.base.outside.y} ${house.base.outside.z + 0.5} {NoAI:1b,PersistenceRequired:1b,Tags:["laya_quality_night_threat"]}`,
      );
      for (
        let i = 0;
        i < 80 && !Object.values(bot.entities).some((e) => e.name === "zombie");
        i++
      )
        await sleep(50);
      assert.ok(Object.values(bot.entities).some((e) => e.name === "zombie"));
      const exit: TaskSpec = {
          id: "unsafe-night-exit",
          goalId: "unsafe-night-exit",
          source: "user",
          kind: "home",
          params: { basePassage: "outside", position: house.base.outside },
          completion: {
            kind: "position",
            position: house.base.outside,
            radius: 1,
          },
          dependencies: [],
          reservationKeys: [],
        },
        exitAttempt = randomUUID();
      await worker.receive({
        protocolVersion: 1,
        messageId: randomUUID(),
        controllerEpoch: launch.controllerEpoch,
        botId: launch.botId,
        sessionId: launch.sessionId,
        sentAt: Date.now(),
        type: "task.assign",
        taskId: exit.id,
        attemptId: exitAttempt,
        payload: {
          task: exit,
          checkpoint: {},
          rulesVersion: launch.rules.version,
        },
      });
      for (
        let i = 0;
        i < 120 &&
        !messages.some(
          (m) => m.type === "task.result" && m.attemptId === exitAttempt,
        );
        i++
      ) {
        worker.pollSafety();
        await sleep(50);
      }
      const stopped = messages.find(
        (m): m is Extract<WorkerMessage, { type: "task.result" }> =>
          m.type === "task.result" && m.attemptId === exitAttempt,
      );
      assert.ok(stopped);
      assert.equal(stopped.payload.outcome, "condition-wait");
      assert.equal(Math.floor(bot.entity.position.y), house.base.inside.y);
      rcon("give LayaNightWork oak_log 1");
      await sleep(150);
      await craft("oak_planks");
      assert.equal(
        bot
          .blockAt(
            new Vec3(house.base.door.x, house.base.door.y, house.base.door.z),
          )!
          .getProperties().open,
        false,
      );
      assert.equal(
        bot.findBlocks({
          matching: bot.registry.blocksByName.crafting_table!.id,
          point: new Vec3(
            house.base.inside.x,
            house.base.inside.y,
            house.base.inside.z,
          ),
          maxDistance: 16,
          count: 16,
        }).length,
        1,
      );
      console.log(
        "Actual productive nighttime",
        JSON.stringify({
          nightWaitInterruptedForAllowedWork: true,
          stoneSwordCraftedAndHeld: true,
          woodenSwordDidNotPreventUpgrade: true,
          shieldCraftedAndEquipped: true,
          ironHelmetCraftedAndEquipped: true,
          nearbyRealZombieBlockedExit: true,
          indoorCraftContinued: true,
          oneSharedTable: true,
          closedDoor: true,
          health: bot.health,
          fixtureRawMaterialsAndZombie: true,
          productionWorld: false,
        }),
      );
    } finally {
      await worker.shutdown("night work quality validation complete");
      await sleep(150);
      rcon("kill @e[tag=laya_quality_night_threat]");
      rcon(`gamerule doDaylightCycle ${cycle}`);
      rcon(`gamerule doMobSpawning ${spawning}`);
      rcon("forceload remove 30000 30000 30031 30031");
    }
  },
);

test(
  "real collection preserves the village yard, then explicit temporary-table cleanup leaves the shared station and torch intact",
  { timeout: 55000 },
  async () => {
    verifyLab();
    rcon("forceload add 30300 30300 30347 30315");
    rcon("fill 30300 79 30300 30347 88 30315 air");
    rcon("fill 30300 79 30300 30347 79 30315 grass_block");
    rcon("time set 1000");
    rcon(
      "execute positioned 30320 80 30305 run kill @e[type=!player,distance=..30]",
    );
    const house = buildWarehouse(30300, 30305);
    rcon("setblock 30315 80 30300 stone");
    rcon("setblock 30335 80 30300 stone");
    rcon("setblock 30320 80 30304 crafting_table");
    rcon("setblock 30321 80 30304 torch");
    const bot = await createCompatibleBot({
      host: "127.0.0.1",
      port: 25566,
      version: "1.21.1",
      auth: "offline",
      username: "LayaYardGuard",
    });
    bot.loadPlugin(pathfinder);
    try {
      await once(bot, "spawn");
      rcon("tp LayaYardGuard 30310.5 80 30300.5");
      rcon("clear LayaYardGuard");
      rcon("give LayaYardGuard wooden_pickaxe 1");
      for (
        let i = 0;
        i < 160 &&
        (bot.entity.onGround !== true ||
          bot.entity.position.distanceTo(new Vec3(30310.5, 80, 30300.5)) >
            0.1 ||
          !bot.inventory.items().length);
        i++
      )
        await sleep(50);
      const moves = new Movements(bot);
      moves.canDig = false;
      moves.canOpenDoors = true;
      moves.allow1by1towers = false;
      moves.allowParkour = false;
      moves.maxDropDown = 2;
      moves.infiniteLiquidDropdownDistance = false;
      moves.scafoldingBlocks = [];
      bot.pathfinder.setMovements(moves);
      const launch = WorkerLaunchSchema.parse({
          botId: "yard",
          sessionId: "s",
          controllerEpoch: "e",
          config: { name: "LayaYardGuard" },
          rules: {
            world: house.world,
            baseShelter: house.base,
            warehouse: house.warehouse,
            workstations: [
              {
                name: "crafting_table",
                position: house.table.position,
                world: house.world,
                dimension: "overworld",
              },
            ],
            autonomyEnabled: false,
          },
        }),
        executor = new MineflayerExecutor(bot, {
          config: launch.config,
          rules: launch.rules,
          world: house.world,
          dimension: () => "overworld",
        }),
        task: TaskSpec = {
          id: "quarry",
          goalId: "quarry",
          source: "user",
          kind: "collect",
          params: { item: "cobblestone", quantity: 1 },
          completion: { kind: "inventory", item: "cobblestone", minimum: 1 },
          dependencies: [],
          reservationKeys: [],
        };
      const result = await executor.execute(
        task,
        executor.services(AbortSignal.timeout(25000)),
      );
      assert.equal(result.outcome, "completed");
      assert.equal(executor.count("cobblestone"), 1);
      assert.equal(bot.blockAt(new Vec3(30315, 80, 30300))?.name, "stone");
      assert.equal(bot.blockAt(new Vec3(30335, 80, 30300))?.name, "air");
      const cleanup = (
        positions: { x: number; y: number; z: number }[],
      ): TaskSpec => ({
        id: "cleanup",
        goalId: "cleanup",
        source: "user",
        kind: "build",
        params: { mode: "utility-cleanup", cleanup: { positions } },
        completion: {
          kind: "blocks",
          blocks: positions.map((position) => ({ position, name: "air" })),
        },
        dependencies: [],
        reservationKeys: [],
      });
      await assert.rejects(
        executor.execute(
          cleanup([house.table.position]),
          executor.services(AbortSignal.timeout(5000)),
        ),
        ConditionWait,
      );
      const cleaned = await executor.execute(
        cleanup([{ x: 30320, y: 80, z: 30304 }]),
        executor.services(AbortSignal.timeout(15000)),
      );
      assert.equal(cleaned.outcome, "completed");
      assert.equal(executor.count("crafting_table"), 1);
      assert.equal(bot.blockAt(new Vec3(30321, 80, 30304))?.name, "torch");
      assert.equal(
        bot.blockAt(
          new Vec3(
            house.table.position.x,
            house.table.position.y,
            house.table.position.z,
          ),
        )?.name,
        "crafting_table",
      );
      assert.equal(bot.health, 20);
      console.log(
        "Actual yard and workstation policy",
        JSON.stringify({
          nearVillageStonePreserved: true,
          offsiteStoneHarvested: 1,
          temporaryTableRecovered: 1,
          sharedTableRetained: true,
          torchRetained: true,
          health: bot.health,
          fixtureTerrainAndPickaxe: true,
          productionWorld: false,
        }),
      );
    } finally {
      bot.quit("yard quality validation complete");
      await sleep(150);
      rcon("forceload remove 30300 30300 30347 30315");
    }
  },
);
