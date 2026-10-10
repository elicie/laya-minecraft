import { test, expect, type Page } from "@playwright/test";
import {
  DEFAULT_RULES,
  GoalInputSchema,
  type Agent,
  type CommandReceipt,
  type FleetSnapshot,
  type GoalDefinition,
  type Goal,
  type Task,
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
        if (start) await expect(page.locator("iframe")).toHaveCount(0);
        const receipt: CommandReceipt = {
          id: `viewer-${operations.length}`,
          type: "viewer",
          state: start ? "applying" : "applied",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await route.fulfill({ json: receipt });
        if (start)
          await page.evaluate(
            (value) =>
              (window as unknown as BrowserHarness).sendFleet(
                "command",
                JSON.parse(value),
              ),
            JSON.stringify({ ...receipt, state: "applied" }),
          );
        return;
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
    await page
      .getByRole("button", { name: "요청 알림 닫기", exact: true })
      .last()
      .click();
    await expect(page.locator("iframe")).toHaveCount(1);
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
  await expect(page.getByLabel("건설 위치", { exact: false })).toHaveValue(
    "fixed",
  );
  await expect(
    page
      .getByRole("group", { name: "건물 시작 좌표", exact: true })
      .getByLabel("X", { exact: true }),
  ).toHaveValue("10");
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
  expect(submitted[0]!.params.origin).toEqual({ x: 10, y: 64, z: 10 });

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

test("construction chooses nearby land without an invented origin and validates fixed coordinates", async ({
  page,
}) => {
  const state = snapshot();
  state.rules.center = null;
  state.rules.warehouse = null;
  const submitted: GoalDefinition[] = [];
  let interpretations = 0;
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/snapshot")) return route.fulfill({ json: state });
    if (path.endsWith("/goals/interpret")) {
      interpretations++;
      return route.fulfill({
        json: {
          source: "code",
          warnings: [],
          goal: GoalInputSchema.parse({
            kind: "build",
            title: "공동 창고 건설",
            params: {
              blueprint: "warehouse",
              ...(interpretations === 3
                ? { position: { x: -20, y: 66, z: 5 } }
                : {}),
            },
          }),
        },
      });
    }
    if (path.endsWith("/goals"))
      submitted.push(route.request().postDataJSON() as GoalDefinition);
    return route.fulfill({
      json: {
        id: `build-command-${submitted.length}`,
        type: "goal.create",
        state: "applied",
        createdAt: 10,
        updatedAt: 12,
      },
    });
  });
  await page.goto("/");
  async function preview() {
    await page
      .getByRole("button", { name: "＋ 목표 등록", exact: true })
      .click();
    await page.getByLabel("무엇을 할까요?").fill("공동 창고 지어 줘");
    await page.getByRole("button", { name: "목표 해석", exact: true }).click();
  }
  async function register() {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "목표 등록", exact: true })
      .click();
  }
  await preview();
  await expect(page.getByLabel("건설 위치", { exact: false })).toHaveValue(
    "nearby",
  );
  await expect(
    page.getByRole("group", { name: "건물 시작 좌표", exact: true }),
  ).toHaveCount(0);
  await register();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted[0]!.params.siteSelection).toBe("nearby");
  expect(submitted[0]!.params.origin).toBeUndefined();
  expect(submitted[0]!.params.position).toBeUndefined();

  await preview();
  await page.getByLabel("건설 위치", { exact: false }).selectOption("fixed");
  const coordinates = page.getByRole("group", {
    name: "건물 시작 좌표",
    exact: true,
  });
  for (const axis of ["X", "Y", "Z"])
    await expect(coordinates.getByLabel(axis, { exact: true })).toHaveValue("");
  await coordinates.getByLabel("X", { exact: true }).fill("12.5");
  await coordinates.getByLabel("Y", { exact: true }).fill("67");
  await coordinates.getByLabel("Z", { exact: true }).fill("-8");
  await register();
  expect(submitted).toHaveLength(1);
  await expect(page.getByRole("alert")).toContainText(
    "건물 시작 좌표 X, Y, Z에 정수를 모두 입력하세요.",
  );
  await coordinates.getByLabel("X", { exact: true }).fill("12");
  await coordinates.getByLabel("Y", { exact: true }).fill("");
  await register();
  expect(submitted).toHaveLength(1);
  expect(
    await coordinates
      .getByLabel("Y", { exact: true })
      .evaluate((element: HTMLInputElement) => element.validity.valueMissing),
  ).toBe(true);
  await coordinates.getByLabel("Y", { exact: true }).fill("67");
  await register();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted[1]!.params).toMatchObject({
    siteSelection: "fixed",
    origin: { x: 12, y: 67, z: -8 },
  });

  await preview();
  await expect(page.getByLabel("건설 위치", { exact: false })).toHaveValue(
    "fixed",
  );
  for (const [axis, value] of [
    ["X", "-20"],
    ["Y", "66"],
    ["Z", "5"],
  ])
    await expect(coordinates.getByLabel(axis!, { exact: true })).toHaveValue(
      value!,
    );
  await register();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submitted[2]!.params).toMatchObject({
    siteSelection: "fixed",
    origin: { x: -20, y: 66, z: 5 },
  });
  expect(submitted[2]!.params.position).toBeUndefined();
});

test("an idle bot shows its latest construction wait reason instead of completed work and keeps emergency and survival reports first", async ({
  page,
}) => {
  let state = snapshot();
  const now = Date.now();
  const hunter = state.agents[0]!;
  hunter.session!.report!.mode = "idle";
  hunter.session!.report!.action = "idle";
  hunter.session!.report!.reason = "이전 건설 작업을 마쳤습니다.";
  hunter.session!.report!.currentAttemptId = "old-attempt";
  const goal: Goal = {
    id: "warehouse-goal",
    input: GoalInputSchema.parse({
      kind: "build",
      preferredBotId: hunter.id,
      params: { blueprint: "warehouse", siteSelection: "nearby" },
    }),
    title: "공동 창고 건설",
    state: "condition-wait",
    taskIds: ["wait-task"],
    createdAt: now - 1000,
    updatedAt: now,
    generation: 2,
    progress: { current: 0 },
    reason: "건설에 적합한 부지를 기다립니다.",
  };
  const task: Task = {
    id: "wait-task",
    goalId: goal.id,
    generation: 2,
    kind: "build",
    params: {},
    dependencies: [],
    completion: { kind: "manual", reason: "건물 상태 확인" },
    reservationKeys: [],
    state: "condition-wait",
    attemptId: "wait-attempt",
    retryCount: 0,
    resumeCount: 1,
    checkpoint: {},
    progress: 0,
    createdAt: now - 1000,
    updatedAt: now,
    reason: "건설 위치 아래에 지지할 지면이 없습니다.",
  };
  state.goals = [
    goal,
    {
      ...goal,
      id: "old-goal",
      title: "이전 집 건설",
      state: "completed",
      generation: 1,
      taskIds: ["old-task"],
    },
    {
      ...goal,
      id: "other-goal",
      title: "농부의 건설",
      input: { ...goal.input, preferredBotId: "Farmer" },
      taskIds: ["other-task"],
    },
  ];
  state.tasks = [
    task,
    {
      ...task,
      id: "old-task",
      goalId: "old-goal",
      generation: 1,
      state: "completed",
      attemptId: "old-attempt",
      reason: "이전 집을 완성했습니다.",
      updatedAt: now + 1000,
    },
    {
      ...task,
      id: "outdated-task",
      generation: 1,
      reason: "이전 좌표에서 다시 건설합니다.",
      updatedAt: now + 2000,
    },
    {
      ...task,
      id: "other-task",
      goalId: "other-goal",
      attemptId: undefined,
      affinityBotId: "Farmer",
      reason: "다른 봇의 작업 대기입니다.",
      updatedAt: now + 3000,
    },
  ];
  state.attempts = [
    {
      id: "old-attempt",
      taskId: "old-task",
      botId: hunter.id,
      sessionId: hunter.session!.id,
      controllerEpoch: state.controllerEpoch,
      reason: "initial",
      state: "completed",
      assignedAt: now - 3000,
      finishedAt: now - 2000,
    },
    {
      id: "wait-attempt",
      taskId: task.id,
      botId: hunter.id,
      sessionId: hunter.session!.id,
      controllerEpoch: state.controllerEpoch,
      reason: "initial",
      state: "completed",
      assignedAt: now - 1000,
      finishedAt: now,
    },
  ];
  await installStream(page);
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/snapshot")
        ? state
        : {
            id: "viewer-wait",
            type: "viewer.start",
            state: "applied",
            createdAt: now,
            updatedAt: now,
          },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Hunter 상세 보기", exact: true })
    .click();
  const detail = page.getByRole("region", { name: "Hunter 상세 상태" });
  await expect(detail).toContainText("대기 중 목표 · 공동 창고 건설");
  await expect(detail.locator(".current-action")).toHaveText("건설 조건 대기");
  await expect(detail).toContainText(
    "건설 위치 아래에 지지할 지면이 없습니다.",
  );
  for (const old of [
    "이전 건설 작업을 마쳤습니다.",
    "이전 집 건설",
    "이전 좌표에서 다시 건설합니다.",
    "다른 봇의 작업 대기입니다.",
  ])
    await expect(detail).not.toContainText(old);
  async function sendState() {
    state = { ...state, revision: state.revision + 1, updatedAt: Date.now() };
    await page.evaluate(
      (value) =>
        (window as unknown as BrowserHarness).sendFleet(
          "snapshot",
          JSON.parse(value),
        ),
      JSON.stringify(state),
    );
  }
  task.state = "retry-wait";
  task.reason = "지면 상태를 다시 확인한 후 재시도합니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText(
    "건설 재시도 대기",
  );
  await expect(detail).toContainText(task.reason);
  task.state = "held";
  task.reason = "건설 재시도 횟수를 모두 사용했습니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("건설 보류");
  await expect(detail).toContainText(task.reason);
  const waitingAttempt = state.attempts.find(
    (attempt) => attempt.id === "wait-attempt",
  )!;
  waitingAttempt.botId = "Farmer";
  waitingAttempt.sessionId = state.agents[1]!.session!.id;
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("작업 대기");
  await expect(detail).not.toContainText("대기 중 목표 · 공동 창고 건설");
  await expect(detail).not.toContainText(task.reason);
  task.affinityBotId = hunter.id;
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("건설 보류");
  await expect(detail).toContainText(task.reason);
  delete task.affinityBotId;
  waitingAttempt.botId = hunter.id;
  waitingAttempt.sessionId = hunter.session!.id;
  hunter.session!.report!.mode = "survival";
  hunter.session!.report!.action = "collect";
  hunter.session!.report!.reason =
    "체력이 낮아 회복을 위해 먹을 것을 찾습니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("수집");
  await expect(detail).toContainText(hunter.session!.report!.reason);
  await expect(detail).toContainText("등록된 목표 · 공동 창고 건설");
  await expect(detail).toContainText("생존 유지 중");
  await expect(detail).not.toContainText("대기 중 작업");
  await expect(detail).not.toContainText(task.reason);
  hunter.session!.report!.action = "idle";
  hunter.session!.report!.reason =
    "안전한 장소에서 체력이 회복되기를 기다립니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("생존 유지");
  await expect(detail).toContainText(hunter.session!.report!.reason);
  await expect(detail).not.toContainText("건설 보류");
  hunter.session!.report!.mode = "emergency";
  hunter.session!.report!.action = "counterattack";
  hunter.session!.report!.reason =
    "공격받아 반격하며 동료의 지원을 기다립니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("반격");
  await expect(detail).toContainText(hunter.session!.report!.reason);
  await expect(detail).not.toContainText("대기 중 목표");
  hunter.session!.report!.mode = "idle";
  hunter.session!.report!.action = "idle";
  hunter.session!.report!.reason = "다음 목표를 기다립니다.";
  goal.state = "completed";
  task.state = "completed";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("작업 대기");
  await expect(detail).toContainText("다음 목표를 기다립니다.");
  await expect(detail).not.toContainText("공동 창고 건설");
});

test("site preparation reports real edits and materials before a separate warehouse construction stage", async ({
  page,
}) => {
  let state = snapshot();
  const now = Date.now();
  const builder = agent("Builder", "builder");
  builder.config.allowedActions = ["build", "explore"];
  builder.session!.report!.capabilities = ["build", "explore"];
  builder.session!.report!.mode = "working";
  builder.session!.report!.action = "explore";
  builder.session!.report!.reason = "창고를 지을 자연 지형을 관측합니다.";
  state.agents = [builder];
  const goal: Goal = {
    id: "staged-warehouse",
    input: GoalInputSchema.parse({
      kind: "build",
      params: { blueprint: "warehouse", siteSelection: "nearby" },
      preferredBotId: builder.id,
    }),
    title: "창고와 진입로 건설",
    state: "active",
    generation: 1,
    taskIds: ["site-search"],
    createdAt: now,
    updatedAt: now,
    progress: { current: 0, target: 1 },
  };
  const search: Task = {
    id: "site-search",
    goalId: goal.id,
    kind: "explore",
    params: { mode: "build-site", design: "warehouse", allowPreparation: true },
    generation: 1,
    dependencies: [],
    completion: { kind: "exploration", resourceNames: [], minVisits: 1 },
    reservationKeys: [],
    state: "running",
    attemptId: "search-attempt",
    retryCount: 0,
    resumeCount: 0,
    checkpoint: {},
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
  state.goals = [goal];
  state.tasks = [search];
  function activate(task: Task) {
    builder.session!.activeAttemptId = task.attemptId;
    builder.session!.report!.currentAttemptId = task.attemptId;
    state.attempts.push({
      id: task.attemptId!,
      taskId: task.id,
      botId: builder.id,
      sessionId: builder.session!.id,
      controllerEpoch: state.controllerEpoch,
      reason: "initial",
      state: "running",
      assignedAt: now,
      startedAt: now,
    });
  }
  activate(search);
  await installStream(page);
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/snapshot")
        ? state
        : {
            id: "viewer-stage",
            type: "viewer.start",
            state: "applied",
            createdAt: now,
            updatedAt: now,
          },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Builder 상세 보기", exact: true })
    .click();
  const detail = page.getByRole("region", { name: "Builder 상세 상태" });
  const goalCard = page.locator(".goal-row");
  await expect(detail.locator(".current-action")).toHaveText("건설 부지 탐색");
  await expect(detail).toContainText(builder.session!.report!.reason);
  const preparation = {
    origin: { x: 56, y: 70, z: 8 },
    design: "warehouse",
    entrance: { x: 59, y: 70, z: 7 },
    near: { x: 60, y: 70, z: 9 },
    observedAt: now,
    edits: [
      { position: { x: 56, y: 70, z: 8 }, before: "dirt", after: "air" },
      { position: { x: 57, y: 70, z: 8 }, before: "stone", after: "air" },
      { position: { x: 56, y: 69, z: 9 }, before: "air", after: "dirt" },
    ],
    path: [
      { x: 60, y: 70, z: 8 },
      { x: 59, y: 70, z: 7 },
    ],
  };
  const progress = {
    stage: "excavate",
    completedEdits: 1,
    totalEdits: 3,
    excavated: 1,
    filled: 0,
    pathIndex: 0,
    pathLength: 2,
  };
  const prepare: Task = {
    ...search,
    id: "prepare-plot",
    kind: "build",
    params: { mode: "prepare-site", design: "warehouse", preparation },
    generation: 2,
    completion: { kind: "exploration", resourceNames: [], minVisits: 1 },
    attemptId: "prepare-attempt",
    checkpoint: {
      buildSitePreparation: preparation,
      preparationProgress: progress,
    },
  };
  search.state = "completed";
  goal.generation = 2;
  goal.taskIds = [prepare.id];
  goal.input.params.siteSelection = "preparing";
  goal.input.params.sitePreparation = preparation;
  state.tasks.push(prepare);
  activate(prepare);
  builder.session!.report!.action = "build";
  builder.session!.report!.reason = "자연 지형을 파서 창고 부지를 정리합니다.";
  async function sendState() {
    state = { ...state, revision: state.revision + 1, updatedAt: Date.now() };
    builder.session!.lastReportAt = Date.now();
    await page.evaluate(
      (value) =>
        (window as unknown as BrowserHarness).sendFleet(
          "snapshot",
          JSON.parse(value),
        ),
      JSON.stringify(state),
    );
  }
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("부지 정리");
  await expect(detail).toContainText("현재 작업 · 부지 정리 · 수행 중");
  const progressCard = detail.getByRole("region", {
    name: "부지 정리 진행",
    exact: true,
  });
  await expect(progressCard).toContainText("땅 파기");
  await expect(progressCard).toContainText("1 / 3칸");
  await expect(progressCard).toContainText("굴착 확인1칸");
  await expect(progressCard).toContainText("메우기 확인0칸");
  await expect(progressCard).toContainText("0 / 2지점");
  builder.session!.report!.action = "부지 정리";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("부지 정리");
  builder.session!.report!.mode = "survival";
  builder.session!.report!.action = "collect";
  builder.session!.report!.reason =
    "체력 회복에 필요한 식량을 먼저 확보합니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("수집");
  await expect(detail).toContainText(builder.session!.report!.reason);
  await expect(progressCard).toHaveCount(0);
  builder.session!.report!.mode = "emergency";
  builder.session!.report!.action = "counterattack";
  builder.session!.report!.reason = "작업 중 공격받아 반격합니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("반격");
  await expect(progressCard).toHaveCount(0);
  builder.session!.report!.mode = "idle";
  builder.session!.report!.action = "idle";
  builder.session!.report!.reason = "다음 작업 조건을 기다립니다.";
  builder.session!.activeAttemptId = undefined;
  builder.session!.report!.currentAttemptId = undefined;
  prepare.state = "condition-wait";
  prepare.reason = "빈 지면을 메울 흙을 확보해야 합니다.";
  prepare.checkpoint.waitingFor = {
    kind: "inventory",
    causeCode: "BUILD_MATERIAL",
    item: "dirt",
    minimum: 3,
  };
  progress.stage = "fill";
  progress.excavated = 2;
  progress.completedEdits = 2;
  goal.state = "condition-wait";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText(
    "부지 정리 조건 대기",
  );
  await expect(progressCard).toContainText("지면 메우기");
  await expect(progressCard).toContainText("2 / 3칸");
  await expect(progressCard).toContainText("흙 3개 보유 필요");
  await expect(detail).toContainText(prepare.reason);
  prepare.state = "completed";
  progress.stage = "verify";
  progress.completedEdits = 3;
  progress.filled = 1;
  progress.pathIndex = 2;
  goal.state = "active";
  builder.session!.report!.reason =
    "부지 정리 결과를 확인했습니다. 건설 배정을 기다립니다.";
  await sendState();
  await expect(goalCard.locator(".goal-row-top .tag")).toHaveText("진행 중");
  await expect(detail.locator(".current-action")).toHaveText("작업 대기");
  await goalCard.locator(".task-plan summary").click();
  await expect(goalCard.locator(".task-plan li > span").first()).toHaveText(
    "부지 정리",
  );
  await expect(
    goalCard.getByRole("region", { name: "부지 정리 진행", exact: true }),
  ).toContainText("3 / 3칸");
  await expect(goalCard).toContainText(
    "부지 정리 결과를 확인했습니다. 건물 완성은 별도로 확인합니다.",
  );
  await expect(
    goalCard.getByRole("region", { name: "부지 정리 진행", exact: true }),
  ).not.toContainText("자재 대기");
  const construct: Task = {
    ...prepare,
    id: "warehouse-build",
    generation: 3,
    params: { blueprint: "warehouse", origin: preparation.origin },
    checkpoint: {},
    state: "running",
    attemptId: "warehouse-attempt",
    reason: undefined,
  };
  goal.generation = 3;
  goal.taskIds = [construct.id];
  goal.input.params.siteSelection = "fixed";
  delete goal.input.params.sitePreparation;
  state.tasks.push(construct);
  activate(construct);
  builder.session!.report!.mode = "working";
  builder.session!.report!.action = "build";
  builder.session!.report!.reason = "확인된 부지에 창고의 벽을 설치합니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("창고 건축");
  await expect(detail).toContainText(builder.session!.report!.reason);
  await expect(progressCard).toHaveCount(0);
  await expect(goalCard.locator(".task-plan li > span").first()).toHaveText(
    "창고 건축",
  );
  await expect(goalCard.locator(".goal-row-top .tag")).toHaveText("진행 중");
  construct.state = "completed";
  goal.state = "completed";
  goal.progress.current = 1;
  builder.session!.report!.mode = "idle";
  builder.session!.report!.action = "idle";
  builder.session!.report!.reason = "창고 건물의 완성 상태를 확인했습니다.";
  await sendState();
  await expect(goalCard.locator(".goal-row-top .tag")).toHaveText("완료");
});
