import { test, expect, type Page, type Route } from "@playwright/test";
import {
  AgentSchema,
  DEFAULT_RULES,
  FleetSnapshotSchema,
  type FleetSnapshot,
} from "../../packages/contracts/src";

type StreamHarness = {
  streamUrls: string[];
  publish(kind: "snapshot" | "open" | "error", value?: unknown): void;
};

function fleet(now: number): FleetSnapshot {
  return FleetSnapshotSchema.parse({
    schemaVersion: 1,
    controllerEpoch: "original-controller",
    revision: 5,
    updatedAt: now,
    rules: DEFAULT_RULES,
    blueprints: [],
    agents: [
      AgentSchema.parse({
        id: "ObservedBot",
        config: {
          name: "ObservedBot",
          role: "builder",
          connection: { host: "127.0.0.1", port: 25566 },
        },
        pendingCommandIds: [],
        createdAt: now,
        updatedAt: now,
        status: "ready",
        viewer: { state: "stopped" },
        session: {
          id: "observed-session",
          state: "ready",
          lastReportAt: now,
          rulesVersion: 1,
          report: {
            ready: true,
            world: DEFAULT_RULES.world,
            dimension: "overworld",
            health: 20,
            food: 20,
            inventory: [],
            action: "최근 작업 확인",
            reason: "실제로 받은 최초 보고입니다.",
            mode: "idle",
            capabilities: ["build"],
            rulesVersion: 1,
          },
        },
      }),
    ],
    goals: [],
    tasks: [],
    attempts: [],
    reservations: [],
    observations: [],
    events: [],
  });
}

async function installStream(page: Page) {
  await page.addInitScript(() => {
    const streams = new Set<MockStream>();
    const urls: string[] = [];
    class MockStream extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        super();
        urls.push(url);
        streams.add(this);
        setTimeout(() => {
          if (streams.has(this)) this.onopen?.();
        }, 0);
      }
      close() {
        streams.delete(this);
      }
    }
    Object.defineProperty(window, "EventSource", { value: MockStream });
    Object.assign(window, {
      streamUrls: urls,
      publish(kind: string, value: unknown) {
        for (const stream of streams) {
          if (kind === "open") stream.onopen?.();
          else if (kind === "error") stream.onerror?.();
          else
            stream.dispatchEvent(
              new MessageEvent(kind, { data: JSON.stringify(value) }),
            );
        }
      },
    });
  });
}

async function publish(
  page: Page,
  kind: "snapshot" | "open" | "error",
  value?: unknown,
) {
  await page.evaluate(
    ({ kind, value }) =>
      (window as unknown as StreamHarness).publish(kind, value),
    { kind, value },
  );
}

async function start(page: Page) {
  await page.goto("/");
  await page.clock.runFor(10);
  await expect(page.locator(".connection")).toContainText("중앙 시스템 연결됨");
}

function renew(state: FleetSnapshot, now: number, action: string) {
  state.updatedAt = now;
  state.revision++;
  state.agents[0]!.session!.lastReportAt = now;
  state.agents[0]!.session!.report!.action = action;
  return state;
}

test("silent open streams stop claiming a live connection and retry one abortable dashboard snapshot at a time", async ({
  page,
}) => {
  const now = Date.now();
  let state = fleet(now),
    phase: "initial" | "hold" | "fresh" = "initial";
  const delayed: Route[] = [],
    urls: string[] = [];
  await page.clock.install({ time: now });
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    expect(url.pathname).toBe("/api/v1/snapshot");
    expect(url.searchParams.get("view")).toBe("dashboard");
    urls.push(url.href);
    if (phase === "hold") {
      delayed.push(route);
      return;
    }
    return route.fulfill({ json: state });
  });
  await start(page);
  expect(
    await page.evaluate(() =>
      (window as unknown as StreamHarness).streamUrls.every(
        (url) => url === "/api/v1/stream?view=dashboard",
      ),
    ),
  ).toBe(true);
  phase = "hold";
  await page.clock.fastForward(10_000);
  await expect(page.locator(".connection")).toContainText("다시 연결 중");
  await expect(
    page.getByRole("button", { name: "＋ 목표 등록", exact: true }),
  ).toBeDisabled();
  await expect.poll(() => delayed.length).toBe(1);
  // An open TCP connection cannot restore the stale snapshot's live indicator.
  await publish(page, "open");
  await expect(page.locator(".connection")).toContainText("다시 연결 중");
  await page.clock.fastForward(5_000);
  expect(delayed).toHaveLength(1);
  await page.clock.fastForward(5_000);
  phase = "fresh";
  state = renew(
    state,
    await page.evaluate(() => Date.now()),
    "실제 갱신된 작업",
  );
  await page.clock.fastForward(1_000);
  await expect(page.locator(".connection")).toContainText("중앙 시스템 연결됨");
  await expect(
    page.getByRole("button", { name: "＋ 목표 등록", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("실제 갱신된 작업", { exact: true }),
  ).toBeVisible();
  expect(urls.length).toBeGreaterThanOrEqual(3);
  // Until streaming resumes, successful HTTP reads continue to keep reports current.
  const requestsBefore = urls.length;
  state = renew(state, await page.evaluate(() => Date.now()), "다음 실제 갱신");
  await page.clock.fastForward(3_000);
  await expect.poll(() => urls.length).toBe(requestsBefore + 1);
  await expect(page.getByText("다음 실제 갱신", { exact: true })).toBeVisible();
});

test("late HTTP and old-epoch snapshots never replace newer streamed state or revive invalid stream data", async ({
  page,
}) => {
  const now = Date.now();
  const state = fleet(now);
  let hold = false;
  const delayed: Route[] = [];
  await page.clock.install({ time: now });
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    if (hold) {
      delayed.push(route);
      return;
    }
    return route.fulfill({ json: state });
  });
  await start(page);
  hold = true;
  await page.clock.fastForward(10_000);
  await expect.poll(() => delayed.length).toBe(1);
  const current = renew(
    structuredClone(state),
    now + 10_010,
    "새 중앙에서 확인한 작업",
  );
  current.controllerEpoch = "replacement-controller";
  current.revision = 1;
  await publish(page, "snapshot", current);
  await expect(page.locator(".connection")).toContainText("중앙 시스템 연결됨");
  await expect(
    page.getByText("새 중앙에서 확인한 작업", { exact: true }),
  ).toBeVisible();
  // The retired epoch cannot return, even if an old request carries a later timestamp.
  const retired = renew(
    structuredClone(state),
    now + 20_000,
    "이전 중앙의 늦은 응답",
  );
  retired.revision = 999;
  await delayed[0]!.fulfill({ json: retired });
  await expect(
    page.getByText("이전 중앙의 늦은 응답", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("새 중앙에서 확인한 작업", { exact: true }),
  ).toBeVisible();
  const oldRevision = renew(
    structuredClone(current),
    now + 21_000,
    "이전 작업 번호",
  );
  oldRevision.revision = 0;
  await publish(page, "snapshot", oldRevision);
  await expect(page.getByText("이전 작업 번호", { exact: true })).toHaveCount(
    0,
  );
  await publish(page, "snapshot", { ...current, schemaVersion: 99 });
  await expect(page.locator(".connection")).toContainText(
    "중앙 시스템 연결 끊김",
  );
  await expect(page.getByRole("alert")).toContainText(
    "현황 응답을 확인할 수 없습니다.",
  );
  await publish(page, "open");
  await expect(page.locator(".connection")).toContainText(
    "중앙 시스템 연결 끊김",
  );
  current.revision++;
  current.updatedAt = now + 10_011;
  await publish(page, "snapshot", current);
  await expect(page.locator(".connection")).toContainText("중앙 시스템 연결됨");
});

test("an open stream without any valid snapshot stays unavailable and initial read timeouts can recover", async ({
  page,
}) => {
  const now = Date.now();
  const state = fleet(now);
  let hold = true,
    requests = 0;
  await page.clock.install({ time: now });
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    requests++;
    if (hold) return;
    return route.fulfill({ json: state });
  });
  await page.goto("/");
  await page.clock.runFor(10);
  await publish(page, "open");
  await expect(page.locator(".connection")).not.toContainText(
    "중앙 시스템 연결됨",
  );
  await expect(
    page.getByRole("button", { name: "＋ 목표 등록", exact: true }),
  ).toBeDisabled();
  const initialRequests = requests;
  hold = false;
  renew(state, now + 10_010, "연결 후 처음 확인한 작업");
  await page.clock.fastForward(10_000);
  await page.clock.fastForward(1_000);
  await expect.poll(() => requests).toBeGreaterThan(initialRequests);
  await expect(page.locator(".connection")).toContainText("중앙 시스템 연결됨");
  await expect(
    page.getByText("연결 후 처음 확인한 작업", { exact: true }),
  ).toBeVisible();
  await publish(page, "error");
  await expect(page.locator(".connection")).toContainText("다시 연결 중");
  await publish(page, "open");
  await expect(page.locator(".connection")).toContainText("다시 연결 중");
  renew(
    state,
    await page.evaluate(() => Date.now()),
    "스트림으로 재확인한 작업",
  );
  await publish(page, "snapshot", state);
  await expect(page.locator(".connection")).toContainText("중앙 시스템 연결됨");
});

test("HTTP timeouts and errors started before a valid SSE snapshot cannot overwrite the recovered connection", async ({
  page,
}) => {
  const now = Date.now();
  const state = fleet(now),
    delayed: Route[] = [];
  await page.clock.install({ time: now });
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    delayed.push(route);
  });
  await page.goto("/");
  await page.clock.runFor(10);
  await expect.poll(() => delayed.length).toBeGreaterThan(0);
  const initialRequests = delayed.length;
  await page.clock.fastForward(9_000);
  renew(
    state,
    await page.evaluate(() => Date.now()),
    "스트림으로 확인한 최신 작업",
  );
  await publish(page, "snapshot", state);
  await expect(page.locator(".connection")).toContainText("중앙 시스템 연결됨");
  // The original HTTP read times out at 10 seconds, after SSE already recovered.
  await page.clock.fastForward(2_000);
  await expect(page.locator(".connection")).toContainText("중앙 시스템 연결됨");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.clock.fastForward(8_000);
  await expect.poll(() => delayed.length).toBe(initialRequests + 1);
  await expect(page.locator(".connection")).toContainText("다시 연결 중");
  renew(
    state,
    await page.evaluate(() => Date.now()),
    "스트림으로 다시 확인한 작업",
  );
  // The request and valid snapshot can share a clock tick; receipt order matters.
  await publish(page, "snapshot", state);
  await delayed
    .at(-1)!
    .fulfill({
      status: 503,
      json: { error: { message: "이전 HTTP 조회의 늦은 실패" } },
    });
  await expect(page.locator(".connection")).toContainText("중앙 시스템 연결됨");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "＋ 목표 등록", exact: true }),
  ).toBeEnabled();
  // A failure without a newer valid report still disables commands and shows its reason.
  const previousRequests = delayed.length;
  await page.clock.fastForward(10_000);
  await expect.poll(() => delayed.length).toBe(previousRequests + 1);
  await delayed
    .at(-1)!
    .fulfill({
      status: 503,
      json: { error: { message: "현재 현황 조회 실패" } },
    });
  await expect(page.locator(".connection")).toContainText("다시 연결 중");
  await expect(page.getByRole("alert")).toContainText("현재 현황 조회 실패");
});
