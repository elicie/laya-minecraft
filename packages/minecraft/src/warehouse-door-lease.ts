import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import type { ActionServices } from "./services";

/** Forked Linux workers share the runtime directory. The OS releases this lock
 * after cancellation or process death. Never unlink a flock file: waiting
 * processes must continue to use the same inode. Never hold it over night. */
export async function withWarehouseDoor<T>(
  s: ActionServices,
  run: () => Promise<T>,
  directory = resolve(process.env.RUNTIME_DIR ?? "runtime", "door-leases"),
): Promise<T> {
  const base = s.rules.baseShelter;
  if (!base) return run();
  mkdirSync(directory, { recursive: true });
  const path = resolve(
    directory,
    createHash("sha256")
      .update(
        JSON.stringify([
          base.world,
          base.dimension,
          base.warehouseId,
          base.door,
        ]),
      )
      .digest("hex") + ".lock",
  );
  // The small owner exits on stdin EOF, including when its worker is killed.
  const child = spawn(
    "flock",
    [
      "--exclusive",
      path,
      process.execPath,
      "-e",
      "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let locked = false,
    failed: Error | undefined,
    ended = false;
  child.stdout.on("data", () => {
    locked = true;
  });
  child.on("error", (error) => {
    failed = error;
  });
  child.on("exit", () => {
    ended = true;
  });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  try {
    s.progress(
      "출입문 순서 대기",
      "동료의 실제 문 통과가 끝나면 같은 출입문을 사용합니다.",
    );
    while (!locked) {
      s.check();
      if (failed) throw failed;
      if (ended) throw new Error("창고 출입문 순서를 확보하지 못했습니다.");
      await wait(25, undefined, { signal: s.signal });
    }
    s.check();
    s.progress("창고 출입", "실제 문과 양쪽 발판을 확인하며 출입합니다.");
    return await run();
  } finally {
    child.stdin.end();
    if (!locked) child.kill("SIGTERM");
  }
}
