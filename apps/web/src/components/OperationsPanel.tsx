import { useEffect, useState } from "react";
import {
  OperationsSchema,
  type Operations,
} from "../../../../packages/contracts/src";
import { request } from "../lib/api";
const value = (n: number | null) =>
  n === null ? "미관측" : n.toLocaleString("ko-KR");
const time = (n: number | null) =>
  n === null
    ? "관측 없음"
    : new Date(n).toLocaleTimeString("ko-KR", { hour12: false });
const workflows: Record<string, string> = {
  seed_supply: "씨앗 보급",
  wood_supply: "목재 보급",
  farm_setup: "밭 조성",
  farm_harvest: "수확·재파종",
  bake_food: "빵 생산",
  base_return: "거점 귀환",
  warehouse_store: "창고 입고",
  warehouse_take: "창고 출고",
  tool_craft: "도구 제작",
  explore: "탐색",
  shelter: "거점 대피",
  wait: "조건 대기",
};
const stateLabels = {
  training: "학습 중",
  evaluating: "평가 대기",
  qualified: "범위 제한 승인",
  rejected: "배포 미승인",
};
export function OperationsPanel() {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Operations | null>(null),
    [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = OperationsSchema.parse(
          await request("/operations", { signal: controller.signal }),
        );
        if (!controller.signal.aborted) {
          setData(next);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [open]);
  return (
    <section
      className="panel operations-panel"
      aria-labelledby="operations-title"
    >
      <div className="panel-heading">
        <div>
          <h2 id="operations-title">식량·농장·모델·학습</h2>
          <p>실제 재고와 성장 상태, 현재 판단 모델과 평가 결과를 확인합니다.</p>
        </div>
        <button
          className="quiet"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "현황 접기" : "생산·학습 현황 보기"}
        </button>
      </div>
      {open && (
        <div className="operations-content">
          {error && (
            <p role="status">
              운영 현황 연결을 확인하고 있습니다. 마지막으로 받은 값은
              유지합니다.
            </p>
          )}
          {!data && !error && (
            <p role="status">실제 운영 현황을 불러오고 있습니다.</p>
          )}
          {data && (
            <>
              <div className="operations-grid">
                <article>
                  <h3>
                    창고 식량{" "}
                    <span
                      className={`tag ${data.stock.stale ? "warning" : ""}`}
                    >
                      {data.stock.stale ? "지난 관측" : "최근 관측"}
                    </span>
                  </h3>
                  <strong>
                    빵 {value(data.stock.bread)} / 목표 {data.stock.breadTarget}
                    개
                  </strong>
                  <p>
                    밀 {value(data.stock.wheat)} · 씨앗{" "}
                    {value(data.stock.seeds)} / 목표 {data.stock.seedTarget} ·
                    원목 {value(data.stock.wood)}
                  </p>
                  <small>직접 상자 관측 {time(data.stock.observedAt)}</small>
                </article>
                <article>
                  <h3>
                    농장{" "}
                    <span className={`tag ${data.farm.stale ? "warning" : ""}`}>
                      {data.farm.stale ? "지난 관측" : "최근 관측"}
                    </span>
                  </h3>
                  <strong>
                    성숙 {value(data.farm.ripe)} · 심음{" "}
                    {value(data.farm.planted)} / 계획 {data.farm.planned}칸
                  </strong>
                  <p>
                    수분 확인 {value(data.farm.watered)}칸 ·{" "}
                    {data.farm.id ?? "농장 미설정"}
                  </p>
                  <small>실제 작물 관측 {time(data.farm.observedAt)}</small>
                </article>
                <article>
                  <h3>
                    현재 판단 모델{" "}
                    <span
                      className={`tag ${data.model.status === "ready" ? "" : "warning"}`}
                    >
                      {data.model.status === "ready"
                        ? "응답 정상"
                        : data.model.status === "unconfigured"
                          ? "코드 판단"
                          : "응답 확인 필요"}
                    </span>
                  </h3>
                  <strong>{data.model.name ?? "모델 미확인"}</strong>
                  <p>{data.model.profile ?? "승인 범위 미확인"}</p>
                  <small>모델 응답과 실제 작업 완료는 별도로 검증합니다.</small>
                </article>
              </div>
              <h3>봇의 현재 작업과 대기 사유</h3>
              <div className="operations-grid">
                {data.bots.map((bot) => (
                  <article key={bot.id}>
                    <strong>
                      {bot.name} · {bot.action}
                    </strong>
                    <p>{bot.reason}</p>
                    <small>
                      체력 {value(bot.health)} · 허기 {value(bot.food)}
                      {bot.stale ? " · 지난 보고" : ""}
                    </small>
                  </article>
                ))}
              </div>
              <h3>실제 모델 학습과 평가</h3>
              {data.training.length === 0 ? (
                <p>
                  기록된 학습 결과가 없습니다. 플레이 로그 수집은 모델 학습과
                  별개입니다.
                </p>
              ) : (
                data.training.map((run) => (
                  <article className="training-run" key={run.id}>
                    <div>
                      <strong>{run.id}</strong>{" "}
                      <span
                        className={`tag ${run.state === "rejected" ? "danger" : run.state === "qualified" ? "" : "warning"}`}
                      >
                        {stateLabels[run.state]}
                      </span>
                    </div>
                    <p>
                      가중치 갱신 {run.step}
                      {run.totalSteps === null
                        ? ""
                        : ` / ${run.totalSteps}`}{" "}
                      단계 · 학습 항목 {value(run.trainRows)}개
                      {run.total !== null
                        ? ` · 승인 범위 평가 ${value(run.correct)} / ${run.total} · 허용 밖 선택 ${value(run.illegal)}`
                        : ""}
                    </p>
                    <p>
                      {run.profile ? `입력 범위 ${run.profile} · ` : ""}원문
                      확장 질문 평가{" "}
                      {run.broadApproved === true
                        ? "통과"
                        : run.broadApproved === false
                          ? "미통과"
                          : "평가 전"}
                      {run.normalizedApproved === true
                        ? " · 검증한 질문 표현 정규화 후 통과"
                        : ""}
                    </p>
                    <small>{run.note}</small>
                  </article>
                ))
              )}
              <h3>최근 판단 기록</h3>
              {data.decisions.length === 0 ? (
                <p>아직 기록된 작업 판단이 없습니다.</p>
              ) : (
                <ol className="operations-decisions">
                  {data.decisions.map((d, i) => (
                    <li key={`${d.time}-${i}`}>
                      <time>{time(d.time)}</time>{" "}
                      <strong>
                        {d.source === "laya"
                          ? (d.model ?? "모델")
                          : "코드 판단"}
                      </strong>
                      {d.confidence === undefined
                        ? ""
                        : ` · 신뢰도 ${Math.round(d.confidence * 100)}%`}
                      <p>
                        {d.action
                          ? `${workflows[d.action] ?? d.action} · `
                          : ""}
                        {d.reason}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
              <small>
                현황 갱신 {time(data.observedAt)} · 미관측 값을 재고 0이나
                완료로 처리하지 않습니다.
              </small>
            </>
          )}
        </div>
      )}
    </section>
  );
}
