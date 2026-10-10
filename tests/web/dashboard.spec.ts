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
  type InventoryView,
  type RecoveryState,
} from "../../packages/contracts/src";
import {
  BlueprintInputSchema,
  type BlueprintDefinition,
  type BlueprintInput,
} from "../../packages/contracts/src/blueprint-catalog";

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
    blueprints: [],
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
      for (const stream of streams) {
        if (kind === "disconnect") {
          stream.onerror?.(new Event("error"));
          continue;
        }
        stream.dispatchEvent(
          new MessageEvent(kind, { data: JSON.stringify(value) }),
        );
      }
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

test("death recovery shows confirmed partial items, unavailable support and the preserved construction without masking urgent safety", async ({ page }) => {
  let state = snapshot();
  const now = Date.now(), hunter = state.agents[0]!, report = hunter.session!.report!;
  delete report.currentAttemptId;
  report.mode = "recovering"; report.action = "build"; report.reason = "사망 전의 오래된 건설 보고입니다."; report.ready = false; report.health = 0;
  const goal: Goal = {
    id: "preserved-warehouse", input: GoalInputSchema.parse({ kind: "build", preferredBotId: hunter.id, params: { blueprint: "warehouse", siteSelection: "fixed", origin: { x: 56, y: 70, z: 8 } } }),
    title: "보존된 공동 창고 건설", state: "condition-wait", taskIds: ["preserved-build"], generation: 2, createdAt: now - 2000, updatedAt: now, progress: { current: 0 }, reason: "기존 건설의 접근 경로를 다시 확인합니다.",
  };
  const task: Task = {
    id: "preserved-build", goalId: goal.id, generation: 2, kind: "build", params: { blueprint: "warehouse" }, dependencies: [], completion: { kind: "manual", reason: "실제 건물 확인" }, reservationKeys: [],
    state: "condition-wait", affinityBotId: hunter.id, retryCount: 0, resumeCount: 1, progress: 0.2, checkpoint: { placedBlocks: 7 }, createdAt: now - 2000, updatedAt: now,
    reason: "창고 입구로 가는 안전한 경로가 없어 지형 조건을 기다립니다.",
  };
  const recovery: RecoveryState = {
    deathId: "recovery-fixture", occurredAt: now - 1000, world: "127.0.0.1:25566", dimension: "overworld", position: { x: 56.25, y: 70, z: 8.5 }, priorInventory: [{ name: "cobblestone", count: 10 }],
    phase: "waiting-respawn", reason: "사망을 확인했습니다. 실제 부활 상태를 기다립니다.", attemptCount: 0, progress: { recoveredCount: 0, remainingCount: 10 }, safe: false, updatedAt: now, checkpoint: {},
  };
  hunter.recovery = recovery;
  report.recovery = structuredClone(recovery);
  state.goals = [goal]; state.tasks = [task];
  await installStream(page);
  await page.route("**/api/v1/**", route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/snapshot") ? state : { id: "recovery-viewer", type: "viewer.start", state: "applied", createdAt: now, updatedAt: now } }));
  await page.goto("/"); await page.getByRole("button", { name: "Hunter 상세 보기", exact: true }).click();
  const detail = page.getByRole("region", { name: "Hunter 상세 상태" }), card = detail.getByRole("region", { name: "사망과 복구 상태" });
  await expect(detail.locator(".current-action")).toHaveText("부활 대기");
  await expect(detail).not.toContainText("사망 전의 오래된 건설 보고입니다.");
  await expect(detail).toContainText("등록된 목표 · 보존된 공동 창고 건설");
  await expect(card).toContainText("보유·회수 확인 0개 · 미회수 10개");
  await expect(card).toContainText("X 56.3 · Y 70.0 · Z 8.5");
  await expect(detail).not.toContainText(task.reason!);
  async function send() {
    state = { ...state, revision: state.revision + 1, updatedAt: Date.now() };
    hunter.session!.lastReportAt = Date.now();
    await page.evaluate(value => (window as unknown as BrowserHarness).sendFleet("snapshot", JSON.parse(value)), JSON.stringify(state));
  }
  report.ready = true; report.health = 20; report.action = "사망 아이템 회수"; report.reason = "관측한 드롭으로 가는 안전한 지면을 확인합니다.";
  report.recovery = { ...recovery, phase: "recovering", reason: report.reason, attemptCount: 2, progress: { recoveredCount: 4, remainingCount: 6 }, updatedAt: now + 1 };
  await send();
  await expect(detail.locator(".current-action")).toHaveText("사망 아이템 회수");
  await expect(card).toContainText("아이템 회수 중");
  await expect(card).toContainText("보유·회수 확인 4개 · 미회수 6개");
  await expect(card).toContainText("회수 시도 2 / 5");
  report.mode = "emergency"; report.action = "지원·안전 경로 대기"; report.reason = "사망 위치 근처의 적 때문에 안전한 퇴각 경로와 지원이 필요합니다.";
  report.recovery = { ...report.recovery, phase: "held", reason: "근처 적이 있어 위험한 아이템 위치로 진입하지 않습니다.", updatedAt: now + 2 };
  state.events = [{ id: "unavailable-support", time: now + 2, revision: 2, type: "support.unavailable", botId: hunter.id, message: "현재 장비와 위치 조건을 만족하는 동료가 없습니다." }];
  await send();
  await expect(detail.locator(".current-action")).toHaveText("지원·안전 경로 대기");
  await expect(detail).toContainText(report.reason);
  await expect(card).toContainText("회수 조건 대기");
  await expect(card.locator(".support-status")).toContainText("지원 가능한 동료 없음");
  await expect(card.locator(".support-status")).toContainText(state.events[0]!.message);
  await expect(detail).not.toContainText(task.reason!);
  report.mode = "survival"; report.action = "식량 대기"; report.food = 6; report.reason = "부활 후 기본 생존을 위한 식량을 기다립니다.";
  await send();
  await expect(detail.locator(".current-action")).toHaveText("식량 대기");
  await expect(detail).toContainText(report.reason);
  await expect(detail).toContainText("생존 유지 중");
  report.mode = "idle"; report.food = 20; report.action = "idle"; report.reason = "확인한 회수 예산을 마쳤습니다.";
  report.recovery = { ...report.recovery!, phase: "resolved", safe: false, attemptCount: 5, reason: "안전한 회수 시도를 마쳤습니다. 미회수 물자는 다시 준비해야 합니다.", progress: { recoveredCount: 4, remainingCount: 6, lostCount: 6 }, updatedAt: now + 3 };
  hunter.recovery = structuredClone(report.recovery);
  await send();
  await expect(card).toContainText("회수 확인 종료");
  await expect(card).toContainText("현재 위치 안전 확인 대기");
  await expect(detail).not.toContainText(task.reason!);
  hunter.recovery = { ...hunter.recovery, safe: true, updatedAt: now + 4 }; report.recovery = structuredClone(hunter.recovery);
  await send();
  await expect(detail.locator(".current-action")).toHaveText("건설 조건 대기");
  await expect(detail).toContainText(task.reason!);
  await expect(card).toContainText("보유·회수 확인 4개 · 미회수 6개");
  await expect(card).toContainText("미회수 물자는 실제 재고를 확인한 뒤 다시 준비합니다.");
  await expect(card.locator(".support-status")).toHaveCount(0);
  await expect(detail).toContainText("대기 중 목표 · 보존된 공동 창고 건설");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await expect(card).toContainText("회수 시도 5 / 5");
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
  hunter.session!.report!.mode = "idle";
  delete hunter.session!.report!.currentAttemptId;
  hunter.session!.report!.action = "식량 확보 · 자원 탐색";
  hunter.session!.report!.reason = "안전한 지상 이동 2/5 → 새 식량을 재관측합니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("식량 확보 · 자원 탐색");
  await expect(detail).toContainText(hunter.session!.report!.reason);
  await expect(detail).toContainText("등록된 목표 · 공동 창고 건설");
  await expect(detail).not.toContainText(task.reason);
  await expect(detail).not.toContainText("대기 중 작업");
  await expect(detail).not.toContainText("생존 유지 중");
  task.state = "condition-wait";
  task.reason = "조약돌 자원으로 가는 안전한 접근 경로가 없습니다.";
  hunter.session!.report!.health = 20;
  hunter.session!.report!.food = 17;
  hunter.session!.report!.action = "식량 대기";
  hunter.session!.report!.reason = "안전한 이동 5회를 마쳤습니다. 실제 식량이나 작물의 변화를 기다립니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("건설 조건 대기");
  await expect(detail).toContainText("대기 중 목표 · 공동 창고 건설");
  await expect(detail).toContainText(task.reason);
  await expect(detail.locator(".local-food-wait")).toHaveText(
    `식량 대기 · ${hunter.session!.report!.reason}`,
  );
  await expect(detail).not.toContainText("식량 확보 · 자원 탐색");
  hunter.session!.report!.mode = "survival";
  hunter.session!.report!.food = 6;
  hunter.session!.report!.reason = "허기가 낮아 기본 생존을 위한 식량 조건을 기다립니다.";
  await sendState();
  await expect(detail.locator(".current-action")).toHaveText("식량 대기");
  await expect(detail).toContainText(hunter.session!.report!.reason);
  await expect(detail).not.toContainText(task.reason);
  await expect(detail.locator(".local-food-wait")).toHaveCount(0);
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

test("a copied blueprint is saved after application, selected for a goal, edited and deleted without changing the registered goal", async ({
  page,
}) => {
  let state = snapshot();
  const blueprintId = "11111111-1111-4111-8111-111111111111";
  let submitted: BlueprintInput | undefined;
  let submittedGoal: GoalDefinition | undefined;
  let created: BlueprintDefinition | undefined;
  let applied = false;
  const mutations: string[] = [];
  const now = Date.now();
  const createReceipt: CommandReceipt = {
    id: "blueprint-create",
    type: "blueprint.create",
    state: "accepted",
    createdAt: now,
    updatedAt: now,
  };
  const touch = () => {
    state = { ...state, revision: state.revision + 1, updatedAt: Date.now() };
  };
  async function send(kind: string, value: unknown) {
    await page.evaluate(
      ({ kind, value }) =>
        (window as unknown as BrowserHarness).sendFleet(kind, value),
      { kind, value },
    );
  }
  await installStream(page);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method !== "GET") {
      expect(route.request().headers()["x-laya-control"]).toBe("1");
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    }
    if (path.endsWith("/snapshot")) return route.fulfill({ json: state });
    if (path.endsWith("/commands/blueprint-create"))
      return route.fulfill({
        json: applied
          ? {
              ...createReceipt,
              state: "applied",
              result: { blueprintId, version: 1 },
            }
          : createReceipt,
      });
    if (path.endsWith("/blueprints") && method === "POST") {
      submitted = BlueprintInputSchema.parse(route.request().postDataJSON());
      mutations.push(path);
      created = {
        ...submitted,
        id: blueprintId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      return route.fulfill({ json: createReceipt });
    }
    if (path.endsWith(`/blueprints/${blueprintId}`) && method === "PATCH") {
      const input = BlueprintInputSchema.parse(route.request().postDataJSON());
      mutations.push(path);
      state.blueprints = [
        { ...created!, ...input, version: 2, updatedAt: Date.now() },
      ];
      touch();
      return route.fulfill({
        json: {
          ...createReceipt,
          id: "blueprint-update",
          type: "blueprint.update",
          state: "applied",
          result: { blueprintId, version: 2 },
        },
      });
    }
    if (path.endsWith(`/blueprints/${blueprintId}`) && method === "DELETE") {
      expect(route.request().postDataJSON()).toEqual({});
      mutations.push(path);
      state.blueprints = [];
      touch();
      return route.fulfill({
        json: {
          ...createReceipt,
          id: "blueprint-delete",
          type: "blueprint.delete",
          state: "applied",
          result: { blueprintId },
        },
      });
    }
    if (path.endsWith("/goals/interpret"))
      return route.fulfill({
        json: {
          source: "code",
          warnings: [],
          goal: GoalInputSchema.parse({
            kind: "build",
            title: "산책길 옆에 건물 짓기",
            params: { blueprint: "unregistered-palace" },
          }),
        },
      });
    if (path.endsWith("/goals") && method === "POST") {
      submittedGoal = GoalInputSchema.parse(route.request().postDataJSON());
      state.goals = [
        {
          id: "custom-building",
          input: {
            ...submittedGoal,
            params: {
              ...submittedGoal.params,
              blueprintDefinition: JSON.parse(JSON.stringify(created)),
            },
          },
          title: submittedGoal.title!,
          state: "queued",
          generation: 1,
          taskIds: [],
          createdAt: now,
          updatedAt: now,
          progress: { current: 0, target: 1 },
        },
      ];
      touch();
      return route.fulfill({
        json: {
          ...createReceipt,
          id: "custom-goal",
          type: "goal.create",
          state: "applied",
        },
      });
    }
    return route.fulfill({ json: { ...createReceipt, state: "applied" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "설계도 관리", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "설계도 관리", exact: true });
  await dialog
    .getByRole("button", { name: "창고 건물 복제", exact: true })
    .click();
  await dialog.getByLabel("설계도 이름", { exact: true }).fill("산책길 창고");
  await dialog.getByRole("spinbutton", { name: "세로", exact: true }).fill("7");
  await dialog.getByRole("spinbutton", { name: "높이", exact: true }).fill("3");
  await dialog
    .getByRole("combobox", { name: "목재 종류", exact: true })
    .selectOption("spruce");
  await dialog
    .getByRole("combobox", { name: "바닥", exact: true })
    .selectOption("stone_bricks");
  await dialog
    .getByRole("combobox", { name: "창문", exact: true })
    .selectOption("glass");
  await dialog.getByRole("checkbox", { name: "화로", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "침대", exact: true }).check();
  const preview = dialog.getByRole("region", {
    name: "설계도 미리보기",
    exact: true,
  });
  await expect(preview).toContainText("7 × 7 × 3칸");
  await expect(
    preview
      .locator(".blueprint-materials > div")
      .filter({ hasText: "석재 벽돌" }),
  ).toHaveText("석재 벽돌49개");
  await dialog
    .getByRole("button", { name: "새 설계도 저장", exact: true })
    .click();
  await expect(
    dialog.getByText("설계도 저장 · 요청 접수", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "적용 확인 중…", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "산책길 창고 수정", exact: true }),
  ).toHaveCount(0);
  expect(submitted).toMatchObject({
    title: "산책길 창고",
    template: "warehouse",
    width: 7,
    depth: 7,
    height: 3,
    wood: "spruce",
    materials: {
      floor: "stone_bricks",
      wall: "spruce_planks",
      roof: "spruce_planks",
      window: "glass",
    },
    furniture: { furnace: true, bed: true },
  });
  state.blueprints = [created!];
  touch();
  applied = true;
  await send("command", {
    ...createReceipt,
    state: "applied",
    updatedAt: Date.now(),
    result: { blueprintId, version: 1 },
  });
  await expect(
    dialog.getByRole("button", { name: "산책길 창고 수정", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "변경 저장", exact: true }),
  ).toBeEnabled();
  await dialog
    .locator(".dialog-heading")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page.getByRole("button", { name: "＋ 목표 등록", exact: true }).click();
  await page.getByLabel("무엇을 할까요?").fill("산책길 옆에 건물 지어줘");
  await page.getByRole("button", { name: "목표 해석", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "해석된 설계도가 목록에 없습니다",
  );
  await expect(page.getByLabel("건물 설계", { exact: false })).toHaveValue("");
  await page
    .getByLabel("건물 설계", { exact: false })
    .selectOption(blueprintId);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "목표 등록", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(submittedGoal?.params.blueprint).toBe(blueprintId);
  expect(submittedGoal?.params.blueprintDefinition).toBeUndefined();
  await send("snapshot", state);
  await expect(page.locator(".goal-row")).toContainText("설계 · 산책길 창고");
  await page.getByRole("button", { name: "설계도 관리", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "설계도 관리", exact: true });
  await dialog
    .getByRole("button", { name: "산책길 창고 수정", exact: true })
    .click();
  await dialog.getByLabel("설계도 이름", { exact: true }).fill("확장한 창고");
  await dialog.getByRole("spinbutton", { name: "가로", exact: true }).fill("9");
  await dialog
    .getByRole("combobox", { name: "벽", exact: true })
    .selectOption("bricks");
  await dialog.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "확장한 창고 수정", exact: true }),
  ).toBeVisible();
  expect(state.blueprints[0]).toMatchObject({
    version: 2,
    width: 9,
    materials: { wall: "bricks" },
  });
  await expect(page.locator(".goal-row")).toContainText("설계 · 산책길 창고");
  await dialog
    .getByRole("button", { name: "설계도 삭제", exact: true })
    .click();
  await expect(
    dialog.getByText("저장한 설계도가 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "확장한 창고 수정", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "설계도 삭제", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".goal-row")).toContainText("설계 · 산책길 창고");
  expect(mutations).toEqual([
    "/api/v1/blueprints",
    `/api/v1/blueprints/${blueprintId}`,
    `/api/v1/blueprints/${blueprintId}`,
  ]);
  await dialog
    .locator(".dialog-heading")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page.getByRole("button", { name: "＋ 목표 등록", exact: true }).click();
  await page.getByLabel("무엇을 할까요?").fill("건물 지어줘");
  await page.getByRole("button", { name: "목표 해석", exact: true }).click();
  await expect(
    page
      .getByLabel("건물 설계", { exact: false })
      .locator(`option[value="${blueprintId}"]`),
  ).toHaveCount(0);
  await page
    .getByLabel("건물 설계", { exact: false })
    .selectOption("warehouse");
  await expect(page.getByLabel("건물 설계", { exact: false })).toHaveValue(
    "warehouse",
  );
});

test("builtin blueprints can only be copied and template size rules stay usable on a narrow screen", async ({
  page,
}) => {
  const state = snapshot();
  let mutations = 0;
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    if (route.request().method() !== "GET") mutations++;
    return route.fulfill({ json: state });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "설계도 관리", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "설계도 관리", exact: true });
  for (const title of [
    "작은 나무집",
    "넓은 나무집",
    "창고 건물",
    "전망대",
    "짧은 다리",
    "성곽과 네 개의 탑",
  ])
    await expect(
      dialog.getByRole("button", { name: `${title} 복제`, exact: true }),
    ).toHaveCount(1);
  await expect(
    dialog.getByRole("button", { name: "설계도 삭제", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "성곽과 네 개의 탑 복제", exact: true })
    .click();
  for (const name of ["가로", "세로", "높이"])
    await expect(
      dialog.getByRole("spinbutton", { name, exact: true }),
    ).toBeDisabled();
  await expect(dialog).toContainText("재료와 가구는 변경할 수 있습니다");
  await dialog
    .getByRole("button", { name: "짧은 다리 복제", exact: true })
    .click();
  await expect(
    dialog.getByRole("spinbutton", { name: "높이", exact: true }),
  ).toHaveValue("1");
  await expect(
    dialog.getByRole("checkbox", { name: "상자", exact: true }),
  ).toBeDisabled();
  for (const name of ["벽", "지붕", "창문"])
    await expect(
      dialog.getByRole("combobox", { name, exact: true }),
    ).toBeDisabled();
  await dialog.getByRole("spinbutton", { name: "가로", exact: true }).fill("4");
  await expect(
    dialog.getByRole("button", { name: "새 설계도 저장", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("홀수 폭");
  await dialog
    .getByRole("button", { name: "전망대 복제", exact: true })
    .click();
  await expect(
    dialog.getByRole("spinbutton", { name: "높이", exact: true }),
  ).toHaveAttribute("max", "16");
  await dialog
    .getByRole("button", { name: "작은 나무집 복제", exact: true })
    .click();
  await expect(
    dialog.getByRole("spinbutton", { name: "높이", exact: true }),
  ).toHaveAttribute("min", "3");
  await expect(
    dialog.getByRole("spinbutton", { name: "높이", exact: true }),
  ).toHaveAttribute("max", "4");
  await dialog.getByRole("spinbutton", { name: "높이", exact: true }).fill("5");
  await expect(
    dialog.getByRole("button", { name: "새 설계도 저장", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("높이 3~4");
  await dialog.getByRole("spinbutton", { name: "높이", exact: true }).fill("3");
  await dialog.getByRole("spinbutton", { name: "가로", exact: true }).fill("4");
  await expect(
    dialog.getByRole("button", { name: "새 설계도 저장", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("spinbutton", { name: "가로", exact: true }).fill("5");
  await expect(
    dialog.getByRole("button", { name: "새 설계도 저장", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("combobox", { name: "목재 종류", exact: true })
    .selectOption("cherry");
  await dialog
    .getByRole("combobox", { name: "지붕", exact: true })
    .selectOption("stone_bricks");
  await expect(
    dialog.getByRole("region", { name: "설계도 미리보기" }),
  ).toContainText("벚나무");
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  for (const element of await dialog.locator("input, select, button").all()) {
    const rect = await element.boundingBox();
    expect(rect?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  expect(mutations).toBe(0);
});

function inventoryView(): InventoryView {
  const slots: InventoryView["slots"] = Array.from({ length: 46 }, () => null);
  slots[0] = { name: "oak_planks", count: 4 };
  slots[1] = { name: "oak_log", count: 1 };
  slots[5] = {
    name: "iron_helmet",
    count: 1,
    durability: { remaining: 150, maximum: 165 },
  };
  slots[6] = { name: "iron_chestplate", count: 1 };
  slots[7] = { name: "iron_leggings", count: 1 };
  slots[8] = { name: "iron_boots", count: 1 };
  slots[9] = { name: "oak_log", count: 64, maxStackSize: 64 };
  slots[10] = { name: "oak_log", count: 12, maxStackSize: 64 };
  slots[11] = {
    name: "modded_relic",
    displayName: "알 수 없는 유물",
    count: 2,
    enchants: [
      "sharpness",
      "smite",
      "bane_of_arthropods",
      "efficiency",
      "unbreaking",
      "mending",
      "fortune",
      "silk_touch",
      "power",
      "protection",
    ].map((name) => ({ name, level: 1 })),
  };
  slots[36] = {
    name: "diamond_pickaxe",
    displayName: "다이아몬드 곡괭이",
    customName: "채굴자의 곡괭이",
    count: 1,
    maxStackSize: 1,
    durability: { remaining: 32, maximum: 1561 },
    enchants: [
      { name: "minecraft:efficiency", level: 3 },
      { name: "unbreaking", level: 2 },
    ],
  };
  slots[37] = { name: "bread", count: 5 };
  slots[45] = { name: "shield", count: 1 };
  return { slots, selectedHotbarSlot: 0, cursor: { name: "stone", count: 3 } };
}

test("inventory keeps authentic slot positions, duplicate stacks and equipment while focused details follow live moves", async ({
  page,
}) => {
  let state = snapshot();
  state.agents = [agent("Hunter", "hunter")];
  const bot = state.agents[0]!;
  bot.session!.report!.inventoryView = inventoryView();
  bot.session!.report!.inventory = [
    { name: "oak_log", count: 77 },
    { name: "diamond_pickaxe", count: 1 },
  ];
  const mutations: string[] = [];
  let atlasRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/inventory-atlas.png")
      atlasRequests++;
  });
  await installStream(page);
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/snapshot")) return route.fulfill({ json: state });
    mutations.push(path);
    return route.fulfill({
      json: {
        id: "inventory-viewer",
        type: "viewer.start",
        state: "applied",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Hunter 상세 보기", exact: true })
    .click();
  const board = page.getByRole("region", {
    name: "인게임 인벤토리",
    exact: true,
  });
  await expect(board.locator("[data-slot-index]")).toHaveCount(46);
  await expect(
    board
      .getByRole("group", { name: "보관 공간", exact: true })
      .locator("[data-slot-index]"),
  ).toHaveCount(27);
  await expect(
    board
      .getByRole("group", { name: "핫바", exact: true })
      .locator("[data-slot-index]"),
  ).toHaveCount(9);
  await expect(
    board.locator(".inventory-crafting-grid [data-slot-index]"),
  ).toHaveCount(4);
  await expect(board.locator('[data-slot-index="0"]')).toHaveAccessibleName(
    "제작 결과 · 참나무 판자 4개",
  );
  await expect(board.locator('[data-slot-index="1"]')).toHaveAccessibleName(
    "제작 칸 1 · 참나무 원목 1개",
  );
  for (const [index, name] of [
    [5, "투구"],
    [6, "흉갑"],
    [7, "각반"],
    [8, "부츠"],
  ] as const)
    await expect(
      board.locator(`.inventory-armor [data-slot-index="${index}"]`),
    ).toHaveAttribute("aria-label", new RegExp(`^${name} ·`));
  await expect(board.locator('[data-slot-index="45"]')).toHaveAccessibleName(
    "보조 손 · 방패 1개",
  );
  await expect(
    board.locator('[data-slot-index="9"] .inventory-stack-count'),
  ).toHaveText("64");
  await expect(
    board.locator('[data-slot-index="10"] .inventory-stack-count'),
  ).toHaveText("12");
  const tool = board.locator('[data-slot-index="36"]');
  await expect(tool).toHaveClass(/held/);
  await expect(tool.locator(".inventory-stack-count")).toHaveCount(0);
  await expect(tool.locator(".inventory-glint")).toHaveCount(1);
  await expect(tool.getByRole("meter")).toHaveAttribute("aria-valuenow", "32");
  await expect(tool.getByRole("meter")).toHaveAttribute(
    "aria-valuemax",
    "1561",
  );
  await expect(board.locator("[data-cursor=true]")).toHaveAccessibleName(
    "커서 · 돌 3개",
  );
  await tool.focus();
  await expect(page.getByRole("tooltip")).toContainText("채굴자의 곡괭이");
  await expect(page.getByRole("tooltip")).toContainText("내구도 32 / 1561");
  await expect(page.getByRole("tooltip")).toContainText("효율 3");
  await expect(page.getByRole("tooltip")).toContainText("내구성 2");
  await page.keyboard.press("Tab");
  await expect(board.locator('[data-slot-index="37"]')).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("빵");
  await expect(page.getByRole("tooltip")).toContainText("수량 5개");
  const unknown = board.locator('[data-slot-index="11"]');
  await unknown.focus();
  await expect(unknown.locator(".inventory-unknown-icon")).toHaveText("?");
  await expect(page.getByRole("tooltip")).toContainText("알 수 없는 유물");
  await unknown.evaluate((element) => element.blur());
  await unknown.hover();
  await page.getByRole("tooltip").hover();
  await page.waitForTimeout(180);
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.mouse.wheel(0, 300);
  await expect
    .poll(() =>
      page.getByRole("tooltip").evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(0);
  await tool.focus();
  const view = bot.session!.report!.inventoryView!;
  view.slots[9] = null;
  view.slots[18] = { name: "oak_log", count: 64 };
  view.slots[10]!.count = 8;
  view.slots[36]!.durability!.remaining = 20;
  view.selectedHotbarSlot = 1;
  view.cursor = null;
  state = { ...state, revision: state.revision + 1, updatedAt: Date.now() };
  bot.session!.lastReportAt = Date.now();
  await page.evaluate(
    (state) =>
      (window as unknown as BrowserHarness).sendFleet(
        "snapshot",
        JSON.parse(state),
      ),
    JSON.stringify(state),
  );
  await expect(board.locator('[data-slot-index="9"]')).toHaveAccessibleName(
    "보관 칸 1 · 비어 있음",
  );
  await expect(
    board.locator('[data-slot-index="18"] .inventory-stack-count'),
  ).toHaveText("64");
  await expect(
    board.locator('[data-slot-index="10"] .inventory-stack-count'),
  ).toHaveText("8");
  await expect(tool).not.toHaveClass(/held/);
  await expect(board.locator('[data-slot-index="37"]')).toHaveClass(/held/);
  await expect(page.getByRole("tooltip")).toContainText("내구도 20 / 1561");
  await expect(board.locator("[data-cursor=true]")).toHaveAccessibleName(
    "커서 · 비어 있음",
  );
  await tool.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await board.screenshot({ path: "/tmp/laya-inventory-desktop.png" });
  expect(atlasRequests).toBe(1);
  expect(mutations).toEqual(["/api/v1/bots/Hunter/viewer"]);
});

test("inventory distinguishes unobserved slots from actual emptiness and marks stale or offline observations", async ({
  page,
}) => {
  let state = snapshot();
  state.agents = [agent("Hunter", "hunter")];
  const bot = state.agents[0]!;
  await installStream(page);
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/snapshot")
        ? state
        : {
            id: "empty-viewer",
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
  const detail = page.getByRole("region", {
    name: "Hunter 상세 상태",
    exact: true,
  });
  await expect(detail).toContainText("슬롯 관측 대기");
  await expect(detail).toContainText("보고된 물품 합계");
  await expect(detail.locator(".inventory-totals")).toContainText(
    "참나무 원목10개",
  );
  await expect(detail.locator("[data-slot-index]")).toHaveCount(0);
  await expect(detail).not.toContainText("모든 슬롯이 비어 있습니다");
  bot.session!.report!.inventory = [];
  bot.session!.report!.inventoryView = {
    slots: Array.from({ length: 46 }, () => null),
  };
  async function send() {
    state = { ...state, revision: state.revision + 1, updatedAt: Date.now() };
    await page.evaluate(
      (state) =>
        (window as unknown as BrowserHarness).sendFleet(
          "snapshot",
          JSON.parse(state),
        ),
      JSON.stringify(state),
    );
  }
  await send();
  const board = detail.getByRole("region", {
    name: "인게임 인벤토리",
    exact: true,
  });
  await expect(board.locator("[data-slot-index]")).toHaveCount(46);
  await expect(
    board.locator(".inventory-item-icon, .inventory-unknown-icon"),
  ).toHaveCount(0);
  await expect(board.locator(".held, [data-cursor=true]")).toHaveCount(0);
  await expect(board).toContainText("모든 슬롯이 비어 있습니다");
  bot.session!.lastReportAt = Date.now() - 11_000;
  await send();
  await expect(board).toContainText("마지막 관측 상태");
  bot.session!.lastReportAt = Date.now();
  await send();
  await expect(board).not.toContainText("마지막 관측 상태");
  await page.evaluate(() =>
    (window as unknown as BrowserHarness).sendFleet("disconnect", null),
  );
  await expect(board).toContainText("마지막 관측 상태");
  await expect(page.locator(".connection")).toContainText("다시 연결 중");
});

test("inventory stays nine columns at 320 and 375 pixels and touch details fit inside the viewport", async ({
  page,
}) => {
  const state = snapshot();
  state.agents = [agent("Hunter", "hunter")];
  state.agents[0]!.session!.report!.inventoryView = inventoryView();
  await installStream(page);
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/snapshot")
        ? state
        : {
            id: "mobile-viewer",
            type: "viewer.start",
            state: "applied",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
    }),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Hunter 상세 보기", exact: true })
    .click();
  const board = page.getByRole("region", {
    name: "인게임 인벤토리",
    exact: true,
  });
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(board.locator("[data-slot-index]")).toHaveCount(46);
    const rectangles = await board
      .locator(".inventory-main-grid .inventory-slot")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    expect(rectangles).toHaveLength(27);
    for (let row = 0; row < 3; row++) {
      const cells = rectangles.slice(row * 9, row * 9 + 9);
      expect(
        Math.max(...cells.map((cell) => cell.y)) -
          Math.min(...cells.map((cell) => cell.y)),
      ).toBeLessThan(1);
      expect(cells[8]!.x).toBeGreaterThan(cells[0]!.x);
      expect(Math.min(...cells.map((cell) => cell.width))).toBeGreaterThan(15);
    }
    expect(rectangles[9]!.y).toBeGreaterThan(rectangles[0]!.y);
    await board.screenshot({ path: `/tmp/laya-inventory-mobile-${width}.png` });
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .map((element) => ({
          className: element.className,
          right: element.getBoundingClientRect().right,
          left: element.getBoundingClientRect().left,
        }))
        .filter(
          (element) => element.right > window.innerWidth || element.left < 0,
        ),
    );
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
      JSON.stringify(overflow),
    ).toBe(true);
    expect(
      await board.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await board.locator('[data-slot-index="36"]').click();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("채굴자의 곡괭이");
    const bounds = await tooltip.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await board.locator('[data-slot-index="36"]').press("Escape");
    await board.screenshot({ path: `/tmp/laya-inventory-mobile-${width}.png` });
  }
});
