import { test, expect, type Page } from "@playwright/test";
import {
  AgentSchema,
  DEFAULT_RULES,
  FleetSnapshotSchema,
  type FleetSnapshot,
} from "../../packages/contracts/src";

type Harness = { sendFleet(kind: string, value?: unknown): void };
function snapshot(): FleetSnapshot {
  const now = Date.now();
  return FleetSnapshotSchema.parse({
    schemaVersion: 1,
    controllerEpoch: "viewer-controller",
    revision: 1,
    updatedAt: now,
    rules: DEFAULT_RULES,
    blueprints: [],
    goals: [],
    tasks: [],
    attempts: [],
    reservations: [],
    observations: [],
    events: [],
    agents: [
      AgentSchema.parse({
        id: "Observer",
        config: {
          name: "Observer",
          role: "builder",
          connection: { host: "127.0.0.1", port: 25566 },
        },
        createdAt: now,
        updatedAt: now,
        pendingCommandIds: [],
        status: "ready",
        viewer: { state: "stopped" },
        session: {
          id: "original-session",
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
            action: "idle",
            reason: "실제 보고를 확인했습니다.",
            mode: "idle",
            capabilities: ["build"],
            rulesVersion: 1,
          },
        },
      }),
    ],
  });
}
async function installStream(page: Page) {
  await page.addInitScript(() => {
    const streams = new Set<MockStream>();
    class MockStream extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        super();
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
    (window as unknown as Harness).sendFleet = (kind, value) => {
      for (const stream of streams) {
        if (kind === "disconnect") stream.onerror?.();
        else
          stream.dispatchEvent(
            new MessageEvent(kind, { data: JSON.stringify(value) }),
          );
      }
    };
  });
}
async function setup(page: Page) {
  const state = snapshot(),
    operations: string[] = [];
  let documents = 0;
  await installStream(page);
  const publish = async () => {
    state.revision++;
    state.updatedAt = Date.now();
    await page.evaluate(
      (value) =>
        (window as unknown as Harness).sendFleet("snapshot", JSON.parse(value)),
      JSON.stringify(state),
    );
  };
  await page.route("**/viewer/**", (route) => {
    documents++;
    return route.fulfill({
      contentType: "text/html",
      body: "<html><body>Observed terrain fixture</body></html>",
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/snapshot")) return route.fulfill({ json: state });
    if (path.endsWith("/viewer")) {
      const start = route.request().method() === "POST";
      operations.push(route.request().method());
      state.agents[0]!.viewer = start
        ? { state: "ready", prefix: "/viewer/Observer", port: 4100 }
        : { state: "stopped" };
      await publish();
      return route.fulfill({
        json: {
          id: `viewer-${operations.length}`,
          type: "viewer",
          state: "applied",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
    }
    throw new Error(`Unexpected fixture API ${path}`);
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Observer 상세 보기", exact: true })
    .click();
  await expect(page.locator("iframe.viewer")).toBeVisible();
  await expect.poll(() => documents).toBe(1);
  return { state, publish, operations, documentCount: () => documents };
}

test("a confirmed viewer survives report staleness and stream reconnect without another iframe navigation", async ({
  page,
}) => {
  const { state, publish, operations, documentCount } = await setup(page);
  const iframe = page.locator("iframe.viewer"),
    original = (await iframe.elementHandle())!;
  const sameFrame = () =>
    original.evaluate(
      (element) =>
        element.isConnected &&
        element === document.querySelector("iframe.viewer"),
    );
  const detail = page.getByRole("region", { name: "Observer 상세 상태" });
  for (let index = 0; index < 3; index++) await publish();
  expect(await sameFrame()).toBe(true);
  await page.evaluate(() =>
    (window as unknown as Harness).sendFleet("disconnect"),
  );
  await expect(page.locator(".connection")).toContainText("다시 연결 중");
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toBeHidden();
  await expect(iframe).toHaveAttribute("aria-hidden", "true");
  await expect(detail.getByRole("status")).toContainText(
    "봇 연결을 확인하고 있습니다",
  );
  await expect(
    detail.getByRole("button", { name: "역할 · 설정", exact: true }),
  ).toBeDisabled();
  expect(await sameFrame()).toBe(true);
  state.agents[0]!.session!.lastReportAt = Date.now();
  await publish();
  await expect(iframe).toBeVisible();
  expect(await sameFrame()).toBe(true);
  state.agents[0]!.session!.lastReportAt = Date.now() - 11_000;
  await publish();
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toBeHidden();
  await expect(detail.locator(".viewer-toolbar")).toContainText("지난 관전");
  expect(await sameFrame()).toBe(true);
  state.agents[0]!.session!.lastReportAt = Date.now();
  await publish();
  await expect(iframe).toBeVisible();
  expect(await sameFrame()).toBe(true);
  expect(documentCount()).toBe(1);
  expect(operations).toEqual(["POST"]);
  await detail.getByRole("button", { name: "관전 멈춤", exact: true }).click();
  await expect(iframe).toHaveCount(0);
  expect(await original.evaluate((element) => element.isConnected)).toBe(false);
  await detail.getByRole("button", { name: "관전 재개", exact: true }).click();
  await expect(iframe).toBeVisible();
  await expect.poll(documentCount).toBe(2);
  expect(operations).toEqual(["POST", "DELETE", "POST"]);
});

test("real stop, session and controller replacement discard the previously retained viewer", async ({
  page,
}) => {
  const { state, publish, documentCount } = await setup(page);
  const iframe = page.locator("iframe.viewer");
  const first = (await iframe.elementHandle())!;
  state.agents[0]!.viewer = { state: "stopping" };
  await publish();
  await expect(iframe).toHaveCount(0);
  expect(await first.evaluate((element) => element.isConnected)).toBe(false);
  // A new worker session must pass a new viewer-start receipt before it is displayed.
  state.agents[0]!.session!.id = "replacement-session";
  state.agents[0]!.viewer = { state: "stopped" };
  await publish();
  await expect(iframe).toBeVisible();
  await expect.poll(documentCount).toBe(2);
  const second = (await iframe.elementHandle())!;
  state.controllerEpoch = "replacement-controller";
  state.agents[0]!.viewer = { state: "stopping" };
  await publish();
  await expect(iframe).toHaveCount(0);
  expect(await second.evaluate((element) => element.isConnected)).toBe(false);
  state.agents[0]!.viewer = { state: "stopped" };
  await publish();
  await expect(iframe).toBeVisible();
  await expect.poll(documentCount).toBe(3);
});
