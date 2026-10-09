import type { CoreEvent } from "../../../../packages/contracts/src";
import { localTime } from "../lib/display";

export function Events({
  events,
  empty = "아직 활동 기록이 없습니다.",
}: {
  events: CoreEvent[];
  empty?: string;
}) {
  if (!events.length)
    return (
      <div className="empty-state">
        <p>{empty}</p>
      </div>
    );
  return (
    <ol className="activity-list">
      {events
        .slice(-30)
        .reverse()
        .map((event) => (
          <li key={event.id}>
            <time dateTime={new Date(event.time).toISOString()}>
              {localTime(event.time)}
            </time>
            <div>
              <p>{event.message}</p>
              <small>
                {event.botId
                  ? `봇 · ${event.botId}`
                  : event.goalId
                    ? "목표 변경"
                    : event.type}
              </small>
            </div>
          </li>
        ))}
    </ol>
  );
}
