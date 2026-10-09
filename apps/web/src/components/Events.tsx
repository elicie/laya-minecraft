import type { CoreEvent } from "../../../../packages/contracts/src";
import { useState } from "react";
import { localTime } from "../lib/display";

const RECENT_COUNT = 6;

export function Events({
  events,
  empty = "아직 활동 기록이 없습니다.",
  label = "활동 기록",
  botNames,
}: {
  events: CoreEvent[];
  empty?: string;
  label?: string;
  botNames?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = (expanded ? events : events.slice(-RECENT_COUNT))
    .slice()
    .reverse();
  if (!events.length)
    return (
      <div className="empty-state">
        <p>{empty}</p>
      </div>
    );
  return (
    <div className="activity">
      <div
        className="activity-scroll"
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        <ol className="activity-list">
          {visible.map((event) => (
            <li key={event.id}>
              <time dateTime={new Date(event.time).toISOString()}>
                {localTime(event.time)}
              </time>
              <div>
                <p>{event.message}</p>
                {event.botId && botNames?.[event.botId] && (
                  <small>{botNames[event.botId]}</small>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
      {events.length > RECENT_COUNT && (
        <button
          className="quiet activity-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? `최근 ${RECENT_COUNT}건만 보기`
            : `전체 기록 ${events.length}건 보기`}
        </button>
      )}
    </div>
  );
}
