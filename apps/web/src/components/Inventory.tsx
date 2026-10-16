import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type {
  BotReport,
  InventorySlotItem,
} from "../../../../packages/contracts/src";
import { getItemIcon } from "../lib/item-icons";

const names: Record<string, string> = {
  oak_log: "참나무 원목",
  spruce_log: "가문비나무 원목",
  birch_log: "자작나무 원목",
  oak_planks: "참나무 판자",
  spruce_planks: "가문비나무 판자",
  birch_planks: "자작나무 판자",
  dirt: "흙",
  cobblestone: "조약돌",
  stone: "돌",
  stone_bricks: "석재 벽돌",
  wheat: "밀",
  wheat_seeds: "밀 씨앗",
  bread: "빵",
  apple: "사과",
  carrot: "당근",
  potato: "감자",
  cooked_beef: "스테이크",
  cooked_porkchop: "익힌 돼지고기",
  cooked_chicken: "익힌 닭고기",
  iron_ingot: "철괴",
  gold_ingot: "금괴",
  diamond: "다이아몬드",
  coal: "석탄",
  stick: "막대기",
  chest: "상자",
  crafting_table: "제작대",
  furnace: "화로",
  torch: "횃불",
  shield: "방패",
  bucket: "양동이",
  water_bucket: "물 양동이",
  white_bed: "흰색 침대",
  bow: "활",
  crossbow: "쇠뇌",
};
const materials: Record<string, string> = {
  wooden: "나무",
  stone: "돌",
  iron: "철",
  golden: "금",
  diamond: "다이아몬드",
  netherite: "네더라이트",
  leather: "가죽",
  chainmail: "사슬",
};
const equipment: Record<string, string> = {
  sword: "검",
  pickaxe: "곡괭이",
  axe: "도끼",
  shovel: "삽",
  hoe: "괭이",
  helmet: "투구",
  chestplate: "흉갑",
  leggings: "각반",
  boots: "부츠",
};
const enchantments: Record<string, string> = {
  sharpness: "날카로움",
  smite: "강타",
  bane_of_arthropods: "살충",
  efficiency: "효율",
  unbreaking: "내구성",
  mending: "수선",
  fortune: "행운",
  silk_touch: "섬세한 손길",
  protection: "보호",
  fire_protection: "화염으로부터 보호",
  blast_protection: "폭발로부터 보호",
  projectile_protection: "발사체로부터 보호",
  feather_falling: "가벼운 착지",
  power: "힘",
  infinity: "무한",
  flame: "화염",
  looting: "약탈",
  respiration: "호흡",
  aqua_affinity: "친수성",
  depth_strider: "물갈퀴",
  frost_walker: "차가운 걸음",
  thorns: "가시",
  knockback: "밀치기",
  fire_aspect: "발화",
  binding_curse: "귀속 저주",
  vanishing_curse: "소실 저주",
};
function itemName(item: InventorySlotItem): string {
  if (item.customName || item.displayName)
    return item.customName || item.displayName!;
  if (names[item.name]) return names[item.name]!;
  for (const [suffix, title] of Object.entries(equipment)) {
    if (item.name.endsWith(`_${suffix}`)) {
      const material = item.name.slice(0, -(suffix.length + 1));
      if (materials[material]) return `${materials[material]} ${title}`;
    }
  }
  return item.name.replaceAll("_", " ");
}
function slotName(index: number): string {
  if (index === 0) return "제작 결과";
  if (index <= 4) return `제작 칸 ${index}`;
  if (index <= 8) return ["투구", "흉갑", "각반", "부츠"][index - 5]!;
  if (index <= 35) return `보관 칸 ${index - 8}`;
  if (index <= 44) return `핫바 ${index - 35}`;
  return "보조 손";
}
function iconStyles(name: string): CSSProperties {
  const icon = getItemIcon(name);
  return {
    backgroundImage: `url(${icon.src})`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${(icon.atlasWidth / icon.size) * 100}% ${(icon.atlasHeight / icon.size) * 100}%`,
    backgroundPosition: `${icon.atlasWidth === icon.size ? 0 : (icon.x / (icon.atlasWidth - icon.size)) * 100}% ${icon.atlasHeight === icon.size ? 0 : (icon.y / (icon.atlasHeight - icon.size)) * 100}%`,
  };
}

export function Inventory({
  report,
  stale,
}: {
  report?: BotReport;
  stale: boolean;
}) {
  const view = report?.inventoryView;
  const [active, setActive] = useState<{
    index: number | "cursor";
    left: number;
    top: number;
  } | null>(null);
  const tooltipId = useId();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef<number | "cursor" | null>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const activeItem =
    active?.index === "cursor"
      ? view?.cursor
      : typeof active?.index === "number"
        ? view?.slots[active.index]
        : undefined;
  const clearHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const hide = () => {
    clearHide();
    if (focused.current === null)
      hideTimer.current = setTimeout(() => setActive(null), 120);
  };
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!view) {
      setActive(null);
      focused.current = null;
    }
  }, [!!view]);

  function show(index: number | "cursor", element: HTMLElement) {
    clearHide();
    const bounds = element.getBoundingClientRect();
    const item = index === "cursor" ? view?.cursor : view?.slots[index];
    const width = Math.min(260, window.innerWidth - 24);
    const height = Math.min(
      280,
      95 + (item?.enchants?.length ?? 0) * 21 + (item?.durability ? 24 : 0),
    );
    setActive({
      index,
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)),
      top:
        bounds.bottom + height < window.innerHeight - 12
          ? bounds.bottom + 3
          : Math.max(12, bounds.top - height - 3),
    });
  }
  function slot(index: number | "cursor") {
    const item = index === "cursor" ? view?.cursor : view?.slots[index];
    const held =
      typeof index === "number" &&
      index >= 36 &&
      index <= 44 &&
      view?.selectedHotbarSlot === index - 36;
    const title = index === "cursor" ? "커서" : slotName(index);
    const icon = item ? getItemIcon(item.name) : undefined;
    const enchanted = !!item?.enchants?.length;
    const ratio = item?.durability
      ? Math.max(
          0,
          Math.min(1, item.durability.remaining / item.durability.maximum),
        )
      : undefined;
    const styles =
      item && icon?.kind !== "fallback" ? iconStyles(item.name) : undefined;
    return (
      <button
        key={index}
        type="button"
        className={`inventory-slot${held ? " held" : ""}${enchanted ? " enchanted" : ""}`}
        data-slot-index={typeof index === "number" ? index : undefined}
        data-cursor={index === "cursor" ? "true" : undefined}
        aria-label={`${title} · ${item ? `${itemName(item)} ${item.count}개` : "비어 있음"}${held ? " · 선택한 핫바" : ""}`}
        aria-describedby={active?.index === index ? tooltipId : undefined}
        onMouseEnter={(event) => show(index, event.currentTarget)}
        onMouseLeave={hide}
        onFocus={(event) => {
          focused.current = index;
          show(index, event.currentTarget);
        }}
        onBlur={() => {
          focused.current = null;
          hide();
        }}
        onClick={(event) => show(index, event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            clearHide();
            setActive(null);
          }
          if (["PageDown", "PageUp"].includes(event.key) && tooltip.current) {
            event.preventDefault();
            tooltip.current.scrollTop += event.key === "PageDown" ? 120 : -120;
          }
        }}
      >
        {item ? (
          <>
            {styles ? (
              <span
                className="inventory-item-icon"
                aria-hidden="true"
                style={styles}
              />
            ) : (
              <span className="inventory-unknown-icon" aria-hidden="true">
                ?
              </span>
            )}
            {enchanted && styles && (
              <span
                className="inventory-glint"
                aria-hidden="true"
                style={{
                  maskImage: styles.backgroundImage,
                  maskRepeat: "no-repeat",
                  maskSize: styles.backgroundSize,
                  maskPosition: styles.backgroundPosition,
                }}
              />
            )}
            {item.count > 1 && (
              <span
                className={`inventory-stack-count${item.count > 999 ? " long-count" : ""}`}
                aria-hidden="true"
              >
                {item.count}
              </span>
            )}
            {ratio !== undefined && (
              <span
                className="inventory-durability"
                role="meter"
                aria-label={`${itemName(item)} 내구도`}
                aria-valuemin={0}
                aria-valuemax={item.durability!.maximum}
                aria-valuenow={item.durability!.remaining}
              >
                <span
                  style={{
                    width: `${ratio * 100}%`,
                    backgroundColor: `hsl(${ratio * 120} 85% 42%)`,
                  }}
                />
              </span>
            )}
          </>
        ) : typeof index === "number" && [5, 6, 7, 8, 45].includes(index) ? (
          <EquipmentOutline index={index} />
        ) : null}
      </button>
    );
  }
  if (!view)
    return (
      <section className="inventory-unobserved" aria-label="인벤토리">
        <p className="reason">
          슬롯 관측 대기{stale && report ? " · 마지막 보고" : ""}
        </p>
        {report?.inventory.length ? (
          <>
            <p className="muted inventory-total-caption">보고된 물품 합계</p>
            <ul className="inventory-totals">
              {report.inventory.map((item, index) => (
                <li key={`${item.name}:${index}`}>
                  <span>{itemName(item)}</span>
                  <b>{item.count}개</b>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted inventory-total-caption">
            슬롯 위치를 확인하면 인게임 배치로 표시합니다.
          </p>
        )}
      </section>
    );
  return (
    <>
      <section className="game-inventory" aria-label="인게임 인벤토리">
        <div className="inventory-top">
          <div
            className="inventory-equipment"
            role="group"
            aria-label="장비와 보조 손"
          >
            <div className="inventory-armor">{[5, 6, 7, 8].map(slot)}</div>
            <div className="inventory-avatar">
              <svg viewBox="0 0 32 60" aria-hidden="true">
                <path
                  fill="#656565"
                  d="M10 2h12v12H10zM7 16h18v23H7zM1 16h5v24H1zM26 16h5v24h-5zM8 40h7v18H8zM17 40h7v18h-7z"
                />
                <path fill="#777" d="M11 3h10v10H11zM8 17h16v21H8z" />
              </svg>
              {slot(45)}
            </div>
          </div>
          <div className="inventory-crafting" role="group" aria-label="제작 칸">
            <p>제작</p>
            <div className="inventory-crafting-row">
              <div className="inventory-crafting-grid">
                {[1, 2, 3, 4].map(slot)}
              </div>
              <span className="inventory-craft-arrow" aria-hidden="true">
                ➜
              </span>
              {slot(0)}
            </div>
          </div>
        </div>
        <p className="inventory-section-label">보관 공간</p>
        <div
          className="inventory-main-grid"
          role="group"
          aria-label="보관 공간"
        >
          {Array.from({ length: 27 }, (_, index) => slot(index + 9))}
        </div>
        <p className="inventory-section-label">핫바</p>
        <div className="inventory-hotbar" role="group" aria-label="핫바">
          {Array.from({ length: 9 }, (_, index) => slot(index + 36))}
        </div>
        {view.cursor !== undefined && (
          <div className="inventory-cursor">
            <span>커서</span>
            {slot("cursor")}
            <span>
              {view.cursor
                ? `${itemName(view.cursor)} ${view.cursor.count}개`
                : "비어 있음"}
            </span>
          </div>
        )}
        <p className="inventory-readonly">
          보기 전용{stale ? " · 마지막 관측 상태" : ""}
        </p>
        {view.slots.every((item) => item === null) && (
          <p className="inventory-empty">모든 슬롯이 비어 있습니다.</p>
        )}
      </section>
      <p className="inventory-help">
        아이템을 가리키거나 선택하면 상세 정보를 볼 수 있습니다.
      </p>
      {active &&
        createPortal(
          <div
            ref={tooltip}
            id={tooltipId}
            role="tooltip"
            className="inventory-tooltip"
            style={{ left: active.left, top: active.top }}
            onMouseEnter={clearHide}
            onMouseLeave={hide}
          >
            <p
              className={
                activeItem?.customName
                  ? "custom-item-name"
                  : activeItem?.enchants?.length
                    ? "enchanted-item-name"
                    : ""
              }
            >
              {activeItem ? itemName(activeItem) : "비어 있음"}
            </p>
            <small>
              {active.index === "cursor" ? "커서" : slotName(active.index)}
              {stale ? " · 마지막 관측" : ""}
            </small>
            {activeItem && (
              <>
                <p>
                  수량 {activeItem.count}개
                  {activeItem.maxStackSize
                    ? ` · 최대 묶음 ${activeItem.maxStackSize}개`
                    : ""}
                </p>
                {activeItem.durability && (
                  <p>
                    내구도 {activeItem.durability.remaining} /{" "}
                    {activeItem.durability.maximum}
                  </p>
                )}
                {activeItem.enchants?.length ? (
                  <ul>
                    {activeItem.enchants.map((enchant, index) => (
                      <li key={`${enchant.name}:${index}`}>
                        {enchantments[
                          enchant.name.replace(/^minecraft:/, "")
                        ] ??
                          enchant.name
                            .replace(/^minecraft:/, "")
                            .replaceAll("_", " ")}{" "}
                        {enchant.level}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function EquipmentOutline({ index }: { index: number }) {
  const paths: Record<number, string> = {
    5: "M3 3h10v9h-3V8H6v4H3z",
    6: "M4 2h3v3h2V2h3l3 4-3 2v6H4V8L1 6z",
    7: "M4 2h8v12H9V7H7v7H4z",
    8: "M3 3h4v10H1v-4h2zM9 3h4v6h2v4H9z",
    45: "M3 2h10v8l-5 4-5-4z",
  };
  return (
    <svg
      className="inventory-equipment-outline"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d={paths[index]} fill="currentColor" />
    </svg>
  );
}
