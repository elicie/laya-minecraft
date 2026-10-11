import {
  BuildWaitingForSchema,
  type Agent,
  type BotReport,
  type FleetSnapshot,
  type Goal,
  type JsonObject,
  type Task,
} from "../../../../packages/contracts/src";
import {
  isDeathRecoveryPending,
  isReportStale,
  label,
  waitingTaskStates,
} from "./display";

export const buildStages = [
  { id: "site", label: "부지 선정" },
  { id: "prepare", label: "부지 정리" },
  { id: "materials", label: "재료 확보·제작" },
  { id: "build", label: "건설" },
  { id: "verify", label: "검증·창고 확인" },
] as const;
export type BuildStage = (typeof buildStages)[number]["id"];
const priorities: Partial<Record<Task["state"], number>> = {
  verifying: 8,
  running: 7,
  accepted: 6,
  assigned: 5,
  cancelling: 4,
  "condition-wait": 3,
  held: 3,
  "retry-wait": 2,
  interrupted: 1,
  waiting: 0,
};
export const objectValue = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
export const countValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

export function waitingFor(task: Task) {
  if (!waitingTaskStates.has(task.state)) return undefined;
  const parsed = BuildWaitingForSchema.safeParse(
    task.waitState?.waitingFor ?? task.checkpoint.waitingFor,
  );
  return parsed.success ? parsed.data : undefined;
}

export function currentBuildTask(goal: Goal, tasks: Task[]): Task | undefined {
  const current = tasks.filter(
    (task) => task.goalId === goal.id && task.generation === goal.generation,
  );
  const pending = current.filter(
    (task) => priorities[task.state] !== undefined,
  );
  return (
    pending.sort((a, b) => {
      const blocked = (task: Task) =>
        task.dependencies.some((id) =>
          current.some(
            (dependency) =>
              dependency.id === id && dependency.state !== "completed",
          ),
        );
      return (
        Number(blocked(a)) - Number(blocked(b)) ||
        priorities[b.state]! - priorities[a.state]! ||
        b.updatedAt - a.updatedAt
      );
    })[0] ??
    current
      .filter((task) => task.state === "completed")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  );
}

export function taskReporter(
  snapshot: FleetSnapshot,
  task: Task | undefined,
  now: number,
  live: boolean,
): Agent | undefined {
  if (
    !live ||
    !task?.attemptId ||
    !["running", "accepted", "verifying", "cancelling"].includes(task.state)
  )
    return undefined;
  const attempt = snapshot.attempts.find(
    (attempt) =>
      attempt.id === task.attemptId &&
      attempt.taskId === task.id &&
      attempt.controllerEpoch === snapshot.controllerEpoch,
  );
  const bot =
    attempt &&
    snapshot.agents.find(
      (bot) =>
        bot.id === attempt.botId && bot.session?.id === attempt.sessionId,
    );
  return bot?.session?.report?.ready &&
    !isReportStale(bot.session.lastReportAt, now) &&
    (bot.session.activeAttemptId === attempt?.id ||
      bot.session.report.currentAttemptId === attempt?.id)
    ? bot
    : undefined;
}

export function buildStage(
  task: Task | undefined,
  report?: BotReport,
): BuildStage {
  if (!task) return "site";
  if (task.params.mode === "build-site") return "site";
  if (task.params.mode === "prepare-site") return "prepare";
  if (task.params.mode === "register-warehouse" || task.state === "verifying")
    return "verify";
  if (task.params.mode === "prepare-access") return "build";
  const condition = waitingFor(task);
  if (
    condition?.kind === "inventory" ||
    ["collect", "take", "craft", "smelt", "explore"].includes(task.kind)
  )
    return "materials";
  if (condition?.kind === "blocks" && condition.causeCode === "BUILD_SITE")
    return "site";
  if (
    report &&
    /^(수집|collect|제작|craft|제련|smelt|자원 탐색)/.test(report.action)
  )
    return "materials";
  return "build";
}

export function buildTaskPhase(task: Task, report?: BotReport): string {
  if (task.params.mode === "prepare-access") return "복귀 경로 정리";
  if (task.params.mode === "register-warehouse")
    return "상자 사용 확인 · 창고 연결";
  if (task.state === "verifying") return "건물 완성 검증";
  const stage = buildStage(task, report);
  if (stage === "materials" && report && /^(제작|craft)/.test(report.action))
    return "건설 재료 제작";
  if (stage === "materials" && report && /^(제련|smelt)/.test(report.action))
    return "건설 재료 제련";
  return buildStages.find((value) => value.id === stage)!.label;
}

export function buildSuspension(bot: Agent | undefined): string | undefined {
  if (!bot) return undefined;
  const mode = bot.session?.report?.mode;
  if (mode === "emergency") return "위험 대응 우선 · 건설 진행 보존";
  if (mode === "survival") return "기본 생존 우선 · 건설 진행 보존";
  if (mode === "recovering" || isDeathRecoveryPending(bot))
    return "사망 후 복구·안전 확인 우선 · 건설 진행 보존";
  return undefined;
}

const names: Record<string, string> = {
  oak_log: "참나무 원목",
  oak_planks: "참나무 판자",
  spruce_planks: "가문비나무 판자",
  birch_planks: "자작나무 판자",
  cobblestone: "조약돌",
  stone: "돌",
  dirt: "흙",
  glass: "유리",
  sand: "모래",
  chest: "상자",
  crafting_table: "제작대",
  furnace: "화로",
  torch: "횃불",
  coal: "석탄",
  stick: "막대기",
};
export const materialName = (name: string) =>
  names[name] ?? name.replaceAll("_", " ");
export const taskStateText = (task: Task) => label(task.state);
