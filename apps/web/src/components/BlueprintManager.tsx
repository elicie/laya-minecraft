import { useEffect, useState, type FormEvent } from "react";
import {
  BlueprintInputSchema,
  BLUEPRINT_TEMPLATES,
  BUILD_MATERIALS,
  WINDOW_MATERIALS,
  WOOD_TYPES,
  blueprintPreset,
  type BlueprintDefinition,
  type BlueprintInput,
} from "../../../../packages/contracts/src/blueprint-catalog";
import type {
  CommandReceipt,
  FleetSnapshot,
} from "../../../../packages/contracts/src";
import {
  BLUEPRINTS,
  materialRequirements,
  previewBlueprint,
} from "../../../../packages/contracts/src/blueprints";
import { errorMessage } from "../lib/api";
import { label } from "../lib/display";
import { Dialog } from "./Dialog";

const woodLabels: Record<string, string> = {
  oak: "참나무",
  spruce: "가문비나무",
  birch: "자작나무",
  jungle: "정글 나무",
  acacia: "아카시아",
  dark_oak: "짙은 참나무",
  mangrove: "맹그로브",
  cherry: "벚나무",
  bamboo: "대나무",
  crimson: "진홍빛",
  warped: "뒤틀린",
};
const materialLabels: Record<string, string> = {
  cobblestone: "조약돌",
  stone: "돌",
  stone_bricks: "석재 벽돌",
  bricks: "벽돌",
  andesite: "안산암",
  diorite: "섬록암",
  granite: "화강암",
  polished_andesite: "윤나는 안산암",
  polished_diorite: "윤나는 섬록암",
  polished_granite: "윤나는 화강암",
  cobbled_deepslate: "심층암 조약돌",
  deepslate_bricks: "심층암 벽돌",
  terracotta: "테라코타",
  glass_pane: "유리판",
  glass: "유리",
  tinted_glass: "차광 유리",
  chest: "상자",
  crafting_table: "제작대",
  furnace: "화로",
  white_bed: "흰색 침대",
  torch: "횃불",
  wall_torch: "벽 횃불",
  ladder: "사다리",
};
const furnitureLabels: Record<keyof BlueprintInput["furniture"], string> = {
  chest: "상자",
  craftingTable: "제작대",
  furnace: "화로",
  bed: "침대",
  lighting: "조명",
};
function materialLabel(name: string): string {
  if (materialLabels[name]) return materialLabels[name]!;
  for (const [suffix, title] of [
    ["_planks", "판자"],
    ["_door", "문"],
    ["_fence", "울타리"],
  ]) {
    if (name.endsWith(suffix))
      return `${woodLabels[name.slice(0, -suffix.length)] ?? name.slice(0, -suffix.length)} ${title}`;
  }
  return name.replaceAll("_", " ");
}
function editable(definition: BlueprintDefinition): BlueprintInput {
  const {
    id: _id,
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...input
  } = definition;
  return BlueprintInputSchema.parse(input);
}
function copy(input: BlueprintInput): BlueprintInput {
  return {
    ...input,
    title: `${input.title.slice(0, 96)} 복제`,
    materials: { ...input.materials },
    furniture: { ...input.furniture },
  };
}
function sizeLimits(template: BlueprintInput["template"]) {
  const castle = template === "castle",
    bridge = template === "bridge";
  return {
    minSide: castle ? 15 : bridge ? 3 : 5,
    maxSide: castle ? 15 : 31,
    minHeight: castle ? 8 : bridge ? 1 : 3,
    maxHeight: castle ? 8 : bridge ? 1 : template === "tower" ? 16 : 4,
    hint: castle
      ? "성곽은 현재 가로 15 × 세로 15 × 높이 8칸으로 사용합니다. 재료와 가구는 변경할 수 있습니다."
      : bridge
        ? "다리는 가로 3~31칸의 홀수, 세로 3~31칸, 높이 1칸입니다. 실내 가구는 배치하지 않습니다."
        : template === "tower"
          ? "가로·세로 5~31칸, 높이 3~16칸입니다. 큰 설계는 크기를 줄여야 할 수 있습니다."
          : "가로·세로 5~31칸, 높이 3~4칸입니다. 큰 설계는 크기를 줄여야 할 수 있습니다.",
  };
}

export function BlueprintManager({
  snapshot,
  receipts,
  online,
  onClose,
  onRefresh,
  onSave,
  onDelete,
}: {
  snapshot: FleetSnapshot;
  receipts: Record<string, CommandReceipt>;
  online: boolean;
  onClose: () => void;
  onRefresh: () => Promise<FleetSnapshot>;
  onSave: (input: BlueprintInput, id?: string) => Promise<CommandReceipt>;
  onDelete: (id: string) => Promise<CommandReceipt>;
}) {
  const [draft, setDraft] = useState<BlueprintInput>(() =>
    copy(blueprintPreset("cabin")),
  );
  const [editingId, setEditingId] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<{
    receipt: CommandReceipt;
    kind: "save" | "delete";
    targetId?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const catalog = snapshot.blueprints ?? [];
  const receipt = pending?.receipt;
  const received = receipt ? receipts[receipt.id] : undefined;
  const locked = submitting || !!pending;
  const limits = sizeLimits(draft.template);
  const parsed = BlueprintInputSchema.safeParse(draft);

  useEffect(() => {
    if (
      pending &&
      received &&
      received !== pending.receipt &&
      !["applied", "failed"].includes(pending.receipt.state)
    )
      setPending({ ...pending, receipt: received });
  }, [pending, received]);

  useEffect(() => {
    if (!pending || !receipt || !["applied", "failed"].includes(receipt.state))
      return;
    if (receipt.state === "failed") {
      setError(receipt.error ?? "설계도 요청을 적용하지 못했습니다.");
      setPending(null);
      return;
    }
    let disposed = false;
    const operation = pending;
    void onRefresh()
      .then((latest) => {
        if (disposed) return;
        if (operation.kind === "delete") {
          setEditingId(undefined);
          setDraft(copy(blueprintPreset(draft.template)));
          setNotice(
            "설계도를 삭제했습니다. 이미 등록한 목표의 설계는 유지됩니다.",
          );
        } else {
          const result = receipt.result;
          const id =
            result &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            typeof result.blueprintId === "string"
              ? result.blueprintId
              : operation.targetId;
          const saved = latest.blueprints.find((entry) => entry.id === id);
          if (saved) {
            setEditingId(saved.id);
            setDraft(editable(saved));
          }
          setNotice("설계도를 저장했습니다. 건설 목표에서 선택할 수 있습니다.");
        }
        setPending(null);
      })
      .catch((value) => {
        if (!disposed) {
          setError(
            `요청은 적용됐지만 목록을 갱신하지 못했습니다. ${errorMessage(value)}`,
          );
          setPending(null);
        }
      });
    return () => {
      disposed = true;
    };
  }, [pending, receipt?.state, onRefresh]);

  function select(input: BlueprintInput, id?: string) {
    setEditingId(id);
    setDraft(input);
    setError("");
    setNotice("");
  }
  function change<K extends keyof BlueprintInput>(
    key: K,
    value: BlueprintInput[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
    setError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!online || locked) return;
    setError("");
    setNotice("");
    const input = BlueprintInputSchema.safeParse(draft);
    if (!input.success) {
      setError(
        input.error.issues.find((issue) => issue.code === "custom")?.message ??
          "설계도 이름과 크기, 재료를 확인하세요.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const receipt = await onSave(input.data, editingId);
      setPending({ receipt, kind: "save", targetId: editingId });
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSubmitting(false);
    }
  }
  async function remove() {
    if (!editingId || !online || locked) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const receipt = await onDelete(editingId);
      setPending({ receipt, kind: "delete", targetId: editingId });
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog title="설계도 관리" onClose={onClose} className="blueprint-dialog">
      <div className="blueprint-workspace">
        <aside className="blueprint-catalog" aria-label="설계도 목록">
          <h3>기본 설계도</h3>
          <p className="dialog-description">
            기본 설계도를 복제해 나만의 설계도를 만드세요.
          </p>
          <ul>
            {BLUEPRINT_TEMPLATES.map((template) => (
              <li key={template}>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => select(copy(blueprintPreset(template)))}
                  aria-label={`${BLUEPRINTS[template].title} 복제`}
                >
                  <span>
                    {BLUEPRINTS[template].title}
                    <small>
                      {BLUEPRINTS[template].width} ×{" "}
                      {BLUEPRINTS[template].depth} ×{" "}
                      {BLUEPRINTS[template].height}칸
                    </small>
                  </span>
                  <span className="catalog-action">복제</span>
                </button>
              </li>
            ))}
          </ul>
          <h3>
            내 설계도 <span className="count-badge">{catalog.length}</span>
          </h3>
          {catalog.length ? (
            <ul>
              {catalog.map((entry) => (
                <li key={entry.id} className="custom-blueprint">
                  <button
                    type="button"
                    className={editingId === entry.id ? "selected" : ""}
                    disabled={locked}
                    onClick={() => select(editable(entry), entry.id)}
                    aria-label={`${entry.title} 수정`}
                  >
                    <span>
                      {entry.title}
                      <small>
                        {entry.width} × {entry.depth} × {entry.height}칸
                      </small>
                    </span>
                    <span className="catalog-action">수정</span>
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    disabled={locked}
                    onClick={() => select(copy(editable(entry)))}
                    aria-label={`${entry.title} 복제`}
                  >
                    복제
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="catalog-empty">저장한 설계도가 없습니다.</p>
          )}
        </aside>
        <form
          className="blueprint-editor"
          onSubmit={(event) => void save(event)}
        >
          <div className="dialog-body">
            <div className="blueprint-editor-heading">
              <h3>{editingId ? "내 설계도 수정" : "새 설계도"}</h3>
              <span className="tag neutral">
                {BLUEPRINTS[draft.template].title} 기반
              </span>
            </div>
            <label>
              설계도 이름
              <input
                value={draft.title}
                maxLength={100}
                required
                disabled={locked}
                onChange={(event) => change("title", event.target.value)}
              />
            </label>
            <fieldset>
              <legend>크기</legend>
              <div className="form-row three">
                {(
                  [
                    ["width", "가로"],
                    ["depth", "세로"],
                    ["height", "높이"],
                  ] as const
                ).map(([key, title]) => (
                  <label key={key}>
                    {title}
                    <input
                      type="number"
                      value={Number.isFinite(draft[key]) ? draft[key] : ""}
                      min={key === "height" ? limits.minHeight : limits.minSide}
                      max={key === "height" ? limits.maxHeight : limits.maxSide}
                      step={
                        draft.template === "bridge" && key === "width" ? 2 : 1
                      }
                      required
                      disabled={
                        locked ||
                        draft.template === "castle" ||
                        (draft.template === "bridge" && key === "height")
                      }
                      onChange={(event) =>
                        change(
                          key,
                          event.target.value === ""
                            ? Number.NaN
                            : Number(event.target.value),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="dialog-description">{limits.hint}</p>
            </fieldset>
            <label>
              목재 종류
              <select
                value={draft.wood}
                disabled={locked}
                onChange={(event) => {
                  const wood = event.target.value as BlueprintInput["wood"];
                  const materials = Object.fromEntries(
                    Object.entries(draft.materials).map(([key, value]) => [
                      key,
                      value === `${draft.wood}_planks`
                        ? `${wood}_planks`
                        : value,
                    ]),
                  ) as BlueprintInput["materials"];
                  setDraft({ ...draft, wood, materials });
                  setNotice("");
                  setError("");
                }}
              >
                {WOOD_TYPES.map((wood) => (
                  <option value={wood} key={wood}>
                    {woodLabels[wood]}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>재료</legend>
              <div className="form-row">
                {(
                  [
                    ["floor", "바닥"],
                    ["wall", "벽"],
                    ["roof", "지붕"],
                    ["window", "창문"],
                  ] as const
                ).map(([key, title]) => (
                  <label key={key}>
                    {title}
                    <select
                      value={draft.materials[key]}
                      disabled={
                        locked ||
                        (draft.template === "bridge" && key !== "floor")
                      }
                      onChange={(event) =>
                        change("materials", {
                          ...draft.materials,
                          [key]: event.target.value,
                        })
                      }
                    >
                      {(key === "window"
                        ? WINDOW_MATERIALS
                        : BUILD_MATERIALS
                      ).map((name) => (
                        <option value={name} key={name}>
                          {materialLabel(name)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {draft.template === "bridge" && (
                <p className="dialog-description">
                  다리는 바닥 재료와 목재를 변경할 수 있습니다.
                </p>
              )}
            </fieldset>
            <fieldset>
              <legend>가구</legend>
              <div className="checklist">
                {Object.entries(furnitureLabels).map(([key, title]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={
                        draft.furniture[
                          key as keyof BlueprintInput["furniture"]
                        ]
                      }
                      disabled={locked || draft.template === "bridge"}
                      onChange={(event) =>
                        change("furniture", {
                          ...draft.furniture,
                          [key]: event.target.checked,
                        })
                      }
                    />
                    {title}
                  </label>
                ))}
              </div>
            </fieldset>
            {parsed.success ? (
              <BlueprintPreview input={parsed.data} />
            ) : (
              <p className="form-error" role="alert">
                {parsed.error.issues.find((issue) => issue.code === "custom")
                  ?.message ?? "설계도 이름과 크기, 재료를 확인하세요."}
              </p>
            )}
            {!online && (
              <p className="notice" role="status">
                연결을 복구한 뒤 저장·삭제할 수 있습니다.
              </p>
            )}
            {pending && (
              <p className="notice" role="status">
                설계도 {pending.kind === "delete" ? "삭제" : "저장"} ·{" "}
                {label(receipt?.state ?? "accepted")}
              </p>
            )}
            {notice && (
              <p className="notice" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-footer blueprint-footer">
            {editingId && (
              <button
                type="button"
                className="danger-button"
                disabled={!online || locked}
                onClick={() => void remove()}
              >
                설계도 삭제
              </button>
            )}
            <button type="button" className="quiet" onClick={onClose}>
              닫기
            </button>
            <button
              type="submit"
              className="primary"
              disabled={!online || locked || !parsed.success}
            >
              {locked
                ? "적용 확인 중…"
                : editingId
                  ? "변경 저장"
                  : "새 설계도 저장"}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

function BlueprintPreview({ input }: { input: BlueprintInput }) {
  try {
    const blocks = previewBlueprint(input);
    const required = Object.entries(materialRequirements(blocks)).sort(
      (a, b) => b[1] - a[1],
    );
    const cells = new Map<
      string,
      { x: number; z: number; name: string; priority: number }
    >();
    for (const block of blocks) {
      const { x, y, z } = block.position;
      const furniture = [
        "chest",
        "crafting_table",
        "furnace",
        "white_bed",
        "ladder",
        "wall_torch",
      ].includes(block.name);
      const priority = furniture
        ? 3
        : block.name.includes("glass") || block.name.endsWith("_door")
          ? 2
          : y === 1
            ? 1
            : y === 0
              ? 0
              : -1;
      const key = `${x},${z}`;
      if (
        priority >= 0 &&
        (!cells.has(key) || cells.get(key)!.priority < priority)
      )
        cells.set(key, { x, z, name: block.name, priority });
    }
    return (
      <section className="blueprint-preview" aria-label="설계도 미리보기">
        <div className="blueprint-preview-heading">
          <h3>배치 미리보기</h3>
          <span>
            {input.width} × {input.depth} × {input.height}칸
          </span>
        </div>
        <p className="dialog-description">
          위에서 본 배치와 건설에 필요한 재료입니다.
        </p>
        <svg
          role="img"
          aria-label={`${input.title} 배치`}
          viewBox={`-0.2 -0.2 ${input.width + 0.4} ${input.depth + 0.4}`}
        >
          {[...cells.values()].map((cell) => (
            <rect
              key={`${cell.x},${cell.z}`}
              x={cell.x}
              y={cell.z}
              width={1}
              height={1}
              rx={0.06}
              fill={
                cell.priority === 3
                  ? "#dfa861"
                  : cell.priority === 2
                    ? "#8ac8d6"
                    : cell.priority === 1
                      ? "#92ad7d"
                      : "#465d62"
              }
              stroke="#19262e"
              strokeWidth={0.04}
            >
              <title>{materialLabel(cell.name)}</title>
            </rect>
          ))}
        </svg>
        <div className="blueprint-legend">
          <span>■ 바닥</span>
          <span>■ 벽</span>
          <span>■ 창·문</span>
          <span>■ 가구</span>
        </div>
        <dl className="blueprint-materials">
          {required.map(([name, count]) => (
            <div key={name}>
              <dt>{materialLabel(name)}</dt>
              <dd>{count}개</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  } catch (value) {
    return (
      <p className="form-error" role="alert">
        {errorMessage(value)}
      </p>
    );
  }
}
