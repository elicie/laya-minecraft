import { test, expect, type Page } from "@playwright/test";
import {
  DEFAULT_RULES,
  GoalInputSchema,
  type Agent,
  type CommandReceipt,
  type FleetSnapshot,
  type GoalDefinition,
} from "../../packages/contracts/src";

function agent(id: string, role: string): Agent {
  const now = Date.now();
  return {
    id,
    config: {
      name: id,
      role,
      enabled: true,
      allowedActions: ["collect", "store", "guard", "hunt"],
      connection: { host: "127.0.0.1", port: 25566, auth: "offline" },
    },
    pendingCommandIds: [],
    createdAt: now,
    updatedAt: now,
    status: "ready",
    viewer: { state: "stopped" },
    session: {
      id: `${id}-session`,
      state: "ready",
      lastReportAt: now,
      rulesVersion: 1,
      report: {
        ready: true,
        world: "127.0.0.1:25566",
        dimension: "overworld",
        position: { x: id === "Hunter" ? 5 : -10, y: 64, z: 8 },
        health: 18,
        food: 17,
        inventory: [{ name: "oak_log", count: 10 }],
        action: "collect",
        reason: "공동 창고에 필요한 원목을 확보합니다.",
        mode: "working",
        capabilities: ["collect", "store", "guard", "hunt"],
        rulesVersion: 1,
      },
    },
  };
}

function snapshot(): FleetSnapshot {
  return {
    schemaVersion: 1,
    controllerEpoch: "test-only",
    revision: 1,
    updatedAt: Date.now(),
    rules: {
      ...DEFAULT_RULES,
      world: "127.0.0.1:25566",
      center: { x: 0, y: 64, z: 0 },
      warehouse: {
        id: "shared",
        world: "127.0.0.1:25566",
        dimension: "overworld",
        position: { x: 2, y: 64, z: 2 },
      },
    },
    agents: [agent("Hunter", "hunter"), agent("Farmer", "farmer")],
    goals: [],
    tasks: [],
    attempts: [],
    reservations: [],
    observations: [],
    events: [],
  };
}

type BrowserHarness = { sendFleet: (kind: string, value: unknown) => void };
async function installStream(page: Page) {
  await page.addInitScript(() => {
    const streams = new Set<MockStream>();
    class MockStream extends EventTarget {
      onerror: ((event: Event) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      constructor() {
        super();
        streams.add(this);
        setTimeout(() => {
          if (streams.has(this)) this.onopen?.(new Event("open"));
        }, 0);
      }
      close() {
        streams.delete(this);
      }
    }
    Object.defineProperty(window, "EventSource", { value: MockStream });
    (window as unknown as BrowserHarness).sendFleet = (kind, value) => {
      for (const stream of streams)
        stream.dispatchEvent(
          new MessageEvent(kind, { data: JSON.stringify(value) }),
        );
    };
  });
}

test("natural language is previewed and edited before registration; applied receipts stay applied", async ({
  page,
}) => {
  let state = snapshot();
  let submitted: GoalDefinition | undefined;
  await installStream(page);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/snapshot")) return route.fulfill({ json: state });
    if (path.endsWith("/goals/interpret"))
      return route.fulfill({
        json: {
          source: "code",
          warnings: [],
          goal: GoalInputSchema.parse({
            kind: "collect",
            item: "oak_log",
            quantity: 32,
            title: "원목 32개 수집",
          }),
        },
      });
    if (path.endsWith("/goals")) {
      submitted = route.request().postDataJSON() as GoalDefinition;
      expect(route.request().headers()["x-laya-control"]).toBe("1");
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      const applied: CommandReceipt = {
        id: "goal-command",
        type: "goal.create",
        state: "applied",
        createdAt: 10,
        updatedAt: 12,
      };
      await page.evaluate(
        (value) =>
          (window as unknown as BrowserHarness).sendFleet(
            "command",
            JSON.parse(value),
          ),
        JSON.stringify(applied),
      );
      return route.fulfill({
        json: { ...applied, state: "accepted", updatedAt: 11 },
      });
    }
    return route.fulfill({
      json: {
        id: "goal-command",
        type: "goal.create",
        state: "applied",
        createdAt: 10,
        updatedAt: 12,
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("중앙 시스템 연결됨");
  await page.getByRole("button", { name: "＋ 목표 등록", exact: true }).click();
  await page.getByLabel("무엇을 할까요?").fill("원목 32개 모아 줘");
  await page.getByRole("button", { name: "목표 해석", exact: true }).click();
  await expect(
    page.getByText("기존 재고를 포함한 총수량", { exact: true }),
  ).toHaveCount(1);
  expect(submitted).toBeUndefined();
  await page
    .getByRole("spinbutton", { name: "목표 수량", exact: true })
    .fill("40");
  await page.getByLabel("우선 수행할 봇").selectOption("Hunter");
  await page
    .getByRole("combobox", { name: /^완료 후/ })
    .selectOption("maintain");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "목표 등록", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted?.quantity).toBe(40);
  expect(submitted?.quantityMode).toBe("total");
  expect(submitted?.mode).toBe("maintain");
  expect(submitted?.preferredBotId).toBe("Hunter");
  expect(submitted?.executionMode).toBe("queued");
  await expect(page.getByText("적용 완료", { exact: true })).toBeVisible();
  await expect(page.getByText("요청 접수", { exact: true })).toHaveCount(0);
});

for (const nativeUuid of [true, false]) {
  test(`viewer selection and release work ${nativeUuid ? "with native UUIDs" : "without crypto.randomUUID (HTTP)"}`, async ({
    page,
  }) => {
    let state = snapshot();
    const operations: string[] = [];
    const requestIds: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (!nativeUuid)
      await page.addInitScript(() => {
        Object.defineProperty(globalThis.crypto, "randomUUID", {
          value: undefined,
        });
      });
    await installStream(page);
    await page.route("**/viewer/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<html><body>Test viewer</body></html>",
      }),
    );
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/snapshot")) return route.fulfill({ json: state });
      const viewer = path.match(/\/bots\/([^/]+)\/viewer$/);
      if (viewer) {
        requestIds.push(route.request().headers()["idempotency-key"] ?? "");
        const id = viewer[1]!,
          start = route.request().method() === "POST";
        operations.push(`${route.request().method()}:${id}`);
        state = {
          ...state,
          revision: state.revision + 1,
          updatedAt: Date.now(),
          agents: state.agents.map((bot) =>
            bot.id === id
              ? {
                  ...bot,
                  viewer: start
                    ? { state: "ready", port: 4100, prefix: `/viewer/${id}` }
                    : { state: "stopped" },
                }
              : bot,
          ),
        };
        await page.evaluate(
          (value) =>
            (window as unknown as BrowserHarness).sendFleet(
              "snapshot",
              JSON.parse(value),
            ),
          JSON.stringify(state),
        );
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
      return route.fulfill({ json: {} });
    });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Hunter 상세 보기", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Hunter 상세 보기", exact: true })
      .click();
    await expect(page.locator("iframe")).toHaveCount(1);
    await expect(page.locator("iframe")).toHaveAttribute(
      "src",
      "/viewer/Hunter/",
    );
    await expect(
      page.getByRole("region", { name: "Hunter 상세 상태" }),
    ).toContainText("공동 창고에 필요한 원목");
    await page
      .getByRole("button", { name: "Farmer 상세 보기", exact: true })
      .click();
    await expect(page.locator("iframe")).toHaveCount(1);
    await expect(page.locator("iframe")).toHaveAttribute(
      "src",
      "/viewer/Farmer/",
    );
    expect(operations).toEqual(["POST:Hunter", "DELETE:Hunter", "POST:Farmer"]);
    state = {
      ...state,
      revision: state.revision + 1,
      updatedAt: Date.now(),
      agents: state.agents.map((bot) =>
        bot.id === "Farmer"
          ? {
              ...bot,
              viewer: { state: "stopped" },
              session: { ...bot.session!, id: "Farmer-reconnected" },
            }
          : bot,
      ),
    };
    await page.evaluate(
      (value) =>
        (window as unknown as BrowserHarness).sendFleet(
          "snapshot",
          JSON.parse(value),
        ),
      JSON.stringify(state),
    );
    await expect
      .poll(
        () =>
          operations.filter((operation) => operation === "POST:Farmer").length,
      )
      .toBe(2);
    await expect(page.locator("iframe")).toHaveCount(1);
    await page
      .getByRole("button", { name: "봇 상세 닫기", exact: true })
      .click();
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect.poll(() => operations.at(-1)).toBe("DELETE:Farmer");
    await page
      .getByRole("button", { name: "Hunter 상세 보기", exact: true })
      .click();
    await expect(page.locator("iframe")).toHaveAttribute(
      "src",
      "/viewer/Hunter/",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect.poll(() => operations.at(-1)).toBe("DELETE:Hunter");
    for (const id of requestIds)
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    expect(new Set(requestIds).size).toBe(requestIds.length);
    expect(errors).toEqual([]);
  });
}

test("stale reports are labelled and cannot be shown as a live viewer", async ({
  page,
}) => {
  const state = snapshot();
  state.agents = [state.agents[0]!];
  state.agents[0]!.session!.lastReportAt = Date.now() - 12_000;
  state.agents[0]!.viewer = {
    state: "ready",
    port: 4100,
    prefix: "/viewer/Hunter",
  };
  let starts = 0;
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    if (route.request().method() === "POST") starts++;
    return route.fulfill({ json: state });
  });
  await page.goto("/");
  await expect(page.getByText("접속 이상", { exact: true })).toHaveCount(2);
  await page
    .getByRole("button", { name: "Hunter 상세 보기", exact: true })
    .click();
  await expect(
    page.getByText("지난 보고 상태", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(starts).toBe(0);
});

test("empty fleet guides setup and bot/rule mutations show request receipts", async ({
  page,
}) => {
  const state = snapshot();
  state.agents = [];
  state.rules.center = null;
  state.rules.warehouse = null;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/snapshot")) return route.fulfill({ json: state });
    calls.push({
      path,
      body: route.request().postDataJSON() as Record<string, unknown>,
    });
    return route.fulfill({
      json: {
        id: `command-${calls.length}`,
        type: path.endsWith("/bots") ? "bot.add" : "rules.update",
        state: "accepted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  });
  await page.goto("/");
  await expect(page.getByText("아직 등록된 봇이 없습니다")).toBeVisible();
  await page.getByRole("button", { name: "＋ 봇 추가", exact: true }).click();
  await page.getByLabel("봇 이름").fill("NewHunter");
  await page.getByLabel("주 역할").selectOption("hunter");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "봇 추가", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(calls[0]?.body.name).toBe("NewHunter");
  expect(calls[0]?.body.role).toBe("hunter");
  expect((calls[0]?.body.connection as { port: number }).port).toBe(25566);
  await expect(page.getByText("요청 접수", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "운영 규칙", exact: true }).click();
  await page.getByLabel("오류 최대 재시도").fill("4");
  await page
    .getByRole("button", { name: "규칙 적용 요청", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const rulesCall = calls.find((call) => call.path.endsWith("/rules"))!;
  expect((rulesCall.body.patch as { maxRetries: number }).maxRetries).toBe(4);
  expect(rulesCall.body.mode).toBe("queued");
});

test("narrow screen keeps controls reachable without document overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installStream(page);
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({ json: snapshot() }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "＋ 목표 등록", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-dashboard.png"),
    fullPage: true,
  });
  const geometry = await page.evaluate(() => ({
    width: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll("*")]
      .filter(
        (element) =>
          element.getBoundingClientRect().right > window.innerWidth + 1 &&
          getComputedStyle(element).overflowX !== "hidden",
      )
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        right: element.getBoundingClientRect().right,
      }))
      .slice(0, 12),
  }));
  expect(geometry.scroll <= geometry.width, JSON.stringify(geometry)).toBe(
    true,
  );
});

test("an idle stream with zero bots stays connected without new snapshots", async ({
  page,
}) => {
  const state = snapshot();
  state.agents = [];
  await page.clock.install();
  await installStream(page);
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: state }));
  await page.goto("/");
  await page.clock.runFor(10);
  await expect(page.getByRole("status")).toContainText("중앙 시스템 연결됨");
  await page.clock.fastForward(11_000);
  await expect(page.getByRole("status")).toContainText("중앙 시스템 연결됨");
});

test("long activity histories stay inside cards and keep narrow controls reachable", async ({
  page,
}, testInfo) => {
  const state = snapshot();
  const botId = "f296dc1e-7c8e-4217-ae09-7e841ff29a6f";
  state.agents = [agent(botId, "hunter")];
  state.agents[0]!.config.name = "Hunter";
  state.events = Array.from({ length: 80 }, (_, index) => ({
    id: `history-${index}`,
    time: Date.now() - (80 - index) * 1000,
    revision: index + 1,
    type: "command.applied",
    botId,
    message: `활동 ${index + 1} 확인: 공동 창고에 필요한 원목을 확보했습니다.`,
  }));
  await installStream(page);
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/snapshot")
        ? state
        : {
            id: "viewer-command",
            type: "viewer.start",
            state: "applied",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Hunter 상세 보기", exact: true })
    .click();
  const detail = page.getByRole("region", { name: "Hunter 상세 상태" });
  const botHistory = page.getByRole("region", {
    name: "최근 봇 활동 기록",
    exact: true,
  });
  const villageHistory = page.getByRole("region", {
    name: "마을 활동 기록",
    exact: true,
  });
  await expect(botHistory.locator("li")).toHaveCount(6);
  await expect(villageHistory.locator("li")).toHaveCount(6);
  await expect(botHistory.locator("li").first()).toContainText("활동 80 확인");
  await expect(page.locator("body")).not.toContainText(botId);
  await expect(page.locator("body")).not.toContainText("command.applied");
  const compactHeight = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  await detail
    .getByRole("button", { name: "전체 기록 80건 보기", exact: true })
    .click();
  await page
    .locator(".event-panel")
    .getByRole("button", { name: "전체 기록 80건 보기", exact: true })
    .click();
  await expect(botHistory.locator("li")).toHaveCount(80);
  await expect(villageHistory.locator("li")).toHaveCount(80);
  const geometry = await page.evaluate(() => ({
    pageHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    detailHeight: document.querySelector(".bot-detail")!.getBoundingClientRect()
      .height,
    logs: [...document.querySelectorAll<HTMLElement>(".activity-scroll")].map(
      (element) => ({
        height: element.clientHeight,
        contentHeight: element.scrollHeight,
        overflow: getComputedStyle(element).overflowY,
      }),
    ),
  }));
  expect(geometry.pageHeight, JSON.stringify(geometry)).toBeLessThan(2000);
  expect(geometry.pageHeight).toBeLessThanOrEqual(compactHeight + 80);
  expect(geometry.detailHeight).toBeLessThanOrEqual(
    Math.min(720, geometry.viewportHeight - 32),
  );
  for (const log of geometry.logs) {
    expect(log.height).toBeLessThanOrEqual(210);
    expect(log.contentHeight).toBeGreaterThan(log.height);
    expect(log.overflow).toBe("auto");
  }
  await villageHistory.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => villageHistory.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await detail.evaluate((element) => {
    element.scrollTop = 0;
  });
  await villageHistory.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath("compact-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const goalButton = detail.getByRole("button", {
    name: "이 봇으로 목표",
    exact: true,
  });
  await goalButton.scrollIntoViewIfNeeded();
  await expect(goalButton).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await goalButton.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("무엇을 할까요?").fill("원목 8개 모아 줘");
  await expect(page.getByLabel("무엇을 할까요?")).toHaveValue(
    "원목 8개 모아 줘",
  );
  await page.getByRole("dialog").getByLabel("닫기", { exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("compact-mobile.png"),
    fullPage: true,
  });
});

test("construction and harvest previews keep the edited plan and full destination", async ({
  page,
}) => {
  const state = snapshot();
  const submitted: GoalDefinition[] = [];
  let interpretations = 0;
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/snapshot")) return route.fulfill({ json: state });
    if (path.endsWith("/goals/interpret")) {
      interpretations++;
      const goal =
        interpretations === 1
          ? GoalInputSchema.parse({
              kind: "build",
              params: {
                design: "castle",
                origin: { x: 10, y: 64, z: 10 },
                requiredBlocks: [
                  { name: "cobblestone", position: { x: 10, y: 64, z: 10 } },
                ],
              },
            })
          : GoalInputSchema.parse({
              kind: "farm",
              quantity: 4,
              params: {
                mode: "harvest",
                crop: "wheat",
                origin: { x: 7, y: 63, z: 10 },
              },
              destination: {
                ...state.rules.warehouse!,
                position: { x: 20, y: 64, z: 20 },
              },
            });
      return route.fulfill({ json: { source: "code", warnings: [], goal } });
    }
    if (path.endsWith("/goals"))
      submitted.push(route.request().postDataJSON() as GoalDefinition);
    return route.fulfill({
      json: {
        id: `form-command-${submitted.length}`,
        type: "goal.create",
        state: "applied",
        createdAt: 10,
        updatedAt: 12,
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("중앙 시스템 연결됨");
  await page.getByRole("button", { name: "＋ 목표 등록", exact: true }).click();
  await page.getByLabel("무엇을 할까요?").fill("성 지어 줘");
  await page.getByRole("button", { name: "목표 해석", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /^건물 설계/ })).toHaveValue(
    "castle",
  );
  await page
    .getByRole("combobox", { name: /^건물 설계/ })
    .selectOption("cabin");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "목표 등록", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted[0]!.params.blueprint).toBe("cabin");
  expect(submitted[0]!.params.design).toBeUndefined();
  expect(submitted[0]!.params.requiredBlocks).toBeUndefined();

  await page.getByRole("button", { name: "＋ 목표 등록", exact: true }).click();
  await page.getByLabel("무엇을 할까요?").fill("밀 4개 수확해 줘");
  await page.getByRole("button", { name: "목표 해석", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: /^물품 목적지/ }),
  ).toHaveValue("custom");
  await page.getByLabel("작물", { exact: false }).selectOption("carrot");
  await page
    .getByRole("group", { name: "밭 중심 (급수 블록) 좌표", exact: true })
    .getByLabel("X", { exact: true })
    .fill("9");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "목표 등록", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted[1]!.params.crop).toBe("carrot");
  expect(submitted[1]!.params.origin).toEqual({ x: 9, y: 63, z: 10 });
  expect(submitted[1]!.quantity).toBe(4);
  expect(submitted[1]!.destination?.position).toEqual({ x: 20, y: 64, z: 20 });
});
