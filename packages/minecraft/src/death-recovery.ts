import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ItemStackSchema, PositionSchema, type ItemStack, type JsonObject, type Position, type RecoveryState } from '../../contracts/src';
import { HOSTILES } from './combat-policy';
import { safeCombatRoute, safeCombatStand } from './combat-retreat';
import { ConditionWait, type ActionServices } from './services';

const recoveryCheckpointSchema = z.object({
  anchor: PositionSchema, lastInventory: z.array(ItemStackSchema).max(128),
  credited: z.record(z.string(), z.number().int().nonnegative()), elapsedMs: z.number().nonnegative(),
  failed: z.array(z.object({ position: PositionSchema.optional(), reason: z.string() })).max(5),
  probes: z.array(z.object({ position: PositionSchema, name: z.string(), stateId: z.number().int().nonnegative().optional() })).max(128),
});
type RecoveryCheckpoint = z.infer<typeof recoveryCheckpointSchema>;
export const DEATH_RECOVERY_ATTEMPTS = 5;
export const DEATH_RECOVERY_ACTIVE_MS = 60000;
const DROP_LIFETIME_MS = 300000;
const DEATH_DROP_RADIUS = 12;
const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const vector = (p: Position) => new Vec3(p.x, p.y, p.z);
const plain = (p: Position): Position => ({ x: p.x, y: p.y, z: p.z });

export function playerInventory(bot: Bot): ItemStack[] {
  const items = new Map<string, number>();
  for (const item of bot.inventory?.items() ?? []) if (item.count > 0) items.set(item.name, (items.get(item.name) ?? 0) + item.count);
  return [...items].map(([name, count]) => ({ name, count })).slice(0, 128);
}

export function recoverySafe(bot: Bot, retreatHealth: number): boolean {
  return bot.health > retreatHealth && bot.food > 6 && !!bot.entity && safeCombatStand(bot, bot.entity.position) &&
    !Object.values(bot.entities).some(entity => HOSTILES.has(entity.name ?? '') && vector(entity.position).distanceTo(vector(bot.entity.position)) < 20);
}

function checkpoint(bot: Bot, state: RecoveryState): RecoveryCheckpoint {
  const parsed = recoveryCheckpointSchema.safeParse(state.checkpoint.deathRecovery);
  if (parsed.success) { state.checkpoint.deathRecovery = parsed.data as unknown as JsonObject; return parsed.data; }
  const current = playerInventory(bot), counts = new Map(current.map(item => [item.name, item.count]));
  const saved: RecoveryCheckpoint = { anchor: plain(bot.entity.position), lastInventory: current, credited: {}, elapsedMs: 0, failed: [], probes: [] };
  for (const item of state.priorInventory) saved.credited[item.name] = Math.min(item.count, counts.get(item.name) ?? 0);
  state.checkpoint.deathRecovery = saved as unknown as JsonObject;
  return saved;
}

function refresh(bot: Bot, state: RecoveryState, saved: RecoveryCheckpoint): void {
  const previous = new Map(saved.lastInventory.map(item => [item.name, item.count])), current = playerInventory(bot), counts = new Map(current.map(item => [item.name, item.count]));
  for (const item of state.priorInventory) {
    const delta = Math.max(0, (counts.get(item.name) ?? 0) - (previous.get(item.name) ?? 0));
    saved.credited[item.name] = Math.min(item.count, (saved.credited[item.name] ?? 0) + delta);
  }
  saved.lastInventory = current;
  const recovered = state.priorInventory.reduce((sum, item) => sum + Math.min(item.count, saved.credited[item.name] ?? 0), 0);
  const total = state.priorInventory.reduce((sum, item) => sum + item.count, 0);
  state.progress = { recoveredCount: recovered, remainingCount: Math.max(0, total - recovered), ...(state.phase === 'resolved' ? { lostCount: Math.max(0, total - recovered) } : {}) };
}

function sample(bot: Bot, saved: RecoveryCheckpoint, p: Position): void {
  const q = vector(p).floored(), block = bot.blockAt(q); if (!block) return;
  const value = { position: plain(q), name: block.name, ...(typeof block.stateId === 'number' && Number.isInteger(block.stateId) && block.stateId >= 0 ? { stateId: block.stateId } : {}) };
  saved.probes = [...saved.probes.filter(probe => key(probe.position) !== key(q)), value].slice(-128);
}

function resolve(state: RecoveryState, reason: string): void {
  state.phase = 'resolved'; state.reason = reason;
  state.progress.lostCount = state.progress.remainingCount;
}
function isResolved(state: RecoveryState): boolean { return state.phase === 'resolved'; }

export function deathRecoveryElapsed(state: RecoveryState): number {
  const parsed = recoveryCheckpointSchema.safeParse(state.checkpoint.deathRecovery);
  return parsed.success ? parsed.data.elapsedMs : 0;
}

export function expireDeathRecovery(bot: Bot, state: RecoveryState, retreatHealth: number, now: number): boolean {
  if (state.phase === 'resolved' || now - state.occurredAt < DROP_LIFETIME_MS) return false;
  state.safe = recoverySafe(bot, retreatHealth); state.updatedAt = now;
  resolve(state, `드롭 회수 가능 시간을 마쳤습니다. 확인한 회수 ${state.progress.recoveredCount}개, 미회수 ${state.progress.remainingCount}개입니다. 남은 물자는 실제 재고를 확인해 다시 준비합니다.`);
  return true;
}

// One finite step. Only matching observed item entities are approached, and
// only positive player-inventory deltas are credited as recovered items.
export async function recoverDeathStep(bot: Bot, state: RecoveryState, services: ActionServices, emit: () => void, enabled: boolean, now: () => number = Date.now): Promise<void> {
  services.check();
  const saved = checkpoint(bot, state);
  refresh(bot, state, saved);
  state.safe = recoverySafe(bot, services.rules.combat.retreatHealth);
  state.updatedAt = now();
  if (state.phase === 'resolved') { emit(); return; }
  if (!state.progress.remainingCount) { resolve(state, '사망 전 아이템의 실제 보유 수량을 모두 확인했습니다.'); emit(); return; }
  if (now() - state.occurredAt >= DROP_LIFETIME_MS || state.attemptCount >= DEATH_RECOVERY_ATTEMPTS || saved.elapsedMs >= DEATH_RECOVERY_ACTIVE_MS) {
    resolve(state, `제한된 회수 시도를 마쳤습니다. 확인한 회수 ${state.progress.recoveredCount}개, 미회수 ${state.progress.remainingCount}개입니다. 남은 작업은 실제 물자를 다시 확인합니다.`); emit(); return;
  }
  if (!enabled) { state.phase = 'held'; state.reason = '일시정지 중에는 긴 아이템 회수를 보류합니다. 회수 기록과 남은 작업을 보존합니다.'; emit(); return; }
  if (!state.safe) { state.phase = 'held'; state.reason = '현재 위치의 위험과 기본 생존을 먼저 확인합니다. 위험한 사망 위치로 이동하지 않습니다.'; emit(); return; }
  if (!state.position || state.world !== services.rules.world || state.dimension !== String(bot.game?.dimension ?? services.rules.dimension)) {
    resolve(state, '현재 월드·차원에서 사망 위치의 아이템을 안전하게 회수할 수 없습니다. 미회수 물자를 다시 준비합니다.'); emit(); return;
  }
  state.phase = 'recovering'; state.attemptCount++; state.safe = false;
  state.reason = `사망 위치 주변의 실제 드롭과 안전한 경로를 확인합니다 (${state.attemptCount}/${DEATH_RECOVERY_ATTEMPTS}).`;
  services.progress('사망 아이템 회수', state.reason); emit();
  const started = now();
  try {
    const prior = new Map(state.priorInventory.map(item => [item.name, item.count]));
    const dropped = new Set<number>();
    const matchingDrops = () => Object.values(bot.entities).filter(entity => {
      if (dropped.has(entity.id)) return false;
      if (entity.name !== 'item' || vector(entity.position).distanceTo(vector(state.position!)) > DEATH_DROP_RADIUS || typeof entity.getDroppedItem !== 'function') return false;
      try { const item = entity.getDroppedItem(); return !!item && item.count > 0 && (prior.get(item.name) ?? 0) > (saved.credited[item.name] ?? 0); }
      catch { return false; }
    }).sort((a, b) => vector(a.position).distanceTo(vector(bot.entity.position)) - vector(b.position).distanceTo(vector(bot.entity.position)));
    // A confirmed route to the corpse's area may load the drop entities. It
    // remains bounded around the first respawn; no digging or swimming occurs.
    let loadedArea = false;
    for (let checked = 0; checked < 12 && state.progress.remainingCount; checked++) {
      services.check();
      const target = matchingDrops()[0];
      if (!target && loadedArea) break;
      if (target) dropped.add(target.id); else loadedArea = true;
      const location = target ? vector(target.position) : vector(state.position), destination = location.floored();
      if (Object.values(bot.entities).some(entity => HOSTILES.has(entity.name ?? '') && vector(entity.position).distanceTo(destination) < 20)) throw new ConditionWait('사망 위치 주변에 확인된 적이 있어 장비 없이 아이템에 접근하지 않습니다.');
      // Item entities may rest against a wall or on furniture. A loaded,
      // safe adjacent stand may pick them up without entering that block.
      const stands = target ? [0, 1, -1].flatMap(y => [destination.offset(0, y, 0), ...[[-1, 0], [1, 0], [0, -1], [0, 1]].map(([x, z]) => destination.offset(x!, y, z!))])
        .filter(p => p.offset(0.5, 0, 0.5).distanceTo(location) <= 1.6) : [destination];
      let route: ReturnType<typeof safeCombatRoute> | undefined;
      let failedReason = '실제 드롭 옆의 안전한 발판이 없습니다.';
      for (const stand of stands) {
        services.check();
        if (now() - started + saved.elapsedMs >= DEATH_RECOVERY_ACTIVE_MS) throw new ConditionWait('회수 경로 확인의 시간 예산을 마쳤습니다.');
        const candidate = safeCombatRoute(bot, stand, { anchor: saved.anchor, radius: 48, onProbe: q => sample(bot, saved, q) });
        if (candidate.safe) { route = candidate; break; }
        failedReason = candidate.reason;
      }
      if (!route) {
        const reason = failedReason;
        saved.failed = [...saved.failed, { position: plain(destination), reason: reason.slice(0, 500) }].slice(-5);
        if (!target) throw new ConditionWait(reason);
        continue;
      }
      for (const step of route.path) {
        services.check();
        if (now() - started + saved.elapsedMs >= DEATH_RECOVERY_ACTIVE_MS || !recoverySafe(bot, services.rules.combat.retreatHealth) || !safeCombatStand(bot, step, undefined, p => sample(bot, saved, p))) throw new ConditionWait('회수 중 위험·지형 변화 또는 시간 제한을 확인해 이동을 중단합니다.');
        await services.near(vector(step).offset(0.5, 0, 0.5), 0);
        services.check(); refresh(bot, state, saved); state.updatedAt = now(); emit();
      }
      services.check();
      if (target && vector(bot.entity.position).distanceTo(location) <= 2 && recoverySafe(bot, services.rules.combat.retreatHealth)) await services.pause(250);
      services.check(); refresh(bot, state, saved); state.updatedAt = now(); emit();
    }
    state.safe = recoverySafe(bot, services.rules.combat.retreatHealth);
    if (!state.progress.remainingCount) resolve(state, '사망 전 아이템을 실제 인벤토리 변화로 모두 확인했습니다.');
    else { state.phase = 'held'; state.reason = `확인한 회수 ${state.progress.recoveredCount}개, 미회수 ${state.progress.remainingCount}개입니다. 남은 드롭을 제한된 횟수로 다시 확인합니다.`; }
  } catch (error) {
    refresh(bot, state, saved);
    if (services.signal.aborted) throw error;
    const reason = error instanceof Error ? error.message : '실제 아이템 회수 조건을 확인해야 합니다.';
    saved.failed = [...saved.failed, { ...(state.position ? { position: state.position } : {}), reason: reason.slice(0, 500) }].slice(-5);
    state.phase = 'held'; state.reason = `${reason} 확인한 회수 ${state.progress.recoveredCount}개, 미회수 ${state.progress.remainingCount}개입니다.`;
  } finally {
    saved.elapsedMs += Math.max(0, now() - started);
    if (!services.signal.aborted) {
      state.safe = recoverySafe(bot, services.rules.combat.retreatHealth);
      if (!isResolved(state) && (state.attemptCount >= DEATH_RECOVERY_ATTEMPTS || saved.elapsedMs >= DEATH_RECOVERY_ACTIVE_MS)) resolve(state, `안전한 회수 예산을 마쳤습니다. 회수 ${state.progress.recoveredCount}개, 미회수 ${state.progress.remainingCount}개이며 물자를 다시 준비해야 합니다.`);
      state.updatedAt = now(); emit();
    }
  }
}
