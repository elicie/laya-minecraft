import { useEffect, useRef, useState } from "react";
import { Boxes, Flag, MapPin, Radio, Sprout, Users } from "lucide-react";
import type {
  Agent,
  CommandReceipt,
  FleetSnapshot,
} from "../../../packages/contracts/src";
import { BotDetail } from "./components/BotDetail";
import { Events } from "./components/Events";
import { BotForm, GoalForm, RulesForm, VillageForm } from "./components/Forms";
import { VillageMap } from "./components/VillageMap";
import { useFleet } from "./hooks/useFleet";
import { errorMessage, patch, post, request } from "./lib/api";
import { createRequestId } from "./lib/uuid";
import {
  actionLabels,
  isReportStale,
  label,
  localTime,
  percent,
  roleLabels,
} from "./lib/display";

type Modal = {
  kind: "bot" | "goal" | "village" | "rules";
  snapshot: FleetSnapshot;
  bot?: Agent;
  preferredBotId?: string;
};

export function App() {
  const fleet = useFleet();
  const { snapshot, connection, now, receipts } = fleet;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewerPaused, setViewerPaused] = useState(false);
  const [viewerConnection, setViewerConnection] = useState<{
    botId: string;
    commandId: string;
    session: string;
    confirmed: boolean;
  } | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const viewerQueue = useRef(Promise.resolve());
  const desiredViewer = useRef<string | null>(null);
  const currentViewer = useRef<string | null>(null);
  const currentViewerSession = useRef("");
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const live = connection === "live";
  const agents =
    snapshot?.agents.filter((bot) => bot.status !== "removed") ?? [];
  const selected = agents.find((bot) => bot.id === selectedId);
  const selectedAttemptId =
    selected?.session?.activeAttemptId ??
    selected?.session?.report?.currentAttemptId;
  const selectedAttempt = snapshot?.attempts.find(
    (attempt) => attempt.id === selectedAttemptId,
  );
  const selectedTask = snapshot?.tasks.find(
    (task) => task.id === selectedAttempt?.taskId,
  );
  const selectedGoal = snapshot?.goals.find(
    (goal) => goal.id === selectedTask?.goalId,
  );
  const activeGoals =
    snapshot?.goals.filter(
      (goal) => !["completed", "cancelled"].includes(goal.state),
    ) ?? [];
  const visibleGoals = [...(snapshot?.goals ?? [])]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 16);
  const online = agents.filter(
    (bot) =>
      bot.status === "ready" &&
      bot.session?.report?.ready &&
      !isReportStale(bot.session.lastReportAt, now),
  ).length;
  const working = agents.filter(
    (bot) =>
      bot.session?.report?.mode === "working" &&
      !isReportStale(bot.session.lastReportAt, now),
  ).length;
  const abnormal = agents.filter(
    (bot) =>
      bot.status === "abnormal" ||
      bot.session?.state === "abnormal" ||
      (bot.session &&
        bot.status !== "paused" &&
        bot.status !== "registered" &&
        isReportStale(bot.session.lastReportAt, now)),
  ).length;

  async function mutate(operation: () => Promise<CommandReceipt>) {
    setBusy(true);
    setError("");
    try {
      fleet.receiveReceipt(await operation());
    } catch (value) {
      setError(errorMessage(value));
      throw value;
    } finally {
      setBusy(false);
    }
  }

  function setViewer(id: string | null) {
    desiredViewer.current = id;
    if (id !== currentViewer.current) setViewerConnection(null);
    viewerQueue.current = viewerQueue.current
      .catch(() => {})
      .then(async () => {
        if (
          currentViewer.current &&
          currentViewer.current !== desiredViewer.current
        ) {
          const previous = currentViewer.current;
          try {
            fleet.receiveReceipt(
              await request<CommandReceipt>(
                `/bots/${encodeURIComponent(previous)}/viewer`,
                { method: "DELETE", body: "{}" },
              ),
            );
            currentViewer.current = null;
          } catch (value) {
            setError(errorMessage(value));
            setViewerPaused(true);
            return;
          }
        }
        const target = desiredViewer.current;
        if (target && currentViewer.current !== target) {
          currentViewer.current = target;
          const bot = snapshotRef.current?.agents.find(
            (bot) => bot.id === target,
          );
          currentViewerSession.current = `${snapshotRef.current?.controllerEpoch}:${bot?.session?.id}`;
          await post<CommandReceipt>(
            `/bots/${encodeURIComponent(target)}/viewer`,
          )
            .then((receipt) => {
              setViewerConnection({
                botId: target,
                commandId: receipt.id,
                session: currentViewerSession.current,
                confirmed: receipt.state === "applied",
              });
              fleet.receiveReceipt(receipt);
            })
            .catch((value) => {
              currentViewer.current = null;
              setError(errorMessage(value));
              setViewerPaused(true);
            });
        }
      });
  }

  function selectBot(bot: Agent) {
    setSelectedId(bot.id);
    setViewerPaused(false);
    if (
      live &&
      bot.session?.report?.ready &&
      !isReportStale(bot.session.lastReportAt, now)
    )
      setViewer(bot.id);
    else setViewer(null);
  }

  useEffect(() => {
    function releaseViewer() {
      if (currentViewer.current)
        void fetch(
          `/api/v1/bots/${encodeURIComponent(currentViewer.current)}/viewer`,
          {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              "X-Laya-Control": "1",
              "Idempotency-Key": createRequestId(),
            },
            body: "{}",
            keepalive: true,
          },
        );
    }
    window.addEventListener("pagehide", releaseViewer);
    return () => {
      window.removeEventListener("pagehide", releaseViewer);
      releaseViewer();
    };
  }, []);

  useEffect(() => {
    if (selectedId && snapshot && !selected) {
      setSelectedId(null);
      setViewer(null);
    }
  }, [selectedId, selected, snapshot]);

  useEffect(() => {
    if (!selectedId) return;
    const detail = document.querySelector<HTMLElement>(".bot-detail");
    if (detail) {
      detail.scrollTop = 0;
      if (window.matchMedia("(max-width: 1120px)").matches)
        detail.scrollIntoView({ block: "start" });
    }
  }, [selectedId]);

  useEffect(() => {
    if (!viewerConnection || viewerConnection.confirmed) return;
    const receipt = receipts[viewerConnection.commandId];
    if (receipt?.state === "applied")
      setViewerConnection({ ...viewerConnection, confirmed: true });
    else if (receipt?.state === "failed") {
      currentViewer.current = null;
      setViewerConnection(null);
      setViewerPaused(true);
      setError(receipt.error ?? "관전 화면을 준비하지 못했습니다.");
    }
  }, [viewerConnection, receipts]);

  useEffect(() => {
    if (
      live &&
      selected?.session?.report?.ready &&
      !viewerPaused &&
      selected.viewer.state === "stopped" &&
      !isReportStale(selected.session.lastReportAt, now)
    ) {
      const session = `${snapshot?.controllerEpoch}:${selected.session.id}`;
      if (
        currentViewer.current === selected.id &&
        currentViewerSession.current !== session
      )
        currentViewer.current = null;
      if (!currentViewer.current) setViewer(selected.id);
    }
  }, [live, selected, viewerPaused, now, snapshot?.controllerEpoch]);

  const connectionLabels = {
    connecting: "현황 연결 중",
    live: "중앙 시스템 연결됨",
    reconnecting: "현황 다시 연결 중",
    offline: "중앙 시스템 연결 끊김",
  };
  function open(
    kind: Modal["kind"],
    options: { bot?: Agent; preferredBotId?: string } = {},
  ) {
    if (snapshot && live) setModal({ kind, snapshot, ...options });
  }

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 32 34" aria-hidden="true">
            <path
              d="M16 1 31 9v16L16 33 1 25V9Z"
              fill="none"
              stroke="#b9e579"
              strokeWidth="1.4"
            />
            <path
              d="m1 9 15 8 15-8M16 17v16"
              fill="none"
              stroke="#b9e579"
              strokeWidth="1.4"
            />
            <path d="m8 5 15 8v15" fill="none" stroke="#b9e57966" />
          </svg>
          <div>
            <p className="brand-name">LAYA</p>
            <p className="brand-sub">마을 관제실</p>
          </div>
        </div>
        <div className="header-right">
          <span className="server-address mono">
            <Radio size={13} />
            {snapshot?.rules.world ?? "서버 확인 대기"}
          </span>
          <span className="connection" role="status">
            <i
              className={`status-dot ${live ? "online" : connection === "offline" ? "offline" : ""}`}
            />
            {connectionLabels[connection]}
          </span>
        </div>
      </header>
      <main className="workspace">
        <div className="overview-heading">
          <div>
            <p className="eyebrow">VILLAGE OVERVIEW</p>
            <h1>함께 만드는 마을</h1>
            <p className="description">
              봇의 움직임부터 목표의 진행까지, 한눈에 확인하세요.
            </p>
          </div>
          <div className="actions">
            <button
              className="quiet"
              disabled={!live || !snapshot}
              onClick={() => open("rules")}
            >
              운영 규칙
            </button>
            <button disabled={!live || !snapshot} onClick={() => open("bot")}>
              ＋ 봇 추가
            </button>
            <button
              className="primary"
              disabled={!live || !snapshot}
              onClick={() => open("goal")}
            >
              ＋ 목표 등록
            </button>
          </div>
        </div>
        {(error || fleet.error) && (
          <p className="notice error" role="alert">
            {error || fleet.error}
            <button
              className="quiet icon-button"
              style={{ float: "right", padding: "0 5px", border: 0 }}
              aria-label="알림 닫기"
              onClick={() => setError("")}
            >
              ×
            </button>
          </p>
        )}
        {!live && snapshot && (
          <p className="notice" role="status">
            현황 연결을 복구하고 있습니다. 화면의 값은 마지막으로 받은 상태이며,
            연결 후 변경 작업을 다시 사용할 수 있습니다.
          </p>
        )}
        {Object.values(receipts).length > 0 && (
          <div className="receipt-bar" aria-live="polite">
            {Object.values(receipts)
              .slice(-8)
              .map((receipt) => (
                <div className="receipt" key={receipt.id}>
                  <span>
                    {receipt.type.includes("viewer")
                      ? "관전"
                      : receipt.type.includes("goal")
                        ? "목표"
                        : receipt.type.includes("rule")
                          ? "규칙"
                          : "봇"}{" "}
                    요청
                  </span>
                  <span
                    className={`tag ${receipt.state === "failed" ? "danger" : receipt.state === "applied" ? "" : "warning"}`}
                  >
                    {label(receipt.state)}
                  </span>
                  {receipt.error && <span>{receipt.error}</span>}
                  {["applied", "failed"].includes(receipt.state) && (
                    <button
                      aria-label="요청 알림 닫기"
                      onClick={() => fleet.dismissReceipt(receipt.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
          </div>
        )}
        <div className="metrics">
          <Metric
            title="접속한 봇"
            value={snapshot ? online : undefined}
            suffix={snapshot ? `/ ${agents.length}` : ""}
            icon={<Users size={24} />}
          />
          <Metric
            title="작업 중"
            value={snapshot ? working : undefined}
            suffix="명"
            icon={<Boxes size={24} />}
          />
          <Metric
            title="진행할 목표"
            value={snapshot ? activeGoals.length : undefined}
            suffix="개"
            icon={<Flag size={24} />}
          />
          <Metric
            title="접속 이상"
            value={snapshot ? abnormal : undefined}
            suffix="명"
            icon={<Radio size={24} />}
          />
        </div>
        <div className="main-grid">
          <div className="main-column">
            <VillageMap
              snapshot={snapshot}
              selectedId={selectedId}
              onSelect={selectBot}
              now={now}
              onConfigure={() => open("village")}
            />
            <section className="panel goals-panel" aria-labelledby="goal-title">
              <div className="panel-heading">
                <div>
                  <h2 id="goal-title">마을의 목표</h2>
                  <p className="subtitle">
                    사용자 목표를 우선하고, 여유가 생기면 마을을 발전시킵니다
                  </p>
                </div>
                <span className="tag neutral">
                  {snapshot ? `${activeGoals.length}개 진행 예정` : "확인 대기"}
                </span>
              </div>
              {visibleGoals.length ? (
                <div className="goal-list">
                  {visibleGoals.map((goal) => {
                    const progress = percent(
                      goal.progress.current,
                      goal.progress.target,
                    );
                    const tasks = snapshot!.tasks.filter(
                      (task) =>
                        task.goalId === goal.id &&
                        task.generation === goal.generation,
                    );
                    return (
                      <article className="goal-row" key={goal.id}>
                        <div className="goal-row-top">
                          <h3 className="goal-title">{goal.title}</h3>
                          <span
                            className={`tag ${["held", "condition-wait"].includes(goal.state) ? "warning" : goal.state === "completed" ? "" : "neutral"}`}
                          >
                            {label(goal.state)}
                          </span>
                        </div>
                        <div className="goal-meta">
                          <span>
                            {goal.input.source === "user"
                              ? "사용자 목표"
                              : "마을 발전"}
                          </span>
                          <span>
                            {goal.input.mode === "maintain"
                              ? "계속 유지"
                              : "한 번 완료"}
                          </span>
                          {goal.progress.target !== undefined && (
                            <span>
                              {goal.progress.current} / {goal.progress.target}
                            </span>
                          )}
                          {tasks.length > 0 && (
                            <span>
                              작업{" "}
                              {
                                tasks.filter(
                                  (task) => task.state === "completed",
                                ).length
                              }{" "}
                              / {tasks.length}
                            </span>
                          )}
                        </div>
                        {progress !== undefined && (
                          <div
                            className="progress-track"
                            role="progressbar"
                            aria-label={`${goal.title} 진행률`}
                            aria-valuenow={Math.round(progress)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          >
                            <div
                              className="progress-fill"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                        )}
                        {goal.reason && (
                          <p className="reason" style={{ marginTop: 9 }}>
                            {goal.reason}
                          </p>
                        )}
                        {tasks.length > 0 && (
                          <details className="task-plan">
                            <summary>
                              작업 계획과 진행 · {tasks.length}개
                            </summary>
                            <ol>
                              {tasks.map((task) => (
                                <li key={task.id}>
                                  <span>{label(task.kind, actionLabels)}</span>
                                  <span className="muted">
                                    {label(task.state)}
                                  </span>
                                  {task.reason && <p>{task.reason}</p>}
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}
                        {!["completed", "cancelled"].includes(goal.state) && (
                          <div className="actions" style={{ marginTop: 9 }}>
                            <button
                              className="quiet"
                              style={{ fontSize: 10, padding: "4px 8px" }}
                              disabled={!live || busy}
                              onClick={() =>
                                void mutate(() =>
                                  post(
                                    `/goals/${encodeURIComponent(goal.id)}/cancel`,
                                  ),
                                ).catch(() => {})
                              }
                            >
                              목표 취소
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">
                  <Flag size={26} className="empty-icon" />
                  <strong>
                    {snapshot
                      ? "첫 목표를 등록해 보세요"
                      : "목표 현황 확인 대기"}
                  </strong>
                  <p>
                    {snapshot
                      ? "예: 원목 32개를 모아 공동 창고에 넣어 줘"
                      : "연결된 시스템의 실제 목표가 여기에 표시됩니다."}
                  </p>
                  <button disabled={!live} onClick={() => open("goal")}>
                    목표 등록
                  </button>
                </div>
              )}
            </section>
            <section className="panel bots-panel" aria-labelledby="bots-title">
              <div className="panel-heading">
                <div>
                  <h2 id="bots-title">함께하는 봇</h2>
                  <p className="subtitle">
                    봇을 선택하면 상세 상태와 실제 3D 화면이 열립니다
                  </p>
                </div>
                <span className="tag neutral">{agents.length}명</span>
              </div>
              {agents.length ? (
                <div className="bot-table-wrap">
                  <table className="bot-table">
                    <thead>
                      <tr>
                        <th>봇 · 역할</th>
                        <th>상태</th>
                        <th>현재 작업</th>
                        <th>체력 / 허기</th>
                        <th>
                          <span className="sr-only">상세 보기</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map((bot) => {
                        const report = bot.session?.report;
                        const stale =
                          !!bot.session &&
                          isReportStale(bot.session.lastReportAt, now);
                        const status =
                          stale && ["ready", "connecting"].includes(bot.status)
                            ? "abnormal"
                            : bot.status;
                        return (
                          <tr
                            key={bot.id}
                            className={selectedId === bot.id ? "selected" : ""}
                          >
                            <td>
                              <button onClick={() => selectBot(bot)}>
                                {bot.config.name}
                              </button>
                              <p className="bot-role">
                                {label(bot.config.role, roleLabels)}
                              </p>
                            </td>
                            <td>
                              <span
                                className={`tag ${status === "abnormal" ? "danger" : status === "ready" ? "" : "neutral"}`}
                              >
                                {label(status)}
                              </span>
                              {stale && report && (
                                <small
                                  style={{
                                    display: "block",
                                    color: "#8a9fac",
                                    marginTop: 4,
                                  }}
                                >
                                  지난 보고
                                </small>
                              )}
                            </td>
                            <td className="bot-job">
                              {report
                                ? label(report.action, actionLabels)
                                : "보고 대기"}
                            </td>
                            <td className="mono">
                              {report
                                ? `${report.health} / ${report.food}`
                                : "— / —"}
                            </td>
                            <td>
                              <button
                                className="quiet"
                                onClick={() => selectBot(bot)}
                                aria-label={`${bot.config.name} 상세 보기`}
                              >
                                보기 ↗
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state">
                  <Users size={26} className="empty-icon" />
                  <strong>
                    {snapshot
                      ? "아직 등록된 봇이 없습니다"
                      : "봇 현황 확인 대기"}
                  </strong>
                  <p>봇 수에 맞춰 현황과 작업 배정을 자동으로 조정합니다.</p>
                  <button disabled={!live} onClick={() => open("bot")}>
                    첫 봇 추가
                  </button>
                </div>
              )}
            </section>
          </div>
          <aside className="side-column">
            {selected ? (
              <BotDetail
                bot={selected}
                task={selectedTask}
                goal={selectedGoal}
                now={now}
                live={live}
                events={snapshot?.events ?? []}
                viewerPaused={viewerPaused}
                viewerConfirmed={
                  viewerConnection?.botId === selected.id &&
                  viewerConnection.session ===
                    `${snapshot?.controllerEpoch}:${selected.session?.id}` &&
                  viewerConnection.confirmed
                }
                busy={busy}
                onClose={() => {
                  setSelectedId(null);
                  setViewer(null);
                }}
                onEdit={() => open("bot", { bot: selected })}
                onGoal={() => open("goal", { preferredBotId: selected.id })}
                onAction={(action) =>
                  void mutate(() =>
                    post(`/bots/${encodeURIComponent(selected.id)}/${action}`),
                  ).catch(() => {})
                }
                onViewerToggle={() => {
                  const paused =
                    !viewerPaused && selected.viewer.state !== "failed";
                  if (selected.viewer.state === "failed")
                    currentViewer.current = null;
                  setViewerPaused(paused);
                  setViewer(paused ? null : selected.id);
                }}
              />
            ) : (
              <section className="panel observation-placeholder">
                <div className="panel-heading">
                  <h2>봇 관찰</h2>
                  <span className="tag neutral">선택 대기</span>
                </div>
                <div className="empty-state" style={{ minHeight: 215 }}>
                  <Radio size={28} className="empty-icon" />
                  <strong>어떤 봇을 살펴볼까요?</strong>
                  <p>
                    지도나 목록에서 봇을 선택하세요.
                    <br />
                    행동, 판단 이유와 3D 화면을 확인할 수 있습니다.
                  </p>
                </div>
              </section>
            )}
            <section className="panel village-activity">
              <div className="panel-heading">
                <h2>마을 활동</h2>
                <Sprout size={16} color="#94b47e" />
              </div>
              <div className="event-panel">
                <Events
                  events={snapshot?.events ?? []}
                  label="마을 활동 기록"
                  botNames={Object.fromEntries(
                    (snapshot?.agents ?? []).map((bot) => [
                      bot.id,
                      bot.config.name,
                    ]),
                  )}
                />
              </div>
            </section>
            <section className="panel village-settings">
              <div className="panel-heading">
                <h2>마을 설정</h2>
                <MapPin size={16} color="#8bb4c3" />
              </div>
              <div className="detail-section">
                <p className="reason">
                  {snapshot?.rules.center
                    ? `중심 X ${snapshot.rules.center.x} · Y ${snapshot.rules.center.y} · Z ${snapshot.rules.center.z}`
                    : "중심 좌표 미지정"}
                </p>
                <p className="reason" style={{ marginTop: 6 }}>
                  {snapshot
                    ? `반경 ${snapshot.rules.radius} 블록 · ${snapshot.rules.dimension}`
                    : "마을 설정 확인 대기"}
                </p>
                <p className="reason" style={{ marginTop: 6 }}>
                  공동 창고 · {snapshot?.rules.warehouse?.id ?? "미지정"}
                </p>
                <div className="detail-controls">
                  <button disabled={!live} onClick={() => open("village")}>
                    설정 변경
                  </button>
                </div>
              </div>
            </section>
          </aside>
        </div>
        <footer className="page-footer">
          <span>
            실제 보고를 기준으로 표시 · 봇 보고 1초 · 10초 무응답 시 접속 이상
          </span>
          <span>
            {snapshot
              ? `최근 갱신 ${localTime(snapshot.updatedAt)}`
              : "아직 현황을 받지 못했습니다"}
          </span>
        </footer>
      </main>
      {modal?.kind === "bot" && (
        <BotForm
          bot={modal.bot}
          snapshot={modal.snapshot}
          onClose={() => setModal(null)}
          onSave={(input, mode) =>
            mutate(() =>
              modal.bot
                ? patch(`/bots/${encodeURIComponent(modal.bot.id)}`, {
                    patch: input,
                    mode,
                  })
                : post("/bots", input),
            )
          }
        />
      )}
      {modal?.kind === "goal" && (
        <GoalForm
          snapshot={modal.snapshot}
          preferredBotId={modal.preferredBotId}
          onClose={() => setModal(null)}
          onSave={(goal) => mutate(() => post("/goals", goal))}
        />
      )}
      {modal?.kind === "village" && (
        <VillageForm
          snapshot={modal.snapshot}
          onClose={() => setModal(null)}
          onSave={(value) =>
            mutate(() => patch("/rules", { patch: value, mode: "queued" }))
          }
        />
      )}
      {modal?.kind === "rules" && (
        <RulesForm
          snapshot={modal.snapshot}
          onClose={() => setModal(null)}
          onSave={(value, mode) =>
            mutate(() => patch("/rules", { patch: value, mode }))
          }
        />
      )}
    </>
  );
}

function Metric({
  title,
  value,
  suffix,
  icon,
}: {
  title: string;
  value?: number;
  suffix: string;
  icon: React.ReactNode;
}) {
  return (
    <section className="metric">
      <div>
        <p className="metric-label">{title}</p>
        <p className="metric-value">
          {value ?? "—"}
          <small>{value === undefined ? "" : suffix}</small>
        </p>
      </div>
      <div className="metric-icon" aria-hidden="true">
        {icon}
      </div>
    </section>
  );
}
