import { useEffect, useId, useRef, useState } from "react";
import type {
  Agent,
  FleetSnapshot,
  Position,
} from "../../../../packages/contracts/src";
import { finitePosition, isReportStale } from "../lib/display";

const colors: Record<string, string> = {
  guard: "#e8a191",
  hunter: "#ddbe84",
  farmer: "#b9e579",
  builder: "#8ac6d0",
  rancher: "#b5a9de",
  gatherer: "#9dd4b3",
  general: "#d4dfe5",
};

export function VillageMap({
  snapshot,
  selectedId,
  onSelect,
  now,
  onConfigure,
}: {
  snapshot: FleetSnapshot | null;
  selectedId: string | null;
  onSelect: (bot: Agent) => void;
  now: number;
  onConfigure: () => void;
}) {
  const patternId = useId().replaceAll(":", "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 900, height: 360 });
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0)
        setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(svgRef.current!);
    return () => observer.disconnect();
  }, []);
  const rules = snapshot?.rules;
  const bots =
    snapshot?.agents.filter(
      (bot) =>
        bot.status !== "removed" &&
        finitePosition(bot.session?.report?.position) &&
        bot.session?.report?.world === rules?.world &&
        bot.session.report.dimension === rules?.dimension,
    ) ?? [];
  const center = rules?.center ??
    bots[0]?.session?.report?.position ?? { x: 0, y: 64, z: 0 };
  const radius = rules?.radius ?? 64;
  const { width, height } = size;
  const scale = (Math.min(width, height) * 0.4) / Math.max(1, radius);
  const xy = (point: Position) => ({
    x: width / 2 + (point.x - center.x) * scale,
    y: height / 2 + (point.z - center.z) * scale,
  });
  const inView = (point: Position) => {
    const p = xy(point);
    return p.x >= 10 && p.x <= width - 10 && p.y >= 10 && p.y <= height - 10;
  };
  const warehouse = rules?.warehouse;
  const observations =
    snapshot?.observations.filter(
      (item) =>
        item.world === rules?.world &&
        item.dimension === rules?.dimension &&
        now - item.observedAt <= (rules?.observationMaxAgeMs ?? 30_000),
    ) ?? [];
  const observedBlocks = observations
    .flatMap((item) =>
      item.kind === "blocks"
        ? item.data.blocks
        : item.kind === "exploration"
          ? item.data.resources
          : [],
    )
    .slice(-1200);
  const outsideDimension =
    (snapshot?.agents.filter(
      (bot) => bot.session?.report?.position && bot.status !== "removed",
    ).length ?? 0) - bots.length;
  const visibleBots = bots.filter((bot) =>
    inView(bot.session!.report!.position!),
  );
  const hiddenBots = bots.length - visibleBots.length;

  return (
    <section className="panel map-panel" aria-labelledby="map-title">
      <div className="panel-heading">
        <div>
          <h2 id="map-title">마을 지도</h2>
          <p className="subtitle">관측한 위치와 자원만 표시합니다</p>
        </div>
        <div className="actions">
          <button disabled={!snapshot} onClick={onConfigure}>
            마을 설정
          </button>
        </div>
      </div>
      <div className="map-wrap">
        <svg
          ref={svgRef}
          className="village-map"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="마을 중심, 범위와 관측된 봇 위치"
        >
          <defs>
            <pattern
              id={patternId}
              width="32"
              height="32"
              patternUnits="userSpaceOnUse"
            >
              <path d="M 32 0 L 0 0 0 32" fill="none" className="map-grid" />
            </pattern>
          </defs>
          <rect width={width} height={height} fill={`url(#${patternId})`} />
          {rules?.center && (
            <>
              <circle
                cx={width / 2}
                cy={height / 2}
                r={radius * scale}
                className="map-bounds"
              />
              <path
                d={`M${width / 2 - 7} ${height / 2}h14 M${width / 2} ${height / 2 - 7}v14`}
                stroke="#b9e579"
                strokeWidth="1.5"
              />
              <text
                x={width / 2}
                y={height / 2 + 20}
                textAnchor="middle"
                className="map-label"
              >
                마을 중심
              </text>
            </>
          )}
          {observedBlocks
            .filter(
              (block) =>
                finitePosition(block.position) && inView(block.position),
            )
            .map((block, index) => {
              const p = xy(block.position);
              const color = block.name.includes("log")
                ? "#709765"
                : block.name.includes("ore")
                  ? "#9d9584"
                  : block.name.includes("water")
                    ? "#518797"
                    : "#627f79";
              return (
                <rect
                  key={`${block.position.x}:${block.position.y}:${block.position.z}:${index}`}
                  x={p.x - 1.5}
                  y={p.y - 1.5}
                  width={3}
                  height={3}
                  fill={color}
                >
                  <title>
                    {block.name} · X {block.position.x} Z {block.position.z}
                  </title>
                </rect>
              );
            })}
          {warehouse &&
            warehouse.world === rules?.world &&
            warehouse.dimension === rules?.dimension &&
            inView(warehouse.position) &&
            (() => {
              const p = xy(warehouse.position);
              return (
                <g>
                  <rect
                    x={p.x - 5}
                    y={p.y - 5}
                    width={10}
                    height={10}
                    rx="1"
                    fill="#dbbc7e"
                  />
                  <text x={p.x + 10} y={p.y + 3} className="map-label">
                    공동 창고
                  </text>
                </g>
              );
            })()}
          {visibleBots.map((bot) => {
            const p = xy(bot.session!.report!.position!);
            const selected = selectedId === bot.id;
            const stale = isReportStale(bot.session?.lastReportAt, now);
            return (
              <g
                key={bot.id}
                className={`map-marker${selected ? " selected" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`지도에서 ${bot.config.name} 상세 보기${stale ? ", 지난 관측 위치" : ""}`}
                onClick={() => onSelect(bot)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(bot);
                  }
                }}
              >
                <circle
                  className="marker-ring"
                  cx={p.x}
                  cy={p.y}
                  r={selected ? 12 : 9}
                  fill={selected ? "#b9e57922" : "#14242d"}
                  stroke={selected ? "#b9e579" : "#2b444c"}
                />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r="4"
                  fill={
                    stale
                      ? "#788f9a"
                      : (colors[bot.config.role] ?? colors.general)
                  }
                />
                <title>
                  {bot.config.name} · {bot.config.role}
                  {stale ? " · 지난 관측 위치" : ""}
                </title>
                <text
                  className="marker-label"
                  x={p.x}
                  y={p.y - 16}
                  textAnchor="middle"
                >
                  {bot.config.name}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="map-overlay">
          {rules
            ? `${rules.dimension} · 반경 ${radius} 블록`
            : "마을 상태 확인 중"}
        </div>
        <div className="map-compass">N ↑</div>
        {!rules?.center && (
          <div className="map-empty">
            <strong>
              {snapshot
                ? "마을 중심을 지정해 주세요"
                : "마을 관측을 기다리고 있습니다"}
            </strong>
            <p>
              {snapshot
                ? "마을 설정에서 중심 좌표와 반경을 정할 수 있습니다."
                : "중앙 시스템에 연결되면 실제 현황을 표시합니다."}
            </p>
          </div>
        )}
      </div>
      <div className="map-footer">
        <div className="legend">
          <span className="legend-item">
            <i className="legend-color" style={{ background: "#b9e579" }} />봇
          </span>
          <span className="legend-item">
            <i className="legend-color" style={{ background: "#dbbc7e" }} />
            창고
          </span>
          <span className="legend-item">
            <i className="legend-color" style={{ background: "#709765" }} />
            관측 자원
          </span>
          <span className="legend-item">
            <i className="legend-color" style={{ background: "#788f9a" }} />
            지난 위치
          </span>
        </div>
        <span>
          {hiddenBots || outsideDimension
            ? `화면 밖 ${hiddenBots} · 다른 월드/차원 ${outsideDimension}`
            : "미관측 지형은 비워 둡니다"}
        </span>
      </div>
    </section>
  );
}
