import type {
  Agent,
  BotReport,
  FleetSnapshot,
  Goal,
  RecoveryState,
  Task,
} from "../../../../packages/contracts/src";
import { resolveBlueprint } from "../../../../packages/contracts/src/blueprints";

const activeTaskStates = new Set([
  "assigned",
  "accepted",
  "running",
  "verifying",
  "cancelling",
]);
export const waitingTaskStates = new Set([
  "condition-wait",
  "held",
  "retry-wait",
]);

export function isLocalFoodRecovery(report: BotReport | undefined): boolean {
  return !!report && report.mode === "idle" && !report.currentAttemptId &&
    /^(식량 확보|자원 탐색)/.test(report.action);
}

export function latestRecovery(bot: Agent): RecoveryState | undefined {
  return [bot.recovery, bot.session?.report?.recovery]
    .filter((state): state is RecoveryState => !!state)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function isDeathRecoveryPending(bot: Agent): boolean {
  const state = latestRecovery(bot);
  return !!state && (state.phase !== "resolved" || !state.safe);
}

export function taskActionLabel(
  task: Pick<Task, "kind" | "params">,
  goal?: Goal,
): string {
  if (task.kind === "build" && task.params.mode === "prepare-site")
    return "부지 정리";
  if (task.kind === "explore" && task.params.mode === "build-site")
    return "건설 부지 탐색";
  if (task.kind === "build") {
    const design =
      task.params.design ??
      task.params.blueprint ??
      goal?.input.params.design ??
      goal?.input.params.blueprint;
    try {
      if (
        resolveBlueprint(
          String(design),
          task.params.blueprintDefinition ??
            goal?.input.params.blueprintDefinition,
        ).template === "warehouse"
      )
        return "창고 건축";
    } catch {
      /* The registered design may still be awaiting confirmation. */
    }
  }
  return label(task.kind, actionLabels);
}

export function goalBlueprintTitle(goal: Goal): string | undefined {
  if (goal.input.kind !== "build") return undefined;
  try {
    return resolveBlueprint(
      String(
        goal.input.params.design ?? goal.input.params.blueprint ?? "cabin",
      ),
      goal.input.params.blueprintDefinition,
    ).title;
  } catch {
    return undefined;
  }
}

export function selectedBotWork(
  snapshot: FleetSnapshot | null,
  bot: Agent | undefined,
): { task?: Task; goal?: Goal } {
  if (!snapshot || !bot) return {};
  const current = (task: Task) => {
    const goal = snapshot.goals.find((goal) => goal.id === task.goalId);
    return goal &&
      goal.generation === task.generation &&
      !["completed", "cancelled"].includes(goal.state)
      ? goal
      : undefined;
  };
  const work = (task: Task) => ({
    ...(bot.session?.report?.mode === "survival" || bot.session?.report?.mode === "emergency" || isDeathRecoveryPending(bot) || isLocalFoodRecovery(bot.session?.report) ? {} : { task }),
    goal: current(task),
  });
  const attemptId =
    bot.session?.activeAttemptId ?? bot.session?.report?.currentAttemptId;
  const attempt = snapshot.attempts.find(
    (attempt) =>
      attempt.id === attemptId &&
      attempt.botId === bot.id &&
      attempt.sessionId === bot.session?.id &&
      attempt.controllerEpoch === snapshot.controllerEpoch,
  );
  const active =
    attempt &&
    snapshot.tasks.find(
      (task) =>
        task.id === attempt.taskId &&
        task.attemptId === attempt.id &&
        activeTaskStates.has(task.state) &&
        current(task),
    );
  if (active) return work(active);
  const task = snapshot.tasks
    .filter((task) => {
      const goal = current(task);
      if (
        !goal ||
        goal.state === "cancelling" ||
        !waitingTaskStates.has(task.state) ||
        (task.affinityBotId && task.affinityBotId !== bot.id)
      )
        return false;
      const latestAttempt = task.attemptId
        ? snapshot.attempts.find(
            (attempt) =>
              attempt.id === task.attemptId && attempt.taskId === task.id,
          )
        : snapshot.attempts
            .filter((attempt) => attempt.taskId === task.id)
            .sort((a, b) => b.assignedAt - a.assignedAt)[0];
      if (task.affinityBotId) return task.affinityBotId === bot.id;
      if (latestAttempt) return latestAttempt.botId === bot.id;
      return goal.input.preferredBotId === bot.id;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
  return task ? work(task) : {};
}

export const roleLabels: Record<string, string> = {
  gatherer: "채집가",
  builder: "건축가",
  farmer: "농부",
  hunter: "사냥꾼",
  guard: "경비병",
  rancher: "축산가",
  explorer: "탐험가",
  general: "생활 지원",
  generalist: "생활 지원",
  companion: "생활 지원",
};

export const stateLabels: Record<string, string> = {
  registered: "등록됨",
  connecting: "접속 중",
  starting: "시작 중",
  ready: "접속됨",
  paused: "일시정지",
  removing: "안전하게 종료 중",
  removed: "제거됨",
  abnormal: "접속 이상",
  stopped: "중지됨",
  queued: "예약됨",
  waiting: "대기",
  assigned: "배정됨",
  accepted: "요청 접수",
  running: "수행 중",
  verifying: "결과 확인 중",
  completed: "완료",
  complete: "완료",
  interrupted: "중단됨",
  retry_wait: "재시도 대기",
  condition_wait: "조건 대기",
  "retry-wait": "재시도 대기",
  "condition-wait": "조건 대기",
  cancelling: "안전하게 중단 중",
  held: "보류",
  cancelled: "취소됨",
  failed: "실패",
  applying: "적용 중",
  applied: "적용 완료",
  active: "진행 중",
  maintaining: "유지 중",
  pending: "대기",
  unavailable: "사용 불가",
};

export const actionLabels: Record<string, string> = {
  collect: "수집",
  craft: "제작",
  smelt: "제련",
  build: "건축",
  farm: "농사",
  harvest: "수확",
  hunt: "사냥",
  guard: "경비",
  fight: "전투",
  store: "보관",
  take: "꺼내기",
  transfer: "운반",
  explore: "탐색",
  survive: "생존 유지",
  follow: "따라가기",
  home: "거점 복귀",
  sleep: "수면",
  recover: "아이템 회수",
  breed: "번식",
  idle: "작업 대기",
  retreat: "퇴각",
  counterattack: "반격",
};

export function label(value: string | undefined, labels = stateLabels): string {
  return value ? (labels[value] ?? value) : "—";
}

export function isReportStale(
  lastReportAt: number | string | undefined,
  now = Date.now(),
): boolean {
  if (lastReportAt === undefined) return true;
  const timestamp =
    typeof lastReportAt === "number" ? lastReportAt : Date.parse(lastReportAt);
  return !Number.isFinite(timestamp) || now - timestamp >= 10_000;
}

export function finitePosition(
  value: unknown,
): value is { x: number; y: number; z: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return ["x", "y", "z"].every(
    (axis) => typeof point[axis] === "number" && Number.isFinite(point[axis]),
  );
}

export function positionText(point: unknown): string {
  return finitePosition(point)
    ? `X ${point.x.toFixed(1)} · Y ${point.y.toFixed(1)} · Z ${point.z.toFixed(1)}`
    : "위치 관측 대기";
}

export function safeViewerUrl(
  value: unknown,
  botId: string,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const expected = `/viewer/${encodeURIComponent(botId)}`;
  return (value === expected || value.startsWith(`${expected}/`)) &&
    !value.includes("\\") &&
    !value.includes("..")
    ? value === expected
      ? `${value}/`
      : value
    : undefined;
}

export function percent(current: number, target?: number): number | undefined {
  if (!Number.isFinite(current) || !target || !Number.isFinite(target))
    return undefined;
  return Math.max(0, Math.min(100, (current / target) * 100));
}

export function localTime(value: number | string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
}

export interface ReceiptLike {
  id?: string;
  commandId?: string;
  state: string;
  updatedAt?: number | string;
}

export function mergeReceipt<T extends ReceiptLike>(
  previous: T | undefined,
  incoming: T,
): T {
  if (!previous) return incoming;
  const terminal = new Set(["applied", "failed"]);
  if (terminal.has(previous.state) && !terminal.has(incoming.state))
    return previous;
  const before =
    typeof previous.updatedAt === "number"
      ? previous.updatedAt
      : Date.parse(previous.updatedAt ?? "");
  const after =
    typeof incoming.updatedAt === "number"
      ? incoming.updatedAt
      : Date.parse(incoming.updatedAt ?? "");
  if (Number.isFinite(before) && Number.isFinite(after) && after < before)
    return previous;
  return incoming;
}
