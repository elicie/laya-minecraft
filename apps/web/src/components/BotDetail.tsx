import type {
  Agent,
  CoreEvent,
  Goal,
  Task,
} from "../../../../packages/contracts/src";
import {
  actionLabels,
  isReportStale,
  label,
  localTime,
  percent,
  positionText,
  roleLabels,
  safeViewerUrl,
} from "../lib/display";
import { Events } from "./Events";

export function BotDetail({
  bot,
  task,
  goal,
  now,
  live,
  events,
  viewerPaused,
  busy,
  onClose,
  onEdit,
  onGoal,
  onAction,
  onViewerToggle,
}: {
  bot: Agent;
  now: number;
  live: boolean;
  events: CoreEvent[];
  viewerPaused: boolean;
  busy: boolean;
  task?: Task;
  goal?: Goal;
  onClose: () => void;
  onEdit: () => void;
  onGoal: () => void;
  onAction: (action: "pause" | "resume" | "remove") => void;
  onViewerToggle: () => void;
}) {
  const report = bot.session?.report;
  const stale = !live || isReportStale(bot.session?.lastReportAt, now);
  const viewerUrl = safeViewerUrl(bot.viewer.prefix, bot.id);
  const viewing =
    !stale && !viewerPaused && bot.viewer.state === "ready" && viewerUrl;
  return (
    <section
      className="panel bot-detail"
      aria-label={`${bot.config.name} 상세 상태`}
    >
      <div className="detail-heading">
        <div>
          <h2>{bot.config.name}</h2>
          <small>
            {label(bot.config.role, roleLabels)} ·{" "}
            {stale && bot.session ? "지난 보고 상태" : label(bot.status)}
          </small>
        </div>
        <button
          className="quiet icon-button"
          aria-label="봇 상세 닫기"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {viewing ? (
        <iframe
          className="viewer"
          title={`${bot.config.name} 실시간 3D 화면`}
          src={viewerUrl}
          referrerPolicy="same-origin"
        />
      ) : (
        <div className="viewer-placeholder">
          <span style={{ fontSize: 26 }}>◇</span>
          <p>
            {viewerPaused
              ? "관전을 잠시 멈췄습니다."
              : stale
                ? "봇 연결 확인 후 3D 화면을 엽니다."
                : bot.viewer.state === "failed"
                  ? "관전 화면을 준비하지 못했습니다."
                  : "실제 3D 화면을 준비하고 있습니다."}
          </p>
          {bot.viewer.state === "failed" && (
            <button disabled={!live || busy} onClick={onViewerToggle}>
              다시 연결
            </button>
          )}
        </div>
      )}
      <div className="viewer-toolbar">
        <span>{viewing ? "실시간 관전" : "관전 대기"} · 선택한 봇 한 대</span>
        <button disabled={!live || busy} onClick={onViewerToggle}>
          {viewerPaused || bot.viewer.state === "failed"
            ? "관전 재개"
            : "관전 멈춤"}
        </button>
      </div>
      <div className="detail-section">
        <div className="vitals">
          <div>
            <div className="vital-head">
              <span>체력</span>
              <b>{report ? `${report.health} / 20` : "—"}</b>
            </div>
            <div className="vital-track">
              <span
                style={{ width: `${percent(report?.health ?? 0, 20) ?? 0}%` }}
              />
            </div>
          </div>
          <div>
            <div className="vital-head">
              <span>허기</span>
              <b>{report ? `${report.food} / 20` : "—"}</b>
            </div>
            <div className="vital-track food">
              <span
                style={{ width: `${percent(report?.food ?? 0, 20) ?? 0}%` }}
              />
            </div>
          </div>
        </div>
        <p className="coordinates">{positionText(report?.position)}</p>
        {report && (
          <p className="muted" style={{ fontSize: 10, marginTop: 6 }}>
            {report.dimension} · {stale ? "마지막 보고" : "보고"}{" "}
            {localTime(bot.session!.lastReportAt)}
          </p>
        )}
      </div>
      <div className="detail-section">
        <h3>현재 하는 일</h3>
        {goal && (
          <p className="reason" style={{ marginBottom: 7 }}>
            목표 · {goal.title}
          </p>
        )}
        <p className="current-action">
          {report ? label(report.action, actionLabels) : "봇 보고 대기"}
        </p>
        {task && (
          <p className="muted" style={{ fontSize: 10, marginBottom: 7 }}>
            현재 작업 · {label(task.kind, actionLabels)} · {label(task.state)}
          </p>
        )}
        <p className="reason">
          {report?.reason || "연결되면 행동과 판단 이유를 표시합니다."}
        </p>
        {report?.mode === "emergency" && (
          <p
            className="tag danger"
            style={{ display: "inline-block", marginTop: 10 }}
          >
            위험 대응 중
          </p>
        )}
        {(bot.desiredConfig ||
          bot.session?.pendingRulesVersion ||
          bot.pendingCommandIds.length > 0) && (
          <p
            className="tag warning"
            style={{ display: "inline-block", marginTop: 10 }}
          >
            설정 실제 적용 대기
          </p>
        )}
        <div className="detail-controls">
          <button disabled={!live || busy} onClick={onGoal}>
            이 봇으로 목표
          </button>
          <button disabled={!live || busy} onClick={onEdit}>
            역할 · 설정
          </button>
          <button
            disabled={
              !live ||
              busy ||
              bot.status === "removing" ||
              bot.status === "removed"
            }
            onClick={() =>
              onAction(bot.status === "paused" ? "resume" : "pause")
            }
          >
            {bot.status === "paused" ? "작업 재개" : "작업 일시정지"}
          </button>
          <button
            className="danger"
            disabled={
              !live ||
              busy ||
              bot.status === "removing" ||
              bot.status === "removed"
            }
            onClick={() => onAction("remove")}
          >
            {bot.status === "removing" ? "안전 종료 중" : "봇 제거"}
          </button>
        </div>
      </div>
      <div className="detail-section">
        <h3>
          인벤토리{" "}
          <span className="muted" style={{ fontSize: 10 }}>
            {stale && report ? "· 마지막 관측" : ""}
          </span>
        </h3>
        {report?.inventory.length ? (
          <div className="inventory">
            {report.inventory.map((item, index) => (
              <div
                className="inventory-item"
                key={`${item.name}:${index}`}
                title={item.name}
              >
                <span>{item.name.replaceAll("_", " ")}</span>
                <b>{item.count}</b>
              </div>
            ))}
          </div>
        ) : (
          <p className="reason">
            {report ? "인벤토리가 비어 있습니다." : "인벤토리 관측 대기"}
          </p>
        )}
      </div>
      <div className="detail-section">
        <h3>최근 활동</h3>
        <Events
          events={events.filter((event) => event.botId === bot.id)}
          label="최근 봇 활동 기록"
        />
      </div>
    </section>
  );
}
