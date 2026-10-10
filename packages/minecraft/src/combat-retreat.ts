import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { goals } from 'mineflayer-pathfinder';
import { z } from 'zod';
import { PositionSchema, type JsonObject, type Position } from '../../contracts/src';
import { ConditionWait, type ActionServices } from './services';
import { combatEquipment, rangedThreat } from './combat-policy';
import { position, vector } from './observations';

const hazards = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow', 'sweet_berry_bush', 'cobweb']);
const unstable = (name: string) => /(?:^|_)(?:sand|gravel|concrete_powder)$/.test(name) || name.endsWith('_leaves') || name.endsWith('_ice') || name === 'ice';
const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const cell = PositionSchema.refine(p => [p.x, p.y, p.z].every(Number.isInteger));
const probeSchema = z.object({ position: cell, name: z.string().max(100), stateId: z.number().int().optional() });
const recoverySchema = z.object({ anchor: cell, threatId: z.string().max(100), threatName: z.string().max(100), threatPosition: PositionSchema, attempts: z.number().int().min(0).max(6), elapsedMs: z.number().min(0).max(100000000), probes: z.array(probeSchema).max(64), failed: z.array(z.object({ position: cell, reason: z.string().max(500) })).max(48), status: z.enum(['searching', 'safe', 'waiting']), reason: z.string().max(500), fingerprint: z.string().max(20000).optional() });
export type RetreatRecovery = z.infer<typeof recoverySchema>;
export interface CombatRouteOptions { anchor?: Position; radius?: number; protectedPosition?: (p: Position) => boolean; onProbe?: (p: Position) => void; }
export interface CombatRoute { safe: boolean; reason: string; path: Position[]; }

// Walking may use an existing floor. It never opens a route by digging,
// placing, jumping gaps or trusting an unloaded cell.
export function safeCombatStand(bot: Bot, feet: Position, protectedPosition: (p: Position) => boolean = () => false, onProbe?: (p: Position) => void): boolean {
  const p = vector(feet).floored(), cells = [p.offset(0, -1, 0), p, p.offset(0, 1, 0)];
  cells.forEach(onProbe ?? (() => {}));
  if (protectedPosition(p) || protectedPosition(p.offset(0, 1, 0))) return false;
  const blocks = cells.map(q => bot.blockAt(q)), [ground, body, head] = blocks;
  if (!ground || !body || !head || ground.boundingBox !== 'block' || body.boundingBox !== 'empty' || head.boundingBox !== 'empty' || unstable(ground.name) || blocks.some(b => b && hazards.has(b.name))) return false;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const adjacent = p.offset(dx!, 0, dz!), under = adjacent.offset(0, -1, 0), lower = adjacent.offset(0, -2, 0);
    onProbe?.(adjacent); onProbe?.(under);
    const a = bot.blockAt(adjacent), g = bot.blockAt(under);
    if (!a || !g || hazards.has(a.name) || hazards.has(g.name)) return false;
    if (g.boundingBox === 'empty') { onProbe?.(lower); const l = bot.blockAt(lower); if (!l || l.boundingBox !== 'block' || hazards.has(l.name) || unstable(l.name)) return false; }
  }
  return true;
}

export function safeCombatRoute(bot: Bot, destination: Position, options: CombatRouteOptions = {}): CombatRoute {
  const target = vector(destination).floored(), anchor = vector(options.anchor ?? bot.entity.position).floored(), radius = Math.min(48, Math.max(1, options.radius ?? 32));
  const fail = (reason: string): CombatRoute => ({ safe: false, reason, path: [] });
  const within = (p: Position) => Math.hypot(p.x - anchor.x, p.z - anchor.z) <= radius && Math.abs(p.y - anchor.y) <= 8;
  if (!safeCombatStand(bot, bot.entity.position, () => false, options.onProbe)) return fail('현재 발판과 머리 공간의 실제 안전을 먼저 확인해야 합니다.');
  if (!within(target) || !safeCombatStand(bot, target, options.protectedPosition, options.onProbe)) return fail('목적지의 관측된 지면과 머리 공간이 안전하지 않습니다.');
  const pathfinder = bot.pathfinder;
  if (!pathfinder || typeof pathfinder.getPathTo !== 'function' || !pathfinder.movements || pathfinder.movements.canDig !== false || pathfinder.movements.allow1by1towers !== false) return fail('지형을 변경하지 않는 공개 경로 검사가 필요합니다.');
  const result = pathfinder.getPathTo(pathfinder.movements, new goals.GoalNear(target.x, target.y, target.z, 0), 200);
  if (result.status !== 'success' || result.path.length > 256) return fail('전체 이동 경로를 제한 시간 안에 확인하지 못했습니다.');
  let previous = vector(bot.entity.position).floored();
  const path: Position[] = [];
  for (const step of result.path) {
    const p = vector(step).floored();
    if (!within(p) || step.toBreak?.length || step.toPlace?.length || step.parkour || Math.abs(p.y - previous.y) > 1 || Math.hypot(p.x - previous.x, p.z - previous.z) > 1.5 || !safeCombatStand(bot, p, options.protectedPosition, options.onProbe)) { options.onProbe?.(p); return fail('이동 경로에 미관측 지형, 위험한 발판 또는 지형 변경이 포함되어 있습니다.'); }
    previous = p; path.push(position(p));
  }
  return previous.equals(target) ? { safe: true, reason: '전체 경로의 실제 지면을 확인했습니다.', path } : fail('경로가 실제 목적지까지 이어지지 않습니다.');
}

function cover(bot: Bot, threat: Entity, feet: Position): boolean {
  if (!rangedThreat(threat.name ?? '') || !bot.world || typeof bot.world.raycast !== 'function') return false;
  const eye = vector(threat.position).offset(0, Math.min(threat.height ?? 1.8, 1.6), 0), destination = vector(feet).offset(0.5, 1.5, 0.5), delta = destination.minus(eye), length = delta.norm();
  if (!length) return false;
  const hit = bot.world.raycast(eye, delta.scaled(1 / length), Math.max(0, length - 0.3));
  if (!hit) return false;
  const raw = hit as unknown as { position?: Position; x?: number; y?: number; z?: number }, p = raw.position ?? raw;
  return typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number' && bot.blockAt(vector(p as Position))?.boundingBox === 'block';
}

export function retreatFingerprint(bot: Bot, checkpoint: JsonObject): string {
  const parsed = recoverySchema.safeParse(checkpoint.retreatRecovery), saved = parsed.success ? parsed.data : undefined;
  const actual = saved ? Object.values(bot.entities).find(e => (e.uuid ?? `${e.id}`) === saved.threatId) : undefined;
  const p = actual?.position, threat = actual ? `${actual.name}:${p!.x.toFixed(1)},${p!.y.toFixed(1)},${p!.z.toFixed(1)}` : 'absent';
  const probes = saved?.probes.map(probe => { const b = bot.blockAt(vector(probe.position)); return `${key(probe.position)}:${b?.name ?? probe.name}:${b?.stateId ?? probe.stateId ?? ''}`; }).join('|') ?? '';
  return `${bot.health}:${bot.food}:${JSON.stringify(combatEquipment(bot))}:${threat}:${probes}`;
}

export async function retreatToSafety(bot: Bot, threat: Entity, services: ActionServices, protectedPosition: (p: Position) => boolean): Promise<void> {
  services.check();
  const parsed = recoverySchema.safeParse(services.checkpoint.retreatRecovery), id = threat.uuid ?? `${threat.id}`;
  const state: RetreatRecovery = parsed.success && parsed.data.threatId === id ? parsed.data : { anchor: position(vector(bot.entity.position).floored()), threatId: id, threatName: threat.name ?? 'unknown', threatPosition: position(threat.position), attempts: 0, elapsedMs: 0, probes: [], failed: [], status: 'searching', reason: '' };
  services.checkpoint.retreatRecovery = state as unknown as JsonObject;
  if (state.status === 'waiting' && state.fingerprint !== retreatFingerprint(bot, services.checkpoint)) { state.attempts = 0; state.elapsedMs = 0; state.failed = []; state.status = 'searching'; }
  const sample = (p: Position) => {
    const q = vector(p).floored(), b = bot.blockAt(q);
    state.probes = [...state.probes.filter(entry => key(entry.position) !== key(q)), { position: position(q), name: b?.name ?? 'unknown', ...(b && Number.isInteger(b.stateId) ? { stateId: b.stateId } : {}) }].slice(-64);
  };
  const wait = (reason: string): never => { state.status = 'waiting'; state.reason = reason.slice(0, 500); state.fingerprint = retreatFingerprint(bot, services.checkpoint); throw new ConditionWait(state.reason, services.checkpoint); };
  if (state.status === 'waiting' || state.attempts >= 6 || state.elapsedMs >= 30000) wait('안전한 퇴각 경로의 실제 지형이나 장비·위협 상태 변화를 기다립니다.');
  const current = vector(bot.entity.position).floored(), candidates: { feet: Position; cover: boolean; distance: number; travel: number }[] = [];
  // 16 columns × 5 observed heights, independent of world size or bot count.
  for (const radius of rangedThreat(threat.name ?? '') ? [10, 18] : [6, 10]) for (let direction = 0; direction < 8; direction++) {
    const x = current.x + Math.round(Math.cos(direction * Math.PI / 4) * radius), z = current.z + Math.round(Math.sin(direction * Math.PI / 4) * radius);
    for (const dy of [0, 1, -1, 2, -2]) {
      const feet = { x, y: current.y + dy, z }, distance = vector(feet).distanceTo(vector(threat.position));
      if (Math.hypot(x - state.anchor.x, z - state.anchor.z) > 32 || Math.abs(feet.y - state.anchor.y) > 8 || distance < 8 || distance < current.distanceTo(vector(threat.position)) + 2 || state.failed.some(f => key(f.position) === key(feet))) continue;
      if (!safeCombatStand(bot, feet, protectedPosition, sample)) continue;
      candidates.push({ feet, cover: cover(bot, threat, feet), distance, travel: vector(feet).distanceTo(current) }); break;
    }
  }
  candidates.sort((a, b) => Number(b.cover) - Number(a.cover) || b.distance - a.distance || a.travel - b.travel);
  if (combatEquipment(bot).shield) bot.activateItem(true);
  try {
    for (const candidate of candidates.slice(0, 48)) {
      services.check(); if (state.attempts >= 6 || state.elapsedMs >= 30000) break;
      const route = safeCombatRoute(bot, candidate.feet, { anchor: state.anchor, radius: 32, protectedPosition, onProbe: sample });
      if (!route.safe) { state.failed.push({ position: candidate.feet, reason: route.reason }); state.failed = state.failed.slice(-48); continue; }
      state.attempts++; const started = Date.now();
      try {
        services.progress('퇴각', candidate.cover ? '관측한 엄폐물 뒤의 안전한 지면으로 이동합니다.' : '관측한 안전한 지면으로 거리를 확보합니다.');
        // Execute the verified route one step at a time so changed terrain is
        // checked before movement, rather than accepting safe endpoints only.
        for (const step of route.path) {
          services.check();
          if (!safeCombatStand(bot, step, protectedPosition, sample) || Date.now() - started + state.elapsedMs >= 30000) throw new ConditionWait('퇴각 중 지형 변화 또는 이동 시간 제한을 확인했습니다.');
          await services.near(vector(step).offset(0.5, 0, 0.5), 0);
        }
        const actual = vector(bot.entity.position), feet = actual.floored();
        if (actual.distanceTo(vector(candidate.feet).offset(0.5, 0, 0.5)) > 1.5 || !safeCombatStand(bot, feet, protectedPosition, sample) || actual.distanceTo(vector(threat.position)) < 8 || rangedThreat(threat.name ?? '') && !cover(bot, threat, feet) && actual.distanceTo(vector(threat.position)) < 16) throw new ConditionWait('실제 도착 위치의 안전한 거리와 엄폐를 다시 확인해야 합니다.');
        state.status = 'safe'; state.reason = '실제 도착한 안전한 지면과 위협 거리를 확인했습니다.';
        return;
      } catch (error) { services.check(); if (!(error instanceof ConditionWait)) throw error; state.failed.push({ position: candidate.feet, reason: error.message.slice(0, 500) }); state.failed = state.failed.slice(-48); }
      finally { state.elapsedMs += Math.max(0, Date.now() - started); }
    }
    wait(state.failed.at(-1)?.reason ?? '관측한 지형에서 안전한 퇴각 경로와 엄폐를 찾지 못했습니다.');
  } finally { bot.deactivateItem(); }
}
