import {
  ContainerRefSchema,
  sameContainer,
  type FleetSnapshot,
  type Goal,
  type Task,
} from "../../../../packages/contracts/src";
import {
  buildStages,
  buildStage,
  buildTaskPhase,
  buildSuspension,
  countValue,
  currentBuildTask,
  materialName,
  objectValue,
  taskReporter,
  taskStateText,
  waitingFor,
} from "../lib/build-progress";
import { positionText, waitingTaskStates } from "../lib/display";
import { PreparationProgress } from "./PreparationProgress";

export function BuildTaskProgress({ task }: { task: Task }) {
  if (task.kind !== "build") return null;
  const condition = waitingFor(task);
  const access =
    task.params.mode === "prepare-access"
      ? objectValue(task.checkpoint.accessPreparationProgress)
      : undefined;
  const completed = countValue(access?.completedEdits),
    total = countValue(access?.totalEdits);
  const path = countValue(access?.pathIndex),
    pathLength = countValue(access?.pathLength);
  const remaining = waitingTaskStates.has(task.state)
    ? objectValue(task.checkpoint.buildRemaining)
    : undefined;
  const remainingCount = countValue(remaining?.count);
  const placed = task.params.mode
    ? undefined
    : countValue(objectValue(task.checkpoint.build)?.placed);
  const expected =
    task.completion.kind === "blocks" || task.completion.kind === "warehouse"
      ? task.completion.blocks.length
      : undefined;
  const rows: [string, string][] = [];
  if (condition?.kind === "inventory")
    rows.push([
      "현재 자재 조건",
      `${materialName(condition.item)} ${condition.minimum}개 보유 필요`,
    ]);
  if (condition?.kind === "blocks")
    rows.push([
      "확인할 조건",
      {
        BUILD_SUPPORT: "블록을 붙일 지지 면",
        BUILD_SITE: "부지와 기존 시설 상태",
        BUILD_ACCESS: "안전한 접근·복귀 경로",
        BUILD_OBSERVATION: "월드 재관측",
      }[condition.causeCode],
    ]);
  if (completed !== undefined && total !== undefined && completed <= total)
    rows.push(["지형 변경 확인", `${completed} / ${total}칸`]);
  if (path !== undefined && pathLength !== undefined && path <= pathLength)
    rows.push(["복귀 경로 진행", `${path} / ${pathLength}지점`]);
  if (
    expected !== undefined &&
    task.params.mode !== "prepare-site" &&
    task.params.mode !== "prepare-access"
  )
    rows.push(["설계 블록", `${expected}칸`]);
  if (placed !== undefined) rows.push(["설치 확인 누계", `${placed}회`]);
  if (remainingCount !== undefined)
    rows.push(["마지막 확인 때 미확인", `${remainingCount}칸`]);
  if (
    !rows.length &&
    !(condition?.kind === "inventory" && condition.failedCause)
  )
    return null;
  return (
    <section
      className="build-task-progress"
      aria-label={
        task.params.mode === "prepare-access"
          ? "복귀 경로 정리 진행"
          : "건설 조건과 확인 기록"
      }
    >
      <dl>
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {condition?.kind === "inventory" && condition.failedCause && (
        <p className="reason">막힌 이유 · {condition.failedCause}</p>
      )}
      {placed !== undefined && (
        <p className="muted">
          설치 확인 누계는 작업 기록입니다. 완성 여부는 전체 설계와 실제 월드를
          다시 비교합니다.
        </p>
      )}
    </section>
  );
}

export function BuildGoalProgress({
  goal,
  snapshot,
  now,
  live,
}: {
  goal: Goal;
  snapshot: FleetSnapshot;
  now: number;
  live: boolean;
}) {
  if (goal.input.kind !== "build") return null;
  const task = currentBuildTask(goal, snapshot.tasks);
  const bot = taskReporter(snapshot, task, now, live),
    report = bot?.session?.report;
  const suspension = buildSuspension(bot);
  const terminal = ["completed", "cancelled"].includes(goal.state);
  const cancelled = goal.state === "cancelled" || goal.state === "cancelling";
  const phase =
    goal.state === "completed"
      ? "verify"
      : buildStage(task, suspension ? undefined : report);
  const condition = task && waitingFor(task);
  const reason = suspension
    ? report?.reason
    : terminal || goal.state === "held"
      ? goal.reason
      : task?.reason || goal.reason || report?.reason;
  const warehouse = ContainerRefSchema.safeParse(
    goal.input.params.verifiedWarehouse,
  );
  const linked =
    warehouse.success &&
    !!snapshot.rules.warehouse &&
    sameContainer(warehouse.data, snapshot.rules.warehouse);
  const title = cancelled
    ? goal.state === "cancelled"
      ? "건설 목표 취소됨"
      : "현재 동작 안전 중단 중"
    : (suspension ??
      (goal.state === "completed"
        ? warehouse.success
          ? "건물·상자 사용 확인 완료"
          : "건물 검증 완료"
        : task
          ? buildTaskPhase(task, report)
          : "작업 계획 대기"));
  return (
    <section
      className="build-goal-progress"
      aria-label={`${goal.title} 건설 단계`}
    >
      <ol className="build-stage-list" aria-label="건설 과정">
        {buildStages.map((stage) => (
          <li
            key={stage.id}
            aria-current={!cancelled && stage.id === phase ? "step" : undefined}
            className={!cancelled && stage.id === phase ? "current" : ""}
          >
            {stage.label}
            {stage.id === "prepare" && <small>필요할 때</small>}
          </li>
        ))}
      </ol>
      <p className="build-phase">
        <b>{title}</b>
        {task && !terminal && !suspension && !cancelled && (
          <span className="tag neutral">{taskStateText(task)}</span>
        )}
      </p>
      {reason && <p className="reason build-blocker">{reason}</p>}
      {condition?.kind === "inventory" && !terminal && !suspension && (
        <p className="build-material-wait">
          자재 조건 · {materialName(condition.item)} {condition.minimum}개 보유
          필요{condition.failedCause ? ` · ${condition.failedCause}` : ""}
        </p>
      )}
      {!terminal && !suspension && task && <BuildTaskProgress task={task} />}
      {!terminal && !suspension && task?.params.mode === "prepare-site" && (
        <PreparationProgress task={task} label="부지 정리 요약" />
      )}
      {task?.params.mode === "register-warehouse" && !terminal && (
        <p className="muted">
          건물 검증 뒤 실제 상자 사용을 확인합니다. 상자 확인이 끝나야 창고
          목표를 완료합니다.
        </p>
      )}
      {warehouse.success && (
        <p className="verified-warehouse">
          {linked ? "공동 창고로 등록" : "건설한 상자 확인"} ·{" "}
          {positionText(warehouse.data.position)}
          {!linked && snapshot.rules.warehouse ? " · 기존 공동 창고 유지" : ""}
        </p>
      )}
      {task?.params.mode === "prepare-access" && !terminal && (
        <p className="muted">
          기존 건설을 이어가기 위한 경로 정리입니다. 건물 완성과 별도로
          확인합니다.
        </p>
      )}
      {!live && (
        <p className="muted">
          마지막으로 받은 작업 기록입니다. 연결 후 현재 진행을 다시 확인합니다.
        </p>
      )}
    </section>
  );
}
