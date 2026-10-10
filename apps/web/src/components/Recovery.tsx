import type { Agent, CoreEvent } from "../../../../packages/contracts/src";
import { latestRecovery, localTime, positionText } from "../lib/display";

const phases = {
  "waiting-respawn": "부활 대기",
  recovering: "아이템 회수 중",
  held: "회수 조건 대기",
  resolved: "회수 확인 종료",
};

export function Recovery({ bot, events }: { bot: Agent; events: CoreEvent[] }) {
  const state = latestRecovery(bot);
  const pending = !!state && (state.phase !== "resolved" || !state.safe);
  const support = events.filter(event => event.botId === bot.id && ["support.requested", "support.unavailable", "support.expired"].includes(event.type))
    .sort((a, b) => b.time - a.time)[0];
  const showSupport = support && (bot.session?.report?.mode === "emergency" || pending) && (!state || support.time >= state.occurredAt);
  if (!state && !showSupport) return null;
  return <div className="recovery-status" role="region" aria-label="사망과 복구 상태">
    {state && <>
      <h3>사망 후 복구 <span className={`tag ${state.safe && state.phase === "resolved" ? "" : "warning"}`}>{phases[state.phase]}</span></h3>
      <p className="muted">사망 {localTime(state.occurredAt)} · {positionText(state.position)}</p>
      <p className="recovery-counts">보유·회수 확인 <b>{state.progress.recoveredCount}개</b> · 미회수 <b>{state.progress.remainingCount}개</b></p>
      <p className="reason">{state.reason}</p>
      <p className="muted">회수 시도 {state.attemptCount} / 5 · {state.safe ? "현재 위치 안전 확인" : "현재 위치 안전 확인 대기"}</p>
      {state.phase === "resolved" && state.progress.remainingCount > 0 && <p className="reason">미회수 물자는 실제 재고를 확인한 뒤 다시 준비합니다.</p>}
      {pending && <p className="muted">기존 목표와 진행은 보존하며, 복구와 안전을 확인한 뒤 남은 작업을 재개합니다.</p>}
    </>}
    {showSupport && <p className="reason support-status"><b>{support.type === "support.unavailable" ? "지원 가능한 동료 없음" : support.type === "support.expired" ? "지원 요청 종료" : "동료 지원 요청"}</b> · {support.message}</p>}
  </div>;
}
