import {
  readFileSync,
  readdirSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  OperationsSchema,
  sameContainer,
  itemCount,
  type FleetSnapshot,
  type Operations,
} from "../../../packages/contracts/src";

function json(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
function lastProgress(path: string): any {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size,
        buffer = Buffer.alloc(Math.min(size, 65536));
      readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      const rows = buffer.toString("utf8").trim().split("\n");
      for (let i = rows.length - 1; i >= 0; i--)
        try {
          return JSON.parse(rows[i]!);
        } catch {}
    } finally {
      closeSync(fd);
    }
  } catch {}
  return undefined;
}
export function trainingSummary(
  reportsDirectory: string,
  trainingRoot?: string,
): Operations["training"] {
  const rows = new Map<string, Operations["training"][number]>();
  for (const name of existsSync(reportsDirectory)
    ? readdirSync(reportsDirectory).filter((p) => p.endsWith(".json"))
    : []) {
    const r = json(resolve(reportsDirectory, name));
    if (!r || typeof r.model !== "string") continue;
    const result = r.normalizedEvaluation ?? r.canonicalEvaluation?.[r.model],
      broad = r.broadV6BaseAccuracy ?? r.broadBaseAccuracy;
    rows.set(r.model, {
      id: r.model,
      state:
        r.canonicalProfileApproved === true ||
        r.normalizedProfileApproved === true ||
        r.broadEvaluationApproved === true
          ? "qualified"
          : "rejected",
      step: r.v6AdditionalOptimizerSteps ?? r.optimizerSteps ?? 0,
      totalSteps: r.v6AdditionalOptimizerSteps ?? r.optimizerSteps ?? null,
      trainRows: r.trainRows ?? null,
      correct:
        (r.broadEvaluationApproved ? broad?.correct : result?.correct) ?? null,
      total: (r.broadEvaluationApproved ? broad?.total : result?.total) ?? null,
      illegal:
        (r.broadEvaluationApproved ? broad?.illegal : result?.illegal) ?? null,
      broadApproved: r.broadEvaluationApproved ?? null,
      normalizedApproved: r.normalizedProfileApproved ?? null,
      profile: r.canonicalProfile ?? r.deploymentProfile ?? null,
      note:
        r.canonicalLimitation ??
        r.note ??
        "학습과 코드 변경을 구분한 실제 평가 기록입니다.",
    });
  }
  for (const name of trainingRoot && existsSync(trainingRoot)
    ? readdirSync(trainingRoot).filter((p) => /^qwen35-base-v\d+-\d+$/.test(p))
    : []) {
    const run = resolve(trainingRoot!, name),
      progress = lastProgress(resolve(run, "progress.jsonl")),
      trained = json(resolve(run, "training.json")),
      report = json(resolve(run, "report.json"));
    if (rows.has(name) || (!progress && !trained)) continue;
    const manifest = json(resolve(run, "manifest.json")),
      approved = report?.deployment_approved === true;
    rows.set(name, {
      id: name,
      state: report
        ? approved
          ? "qualified"
          : "rejected"
        : trained
          ? "evaluating"
          : "training",
      step: trained?.optimizer_steps ?? progress?.step ?? 0,
      totalSteps: progress?.total_steps ?? null,
      trainRows: manifest?.counts?.train ?? null,
      correct: report?.after?.base_action?.correct ?? null,
      total: report?.after?.base_action?.total ?? null,
      illegal: report?.after?.base_action?.illegal ?? null,
      broadApproved: report ? approved : null,
      normalizedApproved: null,
      profile: null,
      note: report
        ? "실제 가중치 학습과 분리한 평가 결과입니다."
        : trained
          ? "가중치 학습 완료 · 독립 평가 전"
          : "실제 optimizer 가중치 갱신 진행 중 · 아직 배포 승인 전",
    });
  }
  return [...rows.values()]
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
    .slice(0, 5);
}
export function operationsView(
  snapshot: FleetSnapshot,
  model: Operations["model"],
  training: Operations["training"],
  now = Date.now(),
): Operations {
  const { rules } = snapshot,
    latest = (kind: string) =>
      snapshot.observations
        .filter(
          (o) =>
            o.controllerEpoch === snapshot.controllerEpoch &&
            o.world === rules.world &&
            o.dimension === rules.dimension &&
            o.kind === kind,
        )
        .sort((a, b) => b.observedAt - a.observedAt);
  const container = latest("container").find(
      (o) =>
        o.kind === "container" &&
        rules.warehouse &&
        sameContainer(o.data.container, rules.warehouse),
    ),
    farm = latest("farm").find(
      (o) => o.kind === "farm" && o.data.id === rules.baseAutonomy?.id,
    );
  const stock = container?.kind === "container" ? container : undefined,
    field = farm?.kind === "farm" ? farm : undefined,
    stale = (time: number | undefined) =>
      time === undefined || now - time > rules.observationMaxAgeMs;
  const count = (name: string) =>
    stock ? itemCount(stock.data.items, name) : null;
  const decisions = snapshot.events
    .filter((e) => e.type === "scheduler.decision")
    .slice(-8)
    .reverse()
    .map((e) => {
      const observed = e.data?.observation;
      const candidates =
        observed && typeof observed === "object" && !Array.isArray(observed)
          ? observed.candidates
          : undefined;
      const selected = Array.isArray(candidates)
        ? candidates.find(
            (c) =>
              c &&
              typeof c === "object" &&
              !Array.isArray(c) &&
              c.id === (e.data?.selectedTaskId ?? e.taskId),
          )
        : undefined;
      const action =
        selected &&
        typeof selected === "object" &&
        !Array.isArray(selected) &&
        typeof selected.action === "string"
          ? selected.action
          : null;
      const task = snapshot.tasks.find((t) => t.id === e.taskId);
      return {
        time: e.time,
        action,
        taskKind: task?.kind ?? null,
        ...(e.botId ? { botId: e.botId } : {}),
        source: typeof e.data?.source === "string" ? e.data.source : "code",
        ...(typeof e.data?.model === "string" ? { model: e.data.model } : {}),
        ...(typeof e.data?.confidence === "number"
          ? { confidence: e.data.confidence }
          : {}),
        reason: e.message,
      };
    });
  return OperationsSchema.parse({
    observedAt: now,
    stock: {
      observedAt: stock?.observedAt ?? null,
      stale: stale(stock?.observedAt),
      bread: count("bread"),
      wheat: count("wheat"),
      seeds: count("wheat_seeds"),
      wood: count("oak_log"),
      breadTarget: rules.baseAutonomy?.breadTarget ?? 0,
      seedTarget: rules.baseAutonomy?.positions.length ?? 0,
    },
    farm: {
      id: rules.baseAutonomy?.id ?? null,
      planned: rules.baseAutonomy?.positions.length ?? 0,
      planted: field?.data.planted ?? null,
      watered: field?.data.watered ?? null,
      ripe: field?.data.ripe ?? null,
      observedAt: field?.observedAt ?? null,
      stale: stale(field?.observedAt),
    },
    bots: snapshot.agents
      .filter((a) => a.status !== "removed")
      .map((a) => ({
        id: a.id,
        name: a.config.name,
        action: a.session?.report?.action ?? "보고 대기",
        reason: a.session?.report?.reason ?? "현재 보고가 없습니다.",
        health: a.session?.report?.health ?? null,
        food: a.session?.report?.food ?? null,
        stale:
          !a.session || now - a.session.lastReportAt > rules.statusTimeoutMs,
      })),
    decisions,
    model,
    training,
  });
}
export function createOperationsReader(options: {
  snapshot: () => FleetSnapshot;
  modelUrl?: string;
  trainingRoot?: string;
  reportsDirectory?: string;
}) {
  let cached: Operations["model"] = {
    status: options.modelUrl ? "unavailable" : "unconfigured",
    checkedAt: 0,
  };
  return async () => {
    const now = Date.now();
    if (options.modelUrl && now - cached.checkedAt > 5000) {
      try {
        const r = await fetch(options.modelUrl.replace(/\/$/, "") + "/health", {
            signal: AbortSignal.timeout(2000),
          }),
          body = (await r.json()) as any;
        cached = {
          status: r.ok && body.status === "ready" ? "ready" : "unavailable",
          ...(typeof body.model === "string" ? { name: body.model } : {}),
          ...(typeof body.deployment_profile === "string"
            ? { profile: body.deployment_profile }
            : {}),
          checkedAt: now,
        };
      } catch {
        cached = { status: "unavailable", checkedAt: now };
      }
    }
    return operationsView(
      options.snapshot(),
      cached,
      trainingSummary(
        options.reportsDirectory ?? resolve("training/reports"),
        options.trainingRoot,
      ),
      now,
    );
  };
}
