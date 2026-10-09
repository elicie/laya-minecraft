import { useState, type FormEvent } from "react";
import {
  ACTION_KINDS,
  BotInputSchema,
  GoalInputSchema,
  type Agent,
  type BotInput,
  type ContainerRef,
  type ExecutionMode,
  type FleetSnapshot,
  type GoalDefinition,
  type Interpretation,
  type RulesPatch,
} from "../../../../packages/contracts/src";
import { errorMessage, post } from "../lib/api";
import { actionLabels, label, roleLabels } from "../lib/display";
import { Dialog } from "./Dialog";

const roles = [
  "general",
  "gatherer",
  "builder",
  "farmer",
  "hunter",
  "guard",
  "rancher",
  "explorer",
];

function ModeChoice({
  value,
  onChange,
}: {
  value: ExecutionMode;
  onChange: (value: ExecutionMode) => void;
}) {
  return (
    <fieldset>
      <legend>현재 작업 처리</legend>
      <div className="choice-group">
        <label>
          <input
            type="radio"
            name="executionMode"
            checked={value === "queued"}
            onChange={() => onChange("queued")}
          />
          작업 예약
        </label>
        <label>
          <input
            type="radio"
            name="executionMode"
            checked={value === "immediate"}
            onChange={() => onChange("immediate")}
          />
          즉시 전환
        </label>
      </div>
      <p className="dialog-description" style={{ marginTop: 8 }}>
        즉시 전환하면 현재 동작을 안전하게 멈추고, 남은 작업은 이후 다시 확인해
        재개합니다.
      </p>
    </fieldset>
  );
}

export function BotForm({
  bot,
  snapshot,
  onClose,
  onSave,
}: {
  bot?: Agent;
  snapshot: FleetSnapshot;
  onClose: () => void;
  onSave: (input: BotInput, mode: ExecutionMode) => Promise<void>;
}) {
  const connection =
    bot?.config.connection ?? snapshot.agents[0]?.config.connection;
  const worldParts = snapshot.rules.world.match(/^(.+):(\d+)$/);
  const [name, setName] = useState(bot?.config.name ?? "");
  const [role, setRole] = useState(bot?.config.role ?? "general");
  const [host, setHost] = useState(
    connection?.host ?? worldParts?.[1] ?? "127.0.0.1",
  );
  const [port, setPort] = useState(
    connection?.port ?? Number(worldParts?.[2] ?? 25565),
  );
  const [auth, setAuth] = useState<"offline" | "microsoft">(
    connection?.auth ?? "offline",
  );
  const [version, setVersion] = useState(connection?.version ?? "");
  const [allowedActions, setAllowedActions] = useState(
    bot?.config.allowedActions ?? [...ACTION_KINDS],
  );
  const [mode, setMode] = useState<ExecutionMode>("queued");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name.trim()))
        throw new Error("봇 이름은 영문, 숫자, 밑줄로 3~16자를 입력해 주세요.");
      const input = BotInputSchema.parse({
        name: name.trim(),
        role,
        allowedActions,
        enabled: bot?.config.enabled ?? true,
        connection: {
          host: host.trim(),
          port,
          auth,
          ...(version.trim() ? { version: version.trim() } : {}),
        },
      });
      await onSave(input, mode);
      onClose();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={bot ? `${bot.config.name} 설정` : "봇 추가"}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-body">
          <p className="dialog-description">
            주 역할을 우선하고, 허용된 다른 작업도 지원합니다. 접속 상태는 실제
            보고를 받은 뒤 표시합니다.
          </p>
          <div className="form-row">
            <label>
              봇 이름
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="예: LayaHunter"
                required
                maxLength={16}
                pattern="[A-Za-z0-9_]{3,16}"
              />
            </label>
            <label>
              주 역할
              <select
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {[...new Set([...roles, role])].map((value) => (
                  <option key={value} value={value}>
                    {label(value, roleLabels)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              서버 주소
              <input
                value={host}
                onChange={(event) => setHost(event.target.value)}
                required
              />
            </label>
            <label>
              포트
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(Number(event.target.value))}
                required
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              계정 종류
              <select
                value={auth}
                onChange={(event) =>
                  setAuth(event.target.value as "offline" | "microsoft")
                }
              >
                <option value="offline">오프라인 서버</option>
                <option value="microsoft">Microsoft 계정</option>
              </select>
            </label>
            <label>
              Minecraft 버전
              <input
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="서버에서 자동 확인"
              />
            </label>
          </div>
          <fieldset>
            <legend>허용할 작업</legend>
            <div className="checklist">
              {ACTION_KINDS.map((action) => (
                <label key={action}>
                  <input
                    type="checkbox"
                    checked={allowedActions.includes(action)}
                    onChange={(event) =>
                      setAllowedActions((previous) =>
                        event.target.checked
                          ? [...previous, action]
                          : previous.filter((value) => value !== action),
                      )
                    }
                  />
                  {label(action, actionLabels)}
                </label>
              ))}
            </div>
          </fieldset>
          {bot && <ModeChoice value={mode} onChange={setMode} />}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="quiet" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "요청 중…" : bot ? "변경 요청" : "봇 추가"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function GoalForm({
  snapshot,
  preferredBotId,
  onClose,
  onSave,
}: {
  snapshot: FleetSnapshot;
  preferredBotId?: string;
  onClose: () => void;
  onSave: (goal: GoalDefinition) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Interpretation | null>(null);
  const [goal, setGoal] = useState<GoalDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [customDestination, setCustomDestination] = useState(false);
  const [destination, setDestination] = useState<ContainerRef>(
    snapshot.rules.warehouse ?? {
      id: "warehouse",
      world: snapshot.rules.world,
      dimension: snapshot.rules.dimension,
      position: snapshot.rules.center ?? { x: 0, y: 64, z: 0 },
    },
  );

  async function interpret(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await post<Interpretation>("/goals/interpret", {
        text: text.trim(),
      });
      const parsed = GoalInputSchema.parse(result.goal);
      if (parsed.kind === "build") {
        parsed.params.blueprint =
          parsed.params.design ?? parsed.params.blueprint ?? "cabin";
        if (parsed.params.position && !parsed.params.origin)
          parsed.params.origin = parsed.params.position;
        delete parsed.params.design;
        delete parsed.params.position;
      }
      setPreview(result);
      const continuous = ["guard", "follow", "survive"].includes(parsed.kind);
      setGoal({
        ...parsed,
        mode: continuous ? "maintain" : parsed.mode,
        quantityMode: continuous ? "total" : parsed.quantityMode,
        preferredBotId: preferredBotId ?? parsed.preferredBotId,
        source: "user",
      });
      setCustomDestination(
        !!parsed.destination &&
          parsed.destination.id !== snapshot.rules.warehouse?.id,
      );
      if (parsed.destination) setDestination(parsed.destination);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal) return;
    setError("");
    setBusy(true);
    try {
      const params = { ...goal.params };
      if (goal.kind === "build") {
        params.blueprint ??= "cabin";
        params.origin ??= snapshot.rules.center ?? { x: 0, y: 64, z: 0 };
      }
      if (goal.kind === "farm") {
        params.crop ??= "wheat";
        params.mode ??= "setup";
        params.plots ??= 8;
      }
      if (goal.kind === "home")
        params.position ??= snapshot.rules.center ?? { x: 0, y: 64, z: 0 };
      if (goal.kind === "breed") params.animal ??= "cow";
      const value = GoalInputSchema.parse({
        ...goal,
        params,
        ...(customDestination ? { destination } : { destination: undefined }),
      });
      await onSave(value);
      onClose();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }
  function change<K extends keyof GoalDefinition>(
    key: K,
    value: GoalDefinition[K],
  ) {
    setGoal((previous) =>
      previous ? { ...previous, [key]: value } : previous,
    );
  }
  function param(key: string, value: GoalDefinition["params"][string]) {
    setGoal((previous) => {
      if (!previous) return previous;
      const params = { ...previous.params, [key]: value };
      if (previous.kind === "build" && ["blueprint", "origin"].includes(key)) {
        delete params.requiredBlocks;
        delete params.design;
        delete params.position;
      }
      return { ...previous, params };
    });
  }
  const origin = goal?.params.origin as
    { x: number; y: number; z: number } | undefined;
  const position = goal?.params.position as
    { x: number; y: number; z: number } | undefined;
  const resourceNames = goal?.params.resourceNames;
  const quantityTask =
    !!goal &&
    (["collect", "craft", "smelt", "store", "take"].includes(goal.kind) ||
      (goal.kind === "hunt" && !!goal.item));
  const destinationTask =
    !!goal &&
    (["collect", "store", "take"].includes(goal.kind) ||
      (goal.kind === "hunt" && !!goal.item));
  return (
    <Dialog title="목표 등록" onClose={onClose}>
      <form onSubmit={(event) => void interpret(event)}>
        <div
          className="dialog-body"
          style={{ paddingBottom: goal ? 0 : undefined }}
        >
          <p className="dialog-description">
            원하는 일을 입력하고, 해석된 작업과 완료 기준을 확인한 뒤
            등록하세요.
          </p>
          <label>
            무엇을 할까요?
            <textarea
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setGoal(null);
                setPreview(null);
                setError("");
              }}
              placeholder="예: 원목 32개 모아서 창고에 넣어 줘"
              required
              maxLength={500}
            />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy || !text.trim()}>
              {busy && !goal ? "해석 중…" : "목표 해석"}
            </button>
          </div>
          {!goal && error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </form>
      {goal && (
        <form onSubmit={(event) => void submit(event)}>
          <div className="dialog-body">
            <div className="preview-header">
              ✓ 해석 결과 · 수정할 수 있습니다
            </div>
            {preview?.warnings.map((warning, index) => (
              <p key={index} className="notice" style={{ marginBottom: 0 }}>
                {warning}
              </p>
            ))}
            <label>
              목표 이름
              <input
                value={goal.title ?? text}
                onChange={(event) => change("title", event.target.value)}
                required
                maxLength={500}
              />
            </label>
            <div className="form-row">
              <label>
                작업 종류
                <select
                  value={goal.kind}
                  onChange={(event) => {
                    const kind = event.target.value as GoalDefinition["kind"];
                    setGoal((previous) =>
                      previous
                        ? {
                            ...previous,
                            kind,
                            params: {},
                            ...(["guard", "follow", "survive"].includes(kind)
                              ? { mode: "maintain", quantityMode: "total" }
                              : {}),
                          }
                        : previous,
                    );
                  }}
                >
                  {ACTION_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {label(value, actionLabels)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                완료 후
                <select
                  value={goal.mode}
                  disabled={["guard", "follow", "survive"].includes(goal.kind)}
                  onChange={(event) =>
                    setGoal((previous) =>
                      previous
                        ? {
                            ...previous,
                            mode: event.target.value as GoalDefinition["mode"],
                            ...(event.target.value === "maintain"
                              ? { quantityMode: "total" }
                              : {}),
                          }
                        : previous,
                    )
                  }
                >
                  <option value="once">한 번 완료하고 종료</option>
                  <option value="maintain">상태를 계속 유지</option>
                </select>
              </label>
            </div>
            {quantityTask && (
              <>
                <div className="form-row">
                  <label>
                    물품 이름
                    <input
                      value={goal.item ?? ""}
                      onChange={(event) => change("item", event.target.value)}
                      required
                      placeholder="예: oak_log"
                    />
                  </label>
                  <label>
                    목표 수량
                    <input
                      type="number"
                      min={1}
                      max={1000000}
                      value={goal.quantity}
                      onChange={(event) =>
                        change("quantity", Number(event.target.value))
                      }
                      required
                    />
                  </label>
                </div>
                <label>
                  수량 기준
                  <select
                    value={goal.quantityMode}
                    disabled={goal.mode === "maintain"}
                    onChange={(event) =>
                      change(
                        "quantityMode",
                        event.target.value as GoalDefinition["quantityMode"],
                      )
                    }
                  >
                    <option value="total">기존 재고를 포함한 총수량</option>
                    <option value="additional">현재 재고에 추가로 확보</option>
                  </select>
                  <small>
                    {goal.mode === "maintain"
                      ? "재고가 목표보다 줄면 다시 보충합니다."
                      : "완료 후 재고가 줄어도 완료 상태를 유지합니다."}
                  </small>
                </label>
              </>
            )}
            {goal.kind === "build" && (
              <>
                <label>
                  건물 설계
                  <select
                    value={String(goal.params.blueprint ?? "cabin")}
                    onChange={(event) => param("blueprint", event.target.value)}
                  >
                    <option value="cabin">작은 집</option>
                    <option value="warehouse">창고</option>
                  </select>
                </label>
                <fieldset>
                  <legend>건물 시작 좌표</legend>
                  <div className="form-row three">
                    {(["x", "y", "z"] as const).map((axis) => (
                      <label key={axis}>
                        {axis.toUpperCase()}
                        <input
                          type="number"
                          value={
                            origin?.[axis] ??
                            snapshot.rules.center?.[axis] ??
                            (axis === "y" ? 64 : 0)
                          }
                          onChange={(event) =>
                            param("origin", {
                              ...(origin ??
                                snapshot.rules.center ?? { x: 0, y: 64, z: 0 }),
                              [axis]: Number(event.target.value),
                            })
                          }
                          required
                        />
                      </label>
                    ))}
                  </div>
                </fieldset>
              </>
            )}
            {goal.kind === "farm" && (
              <>
                <div className="form-row">
                  <label>
                    작물
                    <input
                      value={String(goal.params.crop ?? "wheat")}
                      onChange={(event) => param("crop", event.target.value)}
                    />
                  </label>
                  <label>
                    작업
                    <select
                      value={String(goal.params.mode ?? "setup")}
                      onChange={(event) => param("mode", event.target.value)}
                    >
                      <option value="setup">밭 조성</option>
                      <option value="harvest">수확</option>
                    </select>
                  </label>
                </div>
                <label>
                  경작지 수
                  <input
                    type="number"
                    min={1}
                    value={Number(goal.params.plots ?? 8)}
                    onChange={(event) =>
                      param("plots", Number(event.target.value))
                    }
                  />
                </label>
                {goal.params.mode === "harvest" && (
                  <label>
                    수확 수량
                    <input
                      type="number"
                      min={1}
                      value={goal.quantity}
                      onChange={(event) =>
                        change("quantity", Number(event.target.value))
                      }
                      required
                    />
                  </label>
                )}
              </>
            )}
            {["hunt", "fight"].includes(goal.kind) && (
              <div className="form-row">
                <label>
                  대상 종류
                  <input
                    value={String(goal.params.targetName ?? "")}
                    onChange={(event) =>
                      param("targetName", event.target.value)
                    }
                    placeholder={
                      goal.kind === "hunt" ? "예: cow" : "예: zombie"
                    }
                  />
                </label>
                {!goal.item && (
                  <label>
                    처치 수
                    <input
                      type="number"
                      min={1}
                      value={goal.quantity}
                      onChange={(event) =>
                        change("quantity", Number(event.target.value))
                      }
                      required
                    />
                  </label>
                )}
              </div>
            )}
            {goal.kind === "explore" && (
              <label>
                찾을 자원
                <input
                  value={
                    Array.isArray(resourceNames) ? resourceNames.join(", ") : ""
                  }
                  onChange={(event) =>
                    param(
                      "resourceNames",
                      event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    )
                  }
                  placeholder="예: iron_ore, coal_ore"
                />
                <small>비워 두면 새 구역을 탐색합니다.</small>
              </label>
            )}
            {goal.kind === "follow" && (
              <label>
                따라갈 플레이어
                <input
                  value={String(goal.params.playerName ?? "")}
                  onChange={(event) => param("playerName", event.target.value)}
                  required
                />
              </label>
            )}
            {goal.kind === "breed" && (
              <div className="form-row">
                <label>
                  동물 종류
                  <input
                    value={String(goal.params.animal ?? "cow")}
                    onChange={(event) => param("animal", event.target.value)}
                  />
                </label>
                <label>
                  태어날 동물 수
                  <input
                    type="number"
                    min={1}
                    value={goal.quantity}
                    onChange={(event) =>
                      change("quantity", Number(event.target.value))
                    }
                    required
                  />
                </label>
              </div>
            )}
            {goal.kind === "home" && (
              <fieldset>
                <legend>돌아갈 좌표</legend>
                <div className="form-row three">
                  {(["x", "y", "z"] as const).map((axis) => (
                    <label key={axis}>
                      {axis.toUpperCase()}
                      <input
                        type="number"
                        value={
                          position?.[axis] ??
                          snapshot.rules.center?.[axis] ??
                          (axis === "y" ? 64 : 0)
                        }
                        onChange={(event) =>
                          param("position", {
                            ...(position ??
                              snapshot.rules.center ?? { x: 0, y: 64, z: 0 }),
                            [axis]: Number(event.target.value),
                          })
                        }
                        required
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {destinationTask && (
              <>
                <label>
                  물품 목적지
                  <select
                    value={customDestination ? "custom" : "warehouse"}
                    onChange={(event) =>
                      setCustomDestination(event.target.value === "custom")
                    }
                  >
                    <option value="warehouse">
                      기본 공동 창고
                      {snapshot.rules.warehouse
                        ? ` · ${snapshot.rules.warehouse.id}`
                        : " · 지정 필요"}
                    </option>
                    <option value="custom">다른 창고 지정</option>
                  </select>
                  <small>
                    {goal.kind === "collect"
                      ? "지정 창고에 목표 수량이 들어온 것을 확인하면 완료합니다."
                      : "작업과 목적지 조건을 실제 관측으로 확인합니다."}
                  </small>
                </label>
                {customDestination && (
                  <>
                    <label>
                      창고 이름
                      <input
                        value={destination.id}
                        onChange={(event) =>
                          setDestination((previous) => ({
                            ...previous,
                            id: event.target.value,
                          }))
                        }
                        required
                      />
                    </label>
                    <div className="form-row three">
                      {(["x", "y", "z"] as const).map((axis) => (
                        <label key={axis}>
                          {axis.toUpperCase()}
                          <input
                            type="number"
                            value={destination.position[axis]}
                            onChange={(event) =>
                              setDestination((previous) => ({
                                ...previous,
                                position: {
                                  ...previous.position,
                                  [axis]: Number(event.target.value),
                                },
                              }))
                            }
                            required
                          />
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            {["craft", "smelt"].includes(goal.kind) && (
              <p className="dialog-description">
                수행 봇의 인벤토리에서 목표 산출물과 수량을 확인하면 완료합니다.
              </p>
            )}
            <label>
              우선 수행할 봇
              <select
                value={goal.preferredBotId ?? ""}
                onChange={(event) =>
                  change("preferredBotId", event.target.value || undefined)
                }
              >
                <option value="">자동 배정</option>
                {snapshot.agents
                  .filter((bot) => bot.status !== "removed")
                  .map((bot) => (
                    <option value={bot.id} key={bot.id}>
                      {bot.config.name} · {label(bot.config.role, roleLabels)}
                    </option>
                  ))}
              </select>
              <small>
                선택한 봇이 수행하기 어려우면 허용된 다른 봇에 재배정합니다.
              </small>
            </label>
            <ModeChoice
              value={goal.executionMode}
              onChange={(value) => change("executionMode", value)}
            />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <button type="button" className="quiet" onClick={onClose}>
              취소
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "등록 요청 중…" : "목표 등록"}
            </button>
          </div>
        </form>
      )}
      {!goal && (
        <div className="dialog-footer">
          <button type="button" className="quiet" onClick={onClose}>
            닫기
          </button>
        </div>
      )}
    </Dialog>
  );
}

export function VillageForm({
  snapshot,
  onClose,
  onSave,
}: {
  snapshot: FleetSnapshot;
  onClose: () => void;
  onSave: (patch: RulesPatch) => Promise<void>;
}) {
  const [center, setCenter] = useState(
    snapshot.rules.center ?? { x: 0, y: 64, z: 0 },
  );
  const [radius, setRadius] = useState(snapshot.rules.radius);
  const [world, setWorld] = useState(snapshot.rules.world);
  const [dimension, setDimension] = useState(snapshot.rules.dimension);
  const [hasWarehouse, setHasWarehouse] = useState(!!snapshot.rules.warehouse);
  const [warehouse, setWarehouse] = useState(
    snapshot.rules.warehouse ?? {
      id: "warehouse",
      position: center,
      world,
      dimension,
    },
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onSave({
        center,
        radius,
        world,
        dimension,
        warehouse: hasWarehouse ? { ...warehouse, world, dimension } : null,
      });
      onClose();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="마을 설정" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-body">
          <p className="dialog-description">
            마을 발전용 건물은 지정 반경 안에 배치합니다. 자원 수집과 사냥은
            범위 밖에서도 진행할 수 있습니다.
          </p>
          <label>
            월드 / 서버
            <input
              value={world}
              onChange={(event) => setWorld(event.target.value)}
              required
            />
          </label>
          <label>
            차원
            <select
              value={dimension}
              onChange={(event) => setDimension(event.target.value)}
            >
              {[
                ...new Set(["overworld", "the_nether", "the_end", dimension]),
              ].map((value) => (
                <option key={value} value={value}>
                  {value === "overworld"
                    ? "오버월드"
                    : value === "the_nether"
                      ? "네더"
                      : value === "the_end"
                        ? "엔드"
                        : value}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>마을 중심 좌표</legend>
            <div className="form-row three">
              {(["x", "y", "z"] as const).map((axis) => (
                <label key={axis}>
                  {axis.toUpperCase()}
                  <input
                    type="number"
                    value={center[axis]}
                    onChange={(event) =>
                      setCenter((previous) => ({
                        ...previous,
                        [axis]: Number(event.target.value),
                      }))
                    }
                    required
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            수평 반경 (블록)
            <input
              type="number"
              min={1}
              max={10000}
              value={radius}
              onChange={(event) => setRadius(Number(event.target.value))}
              required
            />
          </label>
          <div className="choice-group">
            <label>
              <input
                type="checkbox"
                checked={hasWarehouse}
                onChange={(event) => setHasWarehouse(event.target.checked)}
              />
              기본 공동 창고 지정
            </label>
          </div>
          {hasWarehouse && (
            <>
              <label>
                창고 이름
                <input
                  value={warehouse.id}
                  onChange={(event) =>
                    setWarehouse((previous) => ({
                      ...previous,
                      id: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <fieldset>
                <legend>실제 창고 블록 좌표</legend>
                <div className="form-row three">
                  {(["x", "y", "z"] as const).map((axis) => (
                    <label key={axis}>
                      {axis.toUpperCase()}
                      <input
                        type="number"
                        value={warehouse.position[axis]}
                        onChange={(event) =>
                          setWarehouse((previous) => ({
                            ...previous,
                            position: {
                              ...previous.position,
                              [axis]: Number(event.target.value),
                            },
                          }))
                        }
                        required
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="quiet" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "요청 중…" : "설정 적용 요청"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function RulesForm({
  snapshot,
  onClose,
  onSave,
}: {
  snapshot: FleetSnapshot;
  onClose: () => void;
  onSave: (patch: RulesPatch, mode: ExecutionMode) => Promise<void>;
}) {
  const [autonomyEnabled, setAutonomyEnabled] = useState(
    snapshot.rules.autonomyEnabled,
  );
  const [combat, setCombat] = useState(snapshot.rules.combat);
  const [maxRetries, setMaxRetries] = useState(snapshot.rules.maxRetries);
  const [logRetentionDays, setLogRetentionDays] = useState(
    snapshot.rules.logRetentionDays,
  );
  const [mode, setMode] = useState<ExecutionMode>("queued");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onSave(
        { autonomyEnabled, combat, maxRetries, logRetentionDays },
        mode,
      );
      onClose();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="운영 규칙" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-body">
          <div className="choice-group">
            <label>
              <input
                type="checkbox"
                checked={autonomyEnabled}
                onChange={(event) => setAutonomyEnabled(event.target.checked)}
              />
              여유가 있는 봇은 마을 발전 목표를 스스로 추가
            </label>
          </div>
          <p className="dialog-description">
            위험 대응과 기본 생존, 사용자 목표를 먼저 처리합니다.
          </p>
          <fieldset>
            <legend>위험 대응</legend>
            <div className="checklist">
              <label>
                <input
                  type="checkbox"
                  checked={combat.counterattackWhenAttacked}
                  onChange={(event) =>
                    setCombat((previous) => ({
                      ...previous,
                      counterattackWhenAttacked: event.target.checked,
                    }))
                  }
                />
                공격받으면 반격
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={combat.protectPlayers}
                  onChange={(event) =>
                    setCombat((previous) => ({
                      ...previous,
                      protectPlayers: event.target.checked,
                    }))
                  }
                />
                동료 플레이어 보호
              </label>
              {["guard", "hunter"].map((role) => (
                <label key={role}>
                  <input
                    type="checkbox"
                    checked={combat.proactiveRoles.includes(role)}
                    onChange={(event) =>
                      setCombat((previous) => ({
                        ...previous,
                        proactiveRoles: event.target.checked
                          ? [...new Set([...previous.proactiveRoles, role])]
                          : previous.proactiveRoles.filter(
                              (value) => value !== role,
                            ),
                      }))
                    }
                  />
                  {label(role, roleLabels)} 선제 대응
                </label>
              ))}
            </div>
          </fieldset>
          <div className="form-row">
            <label>
              지원 요청 체력
              <input
                type="number"
                min={1}
                max={20}
                value={combat.supportHealth}
                onChange={(event) =>
                  setCombat((previous) => ({
                    ...previous,
                    supportHealth: Number(event.target.value),
                  }))
                }
                required
              />
            </label>
            <label>
              퇴각 판단 체력
              <input
                type="number"
                min={1}
                max={20}
                value={combat.retreatHealth}
                onChange={(event) =>
                  setCombat((previous) => ({
                    ...previous,
                    retreatHealth: Number(event.target.value),
                  }))
                }
                required
              />
            </label>
          </div>
          <p className="dialog-description">
            장비와 적의 수, 동료 지원을 함께 확인합니다. 위험 대응으로 멈춘
            작업은 재시도 횟수에 포함하지 않습니다.
          </p>
          <div className="form-row">
            <label>
              오류 최대 재시도
              <input
                type="number"
                min={0}
                max={5}
                value={maxRetries}
                onChange={(event) => setMaxRetries(Number(event.target.value))}
                required
              />
            </label>
            <label>
              로그 보존 (일)
              <input
                type="number"
                min={1}
                max={365}
                value={logRetentionDays}
                onChange={(event) =>
                  setLogRetentionDays(Number(event.target.value))
                }
                required
              />
            </label>
          </div>
          <ModeChoice value={mode} onChange={setMode} />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="quiet" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "요청 중…" : "규칙 적용 요청"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
