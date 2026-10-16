import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { Vec3 } from "vec3";
import { pathfinder, Movements } from "mineflayer-pathfinder";
import { BotInputSchema, RulesSchema } from "../packages/contracts/src";
import { blueprint } from "../packages/contracts/src/blueprints";
import { warehouseShelter } from "../packages/core/src/warehouse-shelter";
import { createCompatibleBot } from "../packages/minecraft/src/compatibility";
import { MineflayerExecutor } from "../packages/minecraft/src/actions";
import { restInWarehouse } from "../packages/minecraft/src/base-shelter";
if (process.env.MC_HOST !== "127.0.0.1" || process.env.MC_PORT !== "25566")
  throw Error("Disposable validation server only");
const rcon = (s: string) =>
    execFileSync(
      "docker",
      ["exec", "minecraft-laya-validation", "rcon-cli", s],
      { encoding: "utf8" },
    ),
  sleep = (n: number) => new Promise((r) => setTimeout(r, n));
test(
  "two actual bots share a warehouse doorway without concurrent toggles and both resume outside",
  { timeout: 90000 },
  async () => {
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
    const cycle = rcon("gamerule doDaylightCycle").includes("true"),
      time = Number(rcon("time query daytime").match(/\d+/g)?.at(-1) ?? 0),
      origin = { x: 21000, y: 80, z: 21000 },
      blocks = blueprint("warehouse", origin),
      world = "127.0.0.1:25566",
      container = {
        id: "shared-door-fixture",
        world,
        dimension: "overworld",
        position: { x: 21001, y: 81, z: 21001 },
      },
      base = warehouseShelter(container, blocks)!;
    const bots: Awaited<ReturnType<typeof createCompatibleBot>>[] = [];
    try {
      rcon("forceload add 20990 20990 21020 21020");
      rcon("gamerule doDaylightCycle false");
      rcon("time set 2000");
      rcon("fill 20990 78 20990 21020 86 21020 air");
      rcon("fill 20990 77 20990 21020 79 21020 grass_block");
      for (const b of blocks.filter(
        (b) => !b.name.endsWith("_door") && b.name !== "wall_torch",
      ))
        rcon(
          `setblock ${b.position.x} ${b.position.y} ${b.position.z} ${b.name}`,
        );
      rcon(
        `setblock ${base.door.x} ${base.door.y} ${base.door.z} oak_door[facing=south,half=lower,open=false]`,
      );
      rcon(
        `setblock ${base.door.x} ${base.door.y + 1} ${base.door.z} oak_door[facing=south,half=upper,open=false]`,
      );
      for (const b of blocks.filter((b) => b.name === "wall_torch"))
        rcon(
          `setblock ${b.position.x} ${b.position.y} ${b.position.z} wall_torch[facing=${b.position.x === 21001 ? "east" : "west"}]`,
        );
      const rules = RulesSchema.parse({
          world,
          warehouse: container,
          baseShelter: base,
          autonomyEnabled: false,
        }),
        services = [];
      for (const name of ["LayaDoorA", "LayaDoorB"]) {
        const bot = await createCompatibleBot({
          host: "127.0.0.1",
          port: 25566,
          version: "1.21.1",
          username: name,
          auth: "offline",
        });
        bots.push(bot);
        bot.loadPlugin(pathfinder);
        await once(bot, "spawn");
        rcon(
          `tp ${name} ${base.outside.x + 0.5} ${base.outside.y} ${base.outside.z + 0.5}`,
        );
        const until = Date.now() + 5000;
        while (
          bot.entity.position.distanceTo(
            new Vec3(
              base.outside.x + 0.5,
              base.outside.y,
              base.outside.z + 0.5,
            ),
          ) > 0.2 &&
          Date.now() < until
        )
          await sleep(50);
        const m = new Movements(bot);
        m.canDig = false;
        m.allow1by1towers = false;
        m.allowParkour = false;
        m.scafoldingBlocks = [];
        bot.pathfinder.setMovements(m);
        const { id: _id, ...config } = BotInputSchema.parse({ name });
        services.push(
          new MineflayerExecutor(bot, {
            config,
            rules,
            world,
            dimension: () => "overworld",
          }).services(AbortSignal.timeout(50000)),
        );
      }
      await sleep(1800);
      const mismatch = () =>
        blocks.filter(
          (q) =>
            bots[0]!.blockAt(new Vec3(q.position.x, q.position.y, q.position.z))
              ?.name !== q.name,
        );
      console.log(
        "Before shared entry",
        JSON.stringify({
          positions: bots.map((b) => b.entity.position),
          mismatch: mismatch(),
        }),
      );
      const entries = await Promise.all(
        services.map((s) => restInWarehouse(s, () => true, undefined, "enter")),
      );
      console.log(
        "After shared entry",
        JSON.stringify({
          entries,
          positions: bots.map((b) => b.entity.position),
          mismatch: mismatch(),
        }),
      );
      assert.ok(entries.every(Boolean));
      assert.ok(
        bots.every((b) => Math.floor(b.entity.position.y) === base.inside.y),
      );
      assert.equal(
        bots[0]!
          .blockAt(new Vec3(base.door.x, base.door.y, base.door.z))!
          .getProperties().open,
        false,
      );
      await Promise.all(
        services.map((s) => restInWarehouse(s, () => true, undefined, "exit")),
      );
      assert.ok(
        bots.every(
          (b) =>
            b.entity.position.distanceTo(
              new Vec3(
                base.outside.x + 0.5,
                base.outside.y,
                base.outside.z + 0.5,
              ),
            ) < 0.4,
        ),
      );
      assert.ok(bots.every((b) => b.health === 20));
      assert.equal(
        bots[0]!
          .blockAt(new Vec3(base.door.x, base.door.y, base.door.z))!
          .getProperties().open,
        false,
      );
      assert.ok(
        blocks.every(
          (q) =>
            bots[0]!.blockAt(new Vec3(q.position.x, q.position.y, q.position.z))
              ?.name === q.name,
        ),
      );
      console.log(
        JSON.stringify({
          twoActualBots: true,
          concurrentEntryAndExit: true,
          doorClosed: true,
          structurePreserved: true,
          productionWorld: false,
          fixturePrepared: true,
        }),
      );
    } finally {
      for (const b of bots) b.quit("shared door fixture complete");
      rcon(`gamerule doDaylightCycle ${cycle}`);
      rcon(`time set ${time}`);
      rcon("forceload remove 20990 20990 21020 21020");
    }
  },
);
