import {
  BuildWaitingForSchema,
  type Task,
} from "../../../../packages/contracts/src";
import { waitingTaskStates } from "../lib/display";

const stageLabels: Record<string, string> = {
  access: "진입로 확보",
  excavate: "땅 파기",
  fill: "지면 메우기",
  verify: "부지 확인",
};
const materials: Record<string, string> = {
  dirt: "흙",
  coarse_dirt: "거친 흙",
  grass_block: "잔디 블록",
  stone: "돌",
  cobblestone: "조약돌",
  deepslate: "심층암",
  cobbled_deepslate: "심층암 조약돌",
};

export function PreparationProgress({ task }: { task: Task }) {
  if (task.kind !== "build" || task.params.mode !== "prepare-site") return null;
  const value = task.checkpoint.preparationProgress;
  const progress =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  const count = (key: string) => {
    const value = progress?.[key];
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : undefined;
  };
  const rows: [string, string][] = [];
  if (typeof progress?.stage === "string" && stageLabels[progress.stage])
    rows.push(["진행 단계", stageLabels[progress.stage]!]);
  const completed = count("completedEdits"),
    total = count("totalEdits");
  if (completed !== undefined && total !== undefined && completed <= total)
    rows.push(["지형 변경 확인", `${completed} / ${total}칸`]);
  const excavated = count("excavated"),
    filled = count("filled");
  if (excavated !== undefined) rows.push(["굴착 확인", `${excavated}칸`]);
  if (filled !== undefined) rows.push(["메우기 확인", `${filled}칸`]);
  const pathIndex = count("pathIndex"),
    pathLength = count("pathLength");
  if (
    pathIndex !== undefined &&
    pathLength !== undefined &&
    pathIndex <= pathLength
  )
    rows.push(["진입로 진행", `${pathIndex} / ${pathLength}지점`]);
  const waiting = BuildWaitingForSchema.safeParse(task.checkpoint.waitingFor);
  if (
    waitingTaskStates.has(task.state) &&
    waiting.success &&
    waiting.data.kind === "inventory"
  )
    rows.push([
      "자재 대기",
      `${materials[waiting.data.item] ?? waiting.data.item.replaceAll("_", " ")} ${waiting.data.minimum}개 보유 필요`,
    ]);
  return (
    <section className="preparation-progress" aria-label="부지 정리 진행">
      {rows.length > 0 && (
        <dl>
          {rows.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p>
        {task.state === "completed"
          ? "부지 정리 결과를 확인했습니다. 건물 완성은 별도로 확인합니다."
          : "부지 정리는 건설 준비 단계이며, 건물 완성과 별도로 확인합니다."}
      </p>
    </section>
  );
}
