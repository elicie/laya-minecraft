import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { PositionSchema, isBuildSiteGround, type JsonObject, type Position } from '../../contracts/src';
import { ConditionWait, type ActionServices } from './services';
import { observationBase, position, vector } from './observations';

const cell = PositionSchema.refine(p => [p.x, p.y, p.z].every(Number.isInteger));
const probe = z.object({ position: cell, name: z.string().min(1).max(100), state: z.string().max(200).optional() });
const stateSchema = z.object({ origin: cell, visited: z.array(cell).max(5), failed: z.array(probe.extend({ reason: z.string().max(500) })).max(64), probes: z.array(probe).max(64), sourceSnapshot: z.array(probe).max(64).default([]), sourceFingerprint: z.string().max(16000).default(''), destinationsUsed: z.number().int().min(0).max(5), approachesUsed: z.number().int().min(0).max(8), elapsedMs: z.number().min(0).max(100000000), status: z.enum(['searching', 'found', 'exhausted']), reason: z.string().max(500), approachBudgetRepairApplied: z.boolean().optional() });
export type ResourceRecoveryState = z.infer<typeof stateSchema>;
const air = new Set(['air', 'cave_air', 'void_air']);
const danger = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow', 'sweet_berry_bush']);
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const keyOf = (p: Position) => `${p.x},${p.y},${p.z}`;
const approachBudgetReason = '자원 접근 예산을 소진했습니다. 실제 자원이나 접근 지형의 변화를 기다립니다.';
function resourceProperties(block: ReturnType<Bot['blockAt']>): string { if (!block || typeof block.getProperties !== 'function') return ''; const age = block.getProperties().age; return age === undefined ? '' : `age:${age}`; }

// All route checks use public, loaded block observations. No digging or placing
// is part of recovery; unknown terrain is never used as a destination.
export function safeResourceStand(bot: Bot, feet: Position, protectedPosition: (p: Position) => boolean): boolean {
  const p = vector(feet).floored();
  if ([p, p.offset(0, 1, 0), p.offset(0, -1, 0)].some(protectedPosition)) return false;
  const body = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0)), support = bot.blockAt(p.offset(0, -1, 0));
  if (!body || !head || !support || !air.has(body.name) || !air.has(head.name) || body.boundingBox !== 'empty' || head.boundingBox !== 'empty' || support.boundingBox !== 'block' || !isBuildSiteGround(support.name)) return false;
  for (const [dx, dz] of directions) {
    const adjacent = bot.blockAt(p.offset(dx, 0, dz)), under = bot.blockAt(p.offset(dx, -1, dz));
    const lower = under?.boundingBox === 'empty' ? bot.blockAt(p.offset(dx, -2, dz)) : null;
    if (!adjacent || !under || danger.has(adjacent.name) || danger.has(under.name) || under.boundingBox !== 'block' && (!lower || lower.boundingBox !== 'block' || !isBuildSiteGround(lower.name))) return false;
  }
  return true;
}

export class ResourceRecovery {
  readonly state: ResourceRecoveryState;
  constructor(readonly bot: Bot, readonly services: ActionServices, readonly item: string, readonly names: readonly string[], readonly canExplore: boolean, readonly protectedPosition: (p: Position) => boolean, readonly now: () => number = Date.now) {
    const saved = services.checkpoint.resourceRecovery;
    const records: JsonObject = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    services.checkpoint.resourceRecovery = records;
    const parsed = stateSchema.safeParse(records[item]);
    this.state = parsed.success ? parsed.data : { origin: position(bot.entity.position.floored()), visited: [], failed: [], probes: [], sourceSnapshot: [], sourceFingerprint: '', destinationsUsed: 0, approachesUsed: 0, elapsedMs: 0, status: 'searching', reason: '' };
    // Older workers accidentally exhausted the entire search at the ninth
    // stand check. Restore only its remaining moves, never a fresh budget.
    if (!this.state.approachBudgetRepairApplied && this.state.status === 'exhausted' && this.state.reason === approachBudgetReason && this.state.approachesUsed === 8 && this.state.destinationsUsed < 5 && this.state.elapsedMs < 60000) { this.state.status = 'searching'; this.state.approachBudgetRepairApplied = true; }
    // Keep the original radius anchor. A report timestamp or our own movement
    // cannot grant a fresh search budget; actual changed terrain can.
    if (this.state.status === 'exhausted' && this.changed()) {
      this.state.visited = []; this.state.failed = []; this.state.probes = [];
      this.state.destinationsUsed = 0; this.state.approachesUsed = 0; this.state.elapsedMs = 0; this.state.status = 'searching'; this.state.reason = '';
    }
    records[item] = this.state as unknown as JsonObject;
  }
  within(p: Position): boolean { return Math.hypot(p.x - this.state.origin.x, p.z - this.state.origin.z) <= 48 && Math.abs(p.y - this.state.origin.y) <= 8; }
  failed(p: Position): boolean { return this.state.failed.some(entry => keyOf(entry.position) === keyOf(p)); }
  canApproach(): boolean { return this.state.status !== 'exhausted' && this.state.approachesUsed < 8 && this.state.elapsedMs < 60000; }
  sample(p: Position): void {
    const block = this.bot.blockAt(vector(p)); if (!block) return;
    const value = { position: position(vector(p).floored()), name: block.name, ...(this.names.includes(block.name) ? { state: resourceProperties(block) } : {}) }, key = keyOf(value.position), existing = this.state.probes.findIndex(entry => keyOf(entry.position) === key);
    if (existing >= 0) this.state.probes.splice(existing, 1);
    if (this.state.probes.length >= 64) this.state.probes.shift(); this.state.probes.push(value);
  }
  sampleFoot(p = this.bot.entity.position): void {
    const feet = vector(p).floored();
    for (const [dx, dz] of [[0, 0], ...directions]) {
      for (const dy of [-1, 0, 1]) this.sample(feet.offset(dx!, dy, dz!));
      if (this.bot.blockAt(feet.offset(dx!, -1, dz!))?.boundingBox === 'empty') this.sample(feet.offset(dx!, -2, dz!));
    }
  }
  reject(p: Position, name: string, reason: string): void {
    const value = { position: position(p), name, reason: reason.slice(0, 500) };
    this.state.failed = [...this.state.failed.filter(entry => keyOf(entry.position) !== keyOf(p)), value].slice(-64);
    this.state.reason = value.reason; this.sample(p); this.sampleFoot(vector(p)); this.sampleFoot();
  }
  async approach(p: Position, radius = 0): Promise<void> {
    this.services.check();
    if (!this.canApproach()) throw new ConditionWait(approachBudgetReason);
    this.state.approachesUsed++;
    const start = this.now();
    try { if (radius === 0 && !this.route(vector(p).floored())) throw new ConditionWait('자원의 안전한 발판까지 지형을 변경하지 않고 걸을 경로를 확인하지 못했습니다.'); await this.services.near(p, radius); }
    catch (error) { this.services.check(); if (!(error instanceof ConditionWait)) throw error; throw error; }
    finally { this.state.elapsedMs = Math.min(80000, this.state.elapsedMs + Math.max(0, this.now() - start)); }
  }
  progress(): void { this.state.status = 'found'; this.state.approachesUsed = 0; this.state.destinationsUsed = 0; this.state.visited = []; this.state.elapsedMs = 0; this.state.reason = ''; }
  private sources(): { position: Position; name: string }[] {
    if (typeof this.bot.findBlocks !== 'function' || !this.names.length) return [];
    return this.bot.findBlocks({ point: vector(this.state.origin), matching: b => this.names.includes(b.name), maxDistance: 48, count: 64 }).flatMap(p => {
      const b = this.bot.blockAt(p); return b && this.within(p) ? [{ position: position(p), name: b.name }] : [];
    });
  }
  private sourceSnapshot(): z.infer<typeof probe>[] {
    const known = new Map(this.state.sourceSnapshot.map(source => [keyOf(source.position), source]));
    for (const source of known.values()) {
      const actual = this.bot.blockAt(vector(source.position));
      if (!actual) continue;
      if (!this.names.includes(actual.name)) known.delete(keyOf(source.position));
      else known.set(keyOf(source.position), { position: source.position, name: actual.name, state: resourceProperties(actual) });
    }
    for (const source of this.sources()) known.set(keyOf(source.position), { ...source, state: resourceProperties(this.bot.blockAt(vector(source.position))) });
    return [...known.values()].sort((a, b) => keyOf(a.position).localeCompare(keyOf(b.position))).slice(0, 64);
  }
  private sourceFingerprint(sources = this.sourceSnapshot()): string { return sources.map(source => `${keyOf(source.position)}:${source.name}:${source.state ?? ''}`).join('|'); }
  private changed(): boolean {
    if (this.state.probes.some(p => {
      const current = this.bot.blockAt(vector(p.position)); if (!current) return false;
      if (this.names.includes(p.name) || this.names.includes(current.name)) return current.name !== p.name || resourceProperties(current) !== (p.state ?? '');
      const safety = (name: string) => `${air.has(name)}:${danger.has(name)}:${isBuildSiteGround(name)}`;
      return safety(current.name) !== safety(p.name);
    })) return true;
    return this.sourceFingerprint() !== this.state.sourceFingerprint;
  }
  private route(destination: Vec3): boolean {
    const pathfinder = this.bot.pathfinder;
    if (!pathfinder || typeof pathfinder.getPathTo !== 'function' || !pathfinder.movements || pathfinder.movements.canDig !== false || pathfinder.movements.allow1by1towers !== false) return false;
    const result = pathfinder.getPathTo(pathfinder.movements, new goals.GoalNear(destination.x, destination.y, destination.z, 0), 200);
    if (result.status !== 'success' || result.path.length > 256) return false;
    let previous = vector(this.bot.entity.position).floored();
    for (const step of result.path) {
      const p = vector(step).floored();
      if (!this.within(p) || step.toBreak?.length || step.toPlace?.length || step.parkour || Math.abs(p.y - previous.y) > 1 || Math.hypot(p.x - previous.x, p.z - previous.z) > 1.5 || !safeResourceStand(this.bot, p, () => false)) { this.sampleFoot(p); return false; }
      previous = p;
    }
    return previous.equals(destination);
  }
  private destinations(): Vec3[] {
    const current = vector(this.bot.entity.position).floored(), result: Vec3[] = [];
    // 96 possible columns, 7 heights: fixed work even in a fully loaded world.
    for (const radius of [8, 16, 24, 32, 40, 48]) for (let angle = 0; angle < 16; angle++) {
      const x = this.state.origin.x + Math.round(Math.cos(angle * Math.PI / 8) * radius), z = this.state.origin.z + Math.round(Math.sin(angle * Math.PI / 8) * radius);
      for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
        const p = new Vec3(x, current.y + dy, z);
        if (!this.within(p) || p.distanceTo(current) < 4 || this.state.visited.some(v => keyOf(v) === keyOf(p)) || this.failed(p)) continue;
        if (safeResourceStand(this.bot, p, this.protectedPosition)) { result.push(p); break; }
      }
    }
    const explored = Math.max(0, ...this.state.visited.map(p => Math.hypot(p.x - this.state.origin.x, p.z - this.state.origin.z)));
    const outward = result.filter(p => Math.hypot(p.x - this.state.origin.x, p.z - this.state.origin.z) >= explored + 4);
    return (outward.length ? outward : result).sort((a, b) => a.distanceTo(current) - b.distanceTo(current)).slice(0, 16);
  }
  async move(): Promise<boolean> {
    this.services.check(); this.sampleFoot();
    if (!this.canExplore) { this.state.reason = '이 봇에는 탐색 작업이 허용되지 않았습니다.'; return false; }
    if (this.state.status === 'exhausted' || this.state.destinationsUsed >= 5 || this.state.elapsedMs >= 60000) return false;
    for (const destination of this.destinations()) {
      if (this.state.destinationsUsed >= 5 || this.state.elapsedMs >= 60000) break;
      this.services.check(); this.state.destinationsUsed++; this.state.visited.push(position(destination));
      this.services.progress('자원 탐색', `${this.item === '$food' ? '식량' : this.item} 접근을 다시 확인하기 위해 안전한 지상으로 이동합니다 (${this.state.destinationsUsed}/5).`);
      const start = this.now();
      try {
        if (!this.route(destination)) throw new ConditionWait('미관측·위험 지형이나 지형 변경 없이 걸을 수 있는 전체 접근 경로를 확인하지 못했습니다.');
        await this.services.near(destination.offset(0.5, 0, 0.5), 0);
        this.services.check();
        if (this.bot.entity.position.distanceTo(destination.offset(0.5, 0, 0.5)) > 1.5 || !safeResourceStand(this.bot, destination, this.protectedPosition)) throw new ConditionWait('안전한 지상 도착을 실제로 확인하지 못했습니다.');
        this.sampleFoot(); const resources = this.sources(); for (const resource of resources) this.sample(resource.position);
        this.state.approachesUsed = 0;
        this.services.observations.push({ ...observationBase(this.services.rules.world, this.services.rules.dimension), kind: 'exploration', data: { position: position(this.bot.entity.position), resources } });
        return true;
      } catch (error) {
        this.services.check();
        if (!(error instanceof ConditionWait)) throw error;
        this.reject(destination, this.bot.blockAt(destination)?.name ?? 'unknown', error.message);
      } finally { this.state.elapsedMs = Math.min(80000, this.state.elapsedMs + Math.max(0, this.now() - start)); }
    }
    return false;
  }
  wait(reason: string, minimum?: number): ConditionWait {
    this.state.status = 'exhausted'; this.state.reason = (this.state.reason || reason).slice(0, 500); this.sampleFoot();
    this.state.sourceSnapshot = this.sourceSnapshot(); this.state.sourceFingerprint = this.sourceFingerprint(this.state.sourceSnapshot);
    const positions = new Map<string, Position>();
    for (const p of [...this.state.failed.map(p => p.position), ...this.state.probes.map(p => p.position), ...this.state.sourceSnapshot.filter(source => source.state?.startsWith('age:')).map(p => p.position)]) { positions.delete(keyOf(p)); positions.set(keyOf(p), p); }
    const resourcePositions = [...positions.values()].slice(-64);
    const context = { missingResource: this.item, ...(minimum === undefined ? {} : { minimum }), resourceNames: [...this.names], resourcePositions, failedCause: this.state.reason, resourceRecovery: this.services.checkpoint.resourceRecovery! };
    return new ConditionWait(reason, { ...context, ...(this.item === '$food' ? {} : { waitingFor: { kind: 'inventory', causeCode: 'RESOURCE_MISSING', item: this.item, minimum: minimum ?? 1, resourceNames: [...this.names], resourcePositions, failedCause: this.state.reason, watchPosition: false } }) });
  }
}
