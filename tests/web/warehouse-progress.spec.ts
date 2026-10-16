import { test, expect, type Page } from "@playwright/test";
import {
  AgentSchema,
  DEFAULT_RULES,
  FleetSnapshotSchema,
  GoalInputSchema,
  TaskSchema,
  type FleetSnapshot,
  type Goal,
  type Task,
  type TaskAttempt,
} from "../../packages/contracts/src";

type Harness = { sendFleet(value: unknown): void };
async function stream(page: Page) {
  await page.addInitScript(() => {
    const streams = new Set<EventTarget>();
    class MockStream extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        super();
        streams.add(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {
        streams.delete(this);
      }
    }
    Object.defineProperty(window, "EventSource", { value: MockStream });
    (window as unknown as Harness).sendFleet = (value) => {
      for (const instance of streams)
        instance.dispatchEvent(
          new MessageEvent("snapshot", { data: JSON.stringify(value) }),
        );
    };
  });
}

test("warehouse stages follow the current attempt through land, material work, route repair, building and actual container confirmation", async ({
  page,
}) => {
  const now = Date.now();
  const bot = AgentSchema.parse({
    id: "Builder",
    config: {
      name: "Builder",
      role: "builder",
      enabled: true,
      allowedActions: ["build", "explore", "collect", "craft", "smelt"],
      connection: { host: "127.0.0.1", port: 25566, auth: "offline" },
    },
    pendingCommandIds: [],
    status: "ready",
    viewer: { state: "stopped" },
    createdAt: now,
    updatedAt: now,
    session: {
      id: "builder-session",
      state: "ready",
      lastReportAt: now,
      rulesVersion: 1,
      report: {
        ready: true,
        world: "127.0.0.1:25566",
        dimension: "overworld",
        position: { x: 0, y: 64, z: 0 },
        health: 20,
        food: 20,
        inventory: [],
        action: "부지 탐색",
        reason: "주변 자연 지형에서 창고를 지을 공간을 확인합니다.",
        mode: "working",
        capabilities: ["build", "explore", "collect", "craft", "smelt"],
        rulesVersion: 1,
      },
    },
  });
  const report = bot.session!.report!;
  const goal: Goal = {
    id: "whole-warehouse",
    input: GoalInputSchema.parse({
      kind: "build",
      preferredBotId: bot.id,
      params: { blueprint: "warehouse", siteSelection: "nearby" },
    }),
    title: "전체 창고 과정",
    state: "active",
    taskIds: ["site"],
    generation: 1,
    createdAt: now,
    updatedAt: now,
    progress: { current: 0, target: 1 },
  };
  const makeTask = (id: string, patch: Partial<Task> = {}): Task =>
    TaskSchema.parse({
      id,
      goalId: goal.id,
      generation: goal.generation,
      kind: "build",
      params: { blueprint: "warehouse" },
      state: "running",
      dependencies: [],
      completion: { kind: "manual", reason: "실제 결과 확인" },
      reservationKeys: [],
      retryCount: 0,
      resumeCount: 0,
      checkpoint: {},
      progress: 0,
      createdAt: now,
      updatedAt: now,
      ...patch,
    });
  let task = makeTask("site", {
    kind: "explore",
    params: { mode: "build-site", design: "warehouse" },
    reason: report.reason,
  });
  let state: FleetSnapshot = FleetSnapshotSchema.parse({
    schemaVersion: 1,
    controllerEpoch: "warehouse-epoch",
    revision: 1,
    updatedAt: now,
    rules: {
      ...DEFAULT_RULES,
      world: "127.0.0.1:25566",
      center: { x: 0, y: 64, z: 0 },
      warehouse: null,
    },
    blueprints: [],
    agents: [bot],
    goals: [goal],
    tasks: [task],
    attempts: [],
    reservations: [],
    observations: [],
    events: [],
  });
  // Keep references to the fixture objects; each snapshot still goes through
  // the same strict runtime validator as the actual API payload.
  state.agents = [bot];
  state.goals = [goal];
  state.tasks = [task];
  const attach = (selected: Task) => {
    selected.attemptId = `${selected.id}-attempt`;
    selected.affinityBotId = bot.id;
    const attempt: TaskAttempt = {
      id: selected.attemptId,
      taskId: selected.id,
      botId: bot.id,
      sessionId: bot.session!.id,
      controllerEpoch: state.controllerEpoch,
      reason: "initial",
      state: "running",
      assignedAt: now,
    };
    state.attempts.push(attempt);
    bot.session!.activeAttemptId = attempt.id;
    report.currentAttemptId = attempt.id;
  };
  attach(task);
  await stream(page);
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/snapshot")
        ? state
        : {
            id: "viewer-fixture",
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
  const flow = page.getByRole("region", { name: "전체 창고 과정 건설 단계" }),
    detail = page.getByRole("region", { name: "Builder 상세 상태" });
  const activeStage = () =>
    flow.locator(".build-stage-list [aria-current=step]");
  async function send() {
    state.revision++;
    state.updatedAt = Date.now();
    bot.session!.lastReportAt = Date.now();
    FleetSnapshotSchema.parse(state);
    await page.evaluate(
      (value) => (window as unknown as Harness).sendFleet(JSON.parse(value)),
      JSON.stringify(state),
    );
  }
  await expect(activeStage()).toHaveText("부지 선정");
  await expect(flow).toContainText(report.reason);
  goal.generation = 2;
  goal.taskIds = ["prepare"];
  goal.input.params.siteSelection = "preparing";
  task = makeTask("prepare", {
    params: { mode: "prepare-site", blueprint: "warehouse" },
    checkpoint: {
      preparationProgress: {
        stage: "excavate",
        completedEdits: 2,
        totalEdits: 4,
        excavated: 2,
        filled: 0,
        pathIndex: 1,
        pathLength: 3,
      },
    },
    reason: "기존 시설을 보존하고 자연 지면 2/4칸을 정리했습니다.",
  });
  state.tasks.push(task);
  attach(task);
  report.action = "부지 정리";
  report.reason = task.reason!;
  await send();
  await expect(activeStage()).toContainText("부지 정리");
  await expect(flow).toContainText("2 / 4칸");
  await expect(flow.locator(".build-phase")).not.toContainText("완료");
  const blocks = [
    { position: { x: 3, y: 64, z: 3 }, name: "oak_planks" },
    { position: { x: 4, y: 64, z: 3 }, name: "oak_planks" },
    { position: { x: 3, y: 65, z: 3 }, name: "chest" },
    { position: { x: 4, y: 65, z: 3 }, name: "glass" },
  ];
  goal.generation = 3;
  goal.taskIds = ["build"];
  goal.input.params.siteSelection = "fixed";
  goal.input.params.origin = { x: 3, y: 64, z: 3 };
  task = makeTask("build", {
    completion: { kind: "blocks", blocks },
    checkpoint: {
      build: { placed: 1 },
      waitingFor: {
        kind: "inventory",
        causeCode: "BUILD_MATERIAL",
        item: "oak_planks",
        minimum: 1,
      },
      buildRemaining: { count: 3 },
    },
    reason: "필요한 판자를 만들 원목을 실제로 수집합니다.",
  });
  state.tasks.push(task);
  attach(task);
  report.action = "수집";
  report.reason = task.reason!;
  await send();
  await expect(activeStage()).toHaveText("재료 확보·제작");
  await expect(flow).toContainText(task.reason!);
  await expect(flow).not.toContainText("마지막 확인 때 미확인");
  report.currentAttemptId = "unrelated-attempt";
  bot.session!.activeAttemptId = undefined;
  report.action = "제련";
  report.reason = "다른 작업의 제련 보고입니다.";
  task.reason = "창고 외벽 블록 설치를 확인했습니다.";
  await send();
  await expect(activeStage()).toHaveText("건설");
  await expect(flow).not.toContainText(report.reason);
  report.currentAttemptId = task.attemptId;
  bot.session!.activeAttemptId = task.attemptId;
  report.action = "제작";
  report.reason = "원목으로 판자를 제작하고 실제 산출물을 확인합니다.";
  task.reason = report.reason;
  await send();
  await expect(flow.locator(".build-phase")).toContainText("건설 재료 제작");
  task.state = "condition-wait";
  task.reason = "원목 자원에 접근할 안전한 경로가 없습니다.";
  task.checkpoint.waitingFor = {
    kind: "inventory",
    causeCode: "BUILD_MATERIAL",
    item: "oak_planks",
    minimum: 1,
    failedCause: "관측한 자연 자원으로 가는 경로가 끊겼습니다.",
  };
  report.mode = "idle";
  report.action = "idle";
  await send();
  await expect(activeStage()).toHaveText("재료 확보·제작");
  await expect(flow).toContainText(task.reason!);
  await expect(flow).toContainText("참나무 판자 1개 보유 필요");
  await expect(flow).toContainText("마지막 확인 때 미확인");
  await expect(detail.locator(".current-action")).toHaveText(
    "건설 재료 조건 대기",
  );
  const parent = task;
  parent.state = "waiting";
  parent.dependencies = ["access"];
  task = makeTask("access", {
    params: { mode: "prepare-access", parentTaskId: parent.id },
    checkpoint: {
      accessPreparationProgress: {
        completedEdits: 1,
        totalEdits: 2,
        pathIndex: 4,
        pathLength: 10,
      },
    },
    reason: "예약한 자연 지형만 정리하며 창고로 복귀합니다.",
  });
  state.tasks.push(task);
  goal.taskIds.push(task.id);
  attach(task);
  report.mode = "working";
  report.action = "접근로 정리";
  report.reason = task.reason!;
  await send();
  await expect(flow.locator(".build-phase")).toContainText("복귀 경로 정리");
  await expect(flow).toContainText("1 / 2칸");
  await expect(flow).toContainText("4 / 10지점");
  await expect(detail).toContainText("현재 작업 · 복귀 경로 정리");
  await expect(flow).not.toContainText(parent.reason!);
  task.state = "completed";
  parent.state = "running";
  delete parent.checkpoint.waitingFor;
  delete parent.checkpoint.buildRemaining;
  parent.checkpoint.build = { placed: 3 };
  parent.reason = "창고 벽과 설비를 설치한 결과를 확인합니다.";
  task = parent;
  attach(task);
  report.action = "build";
  report.reason = task.reason!;
  await send();
  await expect(activeStage()).toHaveText("건설");
  await expect(flow).toContainText("설치 확인 누계");
  await expect(flow).toContainText("3회");
  await expect(flow).toContainText(
    "완성 여부는 전체 설계와 실제 월드를 다시 비교합니다.",
  );
  task.state = "verifying";
  task.reason = "전체 설계 블록의 실제 배치를 다시 관측합니다.";
  await send();
  await expect(activeStage()).toHaveText("검증·창고 확인");
  await expect(flow.locator(".build-phase")).toContainText("건물 완성 검증");
  task.state = "completed";
  const container = {
    id: "new-warehouse",
    world: state.rules.world,
    dimension: "overworld",
    position: { x: 3, y: 65, z: 3 },
  };
  task = makeTask("register", {
    params: { mode: "register-warehouse", container },
    dependencies: [parent.id],
    completion: { kind: "warehouse", container, blocks },
    state: "condition-wait",
    checkpoint: {
      waitingFor: {
        kind: "blocks",
        causeCode: "BUILD_OBSERVATION",
        positions: [container.position],
      },
    },
    reason: "실제 상자를 열어 사용할 수 있는지 확인해야 합니다.",
  });
  state.tasks.push(task);
  goal.taskIds.push(task.id);
  attach(task);
  report.mode = "idle";
  report.action = "idle";
  await send();
  await expect(flow.locator(".build-phase")).toContainText(
    "상자 사용 확인 · 창고 연결",
  );
  await expect(detail.locator(".current-action")).toHaveText(
    "창고 확인 조건 대기",
  );
  await expect(page.locator(".goal-row-top .tag")).toHaveText("진행 중");
  await expect(flow).not.toContainText("공동 창고로 등록");
  task.state = "completed";
  goal.state = "completed";
  goal.progress.current = 1;
  goal.input.params.verifiedWarehouse = container;
  goal.reason =
    "전체 설계와 실제 상자 사용을 확인한 뒤 공동 창고로 등록했습니다.";
  state.rules.warehouse = container;
  bot.session!.activeAttemptId = undefined;
  delete report.currentAttemptId;
  await send();
  await expect(page.locator(".goal-row-top .tag")).toHaveText("완료");
  await expect(flow).toContainText("공동 창고로 등록");
  await expect(flow).toContainText("건물·상자 사용 확인 완료");
  state.rules.warehouse = {
    ...container,
    id: "previous-warehouse",
    position: { x: 20, y: 64, z: 20 },
  };
  await send();
  await expect(flow.locator(".verified-warehouse")).toContainText(
    "기존 공동 창고 유지",
  );
  await expect(flow.locator(".verified-warehouse")).not.toContainText(
    "공동 창고로 등록",
  );
  goal.state = "cancelled";
  goal.reason = "사용자가 건설 목표를 취소했습니다.";
  await send();
  await expect(flow).toContainText("건설 목표 취소됨");
  await expect(activeStage()).toHaveCount(0);
  await expect(flow).not.toContainText("설치 확인 누계");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(1);
});
