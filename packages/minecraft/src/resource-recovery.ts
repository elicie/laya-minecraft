import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import { BUILD_MATERIALS, PositionSchema, isBuildSiteGround, type JsonObject, type Position, type RecoveryState } from '../../contracts/src';
import { ConditionWait, type ActionServices } from './services';
import { observationBase, position, vector, walkingFeet } from './observations';
import { HOSTILES } from './combat-policy';
import { alternateSafeWalk, walkCorner } from './safe-walk';
import { observedGroundRoute, observedGroundStand } from './observed-ground-walk';

const cell = PositionSchema.refine(p => [p.x, p.y, p.z].every(Number.isInteger));
const probe = z.object({ position: cell, name: z.string().min(1).max(100), state: z.string().max(200).optional(), threatened: z.boolean().optional() });
const journeySchema = z.object({ center: cell, visited: z.array(cell).max(512), deadEnds: z.array(cell).max(512).default([]), pending: z.boolean().default(false), moves: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(), status: z.enum(['searching', 'blocked', 'paused']), relocations: z.array(z.object({ deathId: z.string(), from: cell, to: cell })).max(16).optional(), displacements: z.array(z.object({ from: cell, to: cell })).max(16).optional(), displacementCount: z.number().int().nonnegative().optional() });
const stateSchema = z.object({ origin: cell, visited: z.array(cell).max(13), failed: z.array(probe.extend({ reason: z.string().max(500), from: cell.optional() })).max(64), probes: z.array(probe).max(64), sourceSnapshot: z.array(probe).max(64).default([]), sourceFingerprint: z.string().max(16000).default(''), destinationsUsed: z.number().int().min(0).max(13), approachesUsed: z.number().int().min(0).max(8), elapsedMs: z.number().min(0).max(100000000), status: z.enum(['searching', 'found', 'exhausted']), reason: z.string().max(500), approachBudgetRepairApplied: z.boolean().optional(), foodSearchExpanded: z.boolean().optional(), foodJourney: journeySchema.optional(), resourceJourney: journeySchema.optional() }).refine(state => state.foodSearchExpanded || state.destinationsUsed <= 5 && state.visited.length <= 5);
export type ResourceRecoveryState = z.infer<typeof stateSchema>;

/** A confirmed new life can relocate a journey; a timer or failed hop cannot. */
export function reconcileResourceJourneys(bot: Bot, checkpoint: JsonObject, recovery?: RecoveryState): void {
  if (!recovery || recovery.phase !== 'resolved' || !recovery.safe || bot.health <= 0 || checkpoint.resourceJourneyArrivalDeathId === recovery.deathId) return;
  const records = checkpoint.resourceRecovery;
  if (!records || typeof records !== 'object' || Array.isArray(records)) { checkpoint.resourceJourneyDeathId = recovery.deathId;checkpoint.resourceJourneyArrivalDeathId=recovery.deathId; return; }
  const current = position(walkingFeet(bot));
  for (const [item, value] of Object.entries(records)) {
    const parsed = stateSchema.safeParse(value); if (!parsed.success) continue;
    const state = parsed.data, journey = state.resourceJourney;
    if (!journey || vector(current).distanceTo(vector(journey.center)) <= 3 && (!journey.visited.length||vector(current).distanceTo(vector(journey.visited.at(-1)!))<=3) || !safeResourceStand(bot, current, () => false) || Object.values(bot.entities).some(e => HOSTILES.has(e.name ?? '') && e.position.distanceTo(vector(current)) < 12)) continue;
    const from = { ...journey.center };
    journey.center = current; journey.pending = false; journey.status = 'searching';
    journey.visited = [...journey.visited, current].slice(-512);
    journey.relocations = [...journey.relocations ?? [], { deathId: recovery.deathId, from, to: current }].slice(-16);
    // Retain the original search anchor and spent global/travel budgets. Only
    // the obsolete local route and source observations belong to the old life.
    state.status = 'searching'; state.reason = ''; state.approachesUsed = 0;
    state.failed = []; state.probes = []; state.sourceSnapshot = []; state.sourceFingerprint = '';
    records[item] = state as unknown as JsonObject;
  }
  checkpoint.resourceJourneyDeathId = recovery.deathId;
  checkpoint.resourceJourneyArrivalDeathId = recovery.deathId;
}

function savedFoodSearch(checkpoint: JsonObject) {
  const records = checkpoint.resourceRecovery;
  return stateSchema.safeParse(records && typeof records === 'object' && !Array.isArray(records) ? records.$food : undefined);
}

/** Start an unused search stage or resume a deliberately paused journey. */
export function foodSearchCanExpand(checkpoint: JsonObject, bot?: Bot): boolean {
  const saved = savedFoodSearch(checkpoint);
  if(saved.success&&bot&&checkpoint.foodGroundWalkVersion!==1&&saved.data.foodJourney?.status==='blocked'&&newFoodGroundExit(bot,saved.data))return true;
  return saved.success && (saved.data.foodJourney?.status === 'paused' || saved.data.status === 'exhausted' && !saved.data.foodJourney || checkpoint.leafLitterWalkRepair !== true && saved.data.foodJourney?.status === 'blocked' && saved.data.probes.some(p => p.name === 'leaf_litter') || checkpoint.flowerWalkRepair !== true && saved.data.foodJourney?.status === 'blocked' && saved.data.probes.some(p=>walkOnlyFlowers.has(p.name)) || !!bot && canReanchorFoodJourney(bot, saved.data));
}

/** Reopen one newly supported, actually observed walking leg; retain all budgets. */
function newFoodGroundExit(bot:Bot,state:ResourceRecoveryState):Vec3|undefined {
  const current=walkingFeet(bot),center=state.foodJourney?.center;
  if(!center||vector(center).distanceTo(current)>3||safeResourceStand(bot,current,()=>false)||!observedGroundStand(bot,current))return;
  for(const [dx,dz]of [[8,0],[-8,0],[0,8],[0,-8]])for(const dy of [0,1,-1,2,-2,3,-3]){
    const p=current.offset(dx!,dy,dz!);
    if(observedGroundRoute(bot,p,48))return p;
  }
}

const lostJourneyAnchorReason = '원정의 마지막 도착 위치와 현재 위치 사이의 안전한 연결을 확인해야 합니다.';
function canReanchorFoodJourney(bot: Bot, state: ResourceRecoveryState, protectedPosition: (p: Position) => boolean = () => false): boolean {
  const journey = state.foodJourney;
  if (!journey || journey.status === 'paused' || bot.health <= 0) return false;
  const current = walkingFeet(bot), actual = vector(bot.entity.position);
  if (current.distanceTo(vector(journey.center)) <= 3 || Math.abs(actual.y - current.y) >= 0.1) return false;
  const outside = Math.hypot(current.x - journey.center.x, current.z - journey.center.z) > 48 || Math.abs(current.y - journey.center.y) > 8;
  return (outside || state.reason === lostJourneyAnchorReason) && safeResourceStand(bot, current, protectedPosition)
    && !Object.values(bot.entities).some(e => HOSTILES.has(e.name ?? '') && e.position.distanceTo(actual) < 12);
}

export function foodSearchObservationArea(checkpoint: JsonObject): { center: Position; radius: number } | undefined {
  const saved = savedFoodSearch(checkpoint);
  if (!saved.success) return undefined;
  return { center: saved.data.foodJourney?.center ?? saved.data.origin, radius: saved.data.foodJourney ? 48 : saved.data.foodSearchExpanded ? 96 : 48 };
}
const air = new Set(['air', 'cave_air', 'void_air']);
const walkOnlyFlowers=new Set(['dandelion','poppy','blue_orchid','allium','azure_bluet','red_tulip','orange_tulip','white_tulip','pink_tulip','oxeye_daisy','cornflower','lily_of_the_valley','sunflower','lilac','rose_bush','peony','wildflowers','pink_petals']);
const vegetation = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern', 'leaf_litter', 'bush', 'firefly_bush', 'short_dry_grass', 'tall_dry_grass',...walkOnlyFlowers]);
// Walking clearance only: installed lights are not vegetation to clear or collect.
const walkOnlyFixtures = new Set(['torch', 'wall_torch']);
const constructionGround = new Set<string>([...BUILD_MATERIALS,'crafting_table','furnace']);
const fallingGround = new Set(['sand', 'red_sand', 'gravel']);
const danger = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow', 'sweet_berry_bush']);
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const keyOf = (p: Position) => `${p.x},${p.y},${p.z}`;
const approachBudgetReason = '자원 접근 예산을 소진했습니다. 실제 자원이나 접근 지형의 변화를 기다립니다.';
function resourceProperties(block: ReturnType<Bot['blockAt']>): string { if (!block || typeof block.getProperties !== 'function') return ''; const age = block.getProperties().age; return age === undefined ? '' : `age:${age}`; }

/** Noncolliding vegetation and installed lights can be walked through intact. */
export function resourceClearance(block: ReturnType<Bot['blockAt']>): boolean {
  return !!block && block.boundingBox === 'empty' && (air.has(block.name) || vegetation.has(block.name) || walkOnlyFixtures.has(block.name));
}

function stableResourceGround(bot: Bot, p: Vec3): boolean {
  // Walking across an existing full floor is safe; collecting it remains subject
  // to the executor's separate natural-resource and protected-area checks.
  for (let depth = 0; depth <= 4; depth++) {
    const block = bot.blockAt(p.offset(0, -depth, 0));
    if (!block || block.boundingBox !== 'block' || danger.has(block.name)) return false;
    if (!fallingGround.has(block.name)) return isBuildSiteGround(block.name) || constructionGround.has(block.name) || ['farmland','dirt_path'].includes(block.name);
  }
  return false;
}

// All route checks use public, loaded block observations. No digging or placing
// is part of recovery; unknown terrain is never used as a destination.
export function safeResourceStand(bot: Bot, feet: Position, protectedPosition: (p: Position) => boolean): boolean {
  const p = walkingFeet(bot,feet);
  if ([p, p.offset(0, 1, 0), p.offset(0, -1, 0)].some(protectedPosition)) return false;
  const body = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0)), support = bot.blockAt(p.offset(0, -1, 0));
  if (!resourceClearance(body) || !resourceClearance(head) || !support || !stableResourceGround(bot, p.offset(0, -1, 0))) return false;
  for (const [dx, dz] of directions) {
    const adjacent = bot.blockAt(p.offset(dx, 0, dz)), under = bot.blockAt(p.offset(dx, -1, dz));
    const lower = under?.boundingBox === 'empty' ? bot.blockAt(p.offset(dx, -2, dz)) : null;
    if (!adjacent || !under || danger.has(adjacent.name) || danger.has(under.name) || under.boundingBox !== 'block' && (!lower || !stableResourceGround(bot, p.offset(dx, -2, dz)))) return false;
  }
  return true;
}

/** Public path observations, with no digging, placing, jumping gaps or large drops. */
export function safeResourceRoute(bot: Bot, destination: Position, options: { radius?: number; within?: (p: Position) => boolean; clear?: (p: Position) => boolean; onReject?: (p: Position) => void; onAlternate?: () => void } = {}): Position[] | undefined {
  const start = walkingFeet(bot), target = walkingFeet(bot,destination);
  const within = options.within ?? (p => Math.hypot(p.x-start.x,p.z-start.z) <= 48 && Math.abs(p.y-start.y) <= 8);
  const clear = options.clear ?? (p => !Object.values(bot.entities).some(e => HOSTILES.has(e.name ?? '') && e.position.distanceTo(vector(p)) < 12));
  const pf = bot.pathfinder;
  if (!pf || typeof pf.getPathTo !== 'function' || !pf.movements || pf.movements.canDig !== false || pf.movements.allow1by1towers !== false) return;
  const radius=options.radius??0;
  const alternate = () => { const path=alternateSafeWalk(bot, target, { within, radius, stand: p => safeResourceStand(bot,p,()=>false) && clear(p) }); if(path)options.onAlternate?.();return path; };
  const result = pf.getPathTo(pf.movements, new goals.GoalNear(target.x,target.y,target.z,radius), 200);
  if (result.status !== 'success' || result.path.length > 256) return alternate();
  let previous = start; const path: Position[] = [];
  for (const step of result.path) {
    const p = vector(step).floored();
    if (!within(p) || step.toBreak?.length || step.toPlace?.length || step.parkour || Math.abs(p.y-previous.y) > 1 || Math.hypot(p.x-previous.x,p.z-previous.z) > 1.5 || !safeResourceStand(bot,p,()=>false) || !clear(p)) { options.onReject?.(p); return alternate(); }
    if(p.x!==previous.x&&p.z!==previous.z&&!walkCorner(previous,p,q=>within(q)&&safeResourceStand(bot,q,()=>false)&&clear(q)))return alternate();
    previous = p; path.push(position(p));
  }
  return previous.distanceTo(target)<=radius ? path : alternate();
}

export class ResourceRecovery {
  readonly state: ResourceRecoveryState;
  constructor(readonly bot: Bot, readonly services: ActionServices, readonly item: string, readonly names: readonly string[], readonly canExplore: boolean, readonly protectedPosition: (p: Position) => boolean, readonly now: () => number = Date.now) {
    const saved = services.checkpoint.resourceRecovery;
    const records: JsonObject = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    services.checkpoint.resourceRecovery = records;
    const parsed = stateSchema.safeParse(records[item]);
    this.state = parsed.success ? parsed.data : { origin: position(walkingFeet(bot)), visited: [], failed: [], probes: [], sourceSnapshot: [], sourceFingerprint: '', destinationsUsed: 0, approachesUsed: 0, elapsedMs: 0, status: 'searching', reason: '' };
    if(item==='$food'&&services.checkpoint.foodGroundWalkVersion!==1&&this.state.foodJourney?.status==='blocked'){
      const exit=newFoodGroundExit(bot,this.state);
      if(exit){services.checkpoint.foodGroundWalkVersion=1;this.state.failed=this.state.failed.filter(p=>keyOf(p.position)!==keyOf(exit));this.state.status='searching';this.state.foodJourney.status='searching';}
    }
    if (item === '$food' && services.checkpoint.leafLitterWalkRepair !== true && this.state.foodJourney?.status === 'blocked' && this.state.probes.some(p => p.name === 'leaf_litter')) {
      services.checkpoint.leafLitterWalkRepair = true;
      if (safeResourceStand(bot, bot.entity.position, protectedPosition) && !Object.values(bot.entities).some(e => HOSTILES.has(e.name ?? '') && e.position.distanceTo(bot.entity.position) < 12)) { this.state.status = 'searching'; this.state.foodJourney.status = 'searching'; }
    }
    if(item==='$food'&&services.checkpoint.flowerWalkRepair!==true&&this.state.foodJourney?.status==='blocked'&&this.state.probes.some(p=>walkOnlyFlowers.has(p.name))){
      services.checkpoint.flowerWalkRepair=true;
      if(safeResourceStand(bot,bot.entity.position,protectedPosition)&&!Object.values(bot.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(bot.entity.position)<12)){this.state.status='searching';this.state.foodJourney.status='searching';}
    }
    // Older workers accidentally exhausted the entire search at the ninth
    // stand check. Restore only its remaining moves, never a fresh budget.
    if (!this.state.approachBudgetRepairApplied && this.state.status === 'exhausted' && this.state.reason === approachBudgetReason && this.state.approachesUsed === 8 && this.state.destinationsUsed < 5 && this.state.elapsedMs < 60000) { this.state.status = 'searching'; this.state.approachBudgetRepairApplied = true; }
    // Keep the original radius anchor. A report timestamp or our own movement
    // cannot grant a fresh search budget; actual changed terrain can.
    if (this.state.status === 'exhausted' && this.changed()) {
      this.state.failed = []; this.state.probes = [];
      const journey = this.journey;
      if (!journey) { this.state.visited = []; this.state.destinationsUsed = 0; this.state.elapsedMs = 0; }
      else if (journey.status === 'blocked') journey.status = 'searching';
      this.state.approachesUsed = 0; this.state.status = 'searching'; this.state.reason = '';
    }
    const trip=services.checkpoint.resourceTrip;
    const trail=trip&&typeof trip==='object'&&!Array.isArray(trip)&&trip.phase==='outbound'?z.array(cell).max(512).safeParse(trip.trail):undefined;
    const landmark=PositionSchema.safeParse(services.checkpoint.lastResourcePosition),current=walkingFeet(bot),journey=this.state.resourceJourney;
    if(item!=='$food'&&services.checkpoint.materialExpedition===true&&journey&&trail?.success&&landmark.success
      &&trip&&typeof trip==='object'&&!Array.isArray(trip)&&trip.deathId===services.checkpoint.confirmedRecoveryDeathId
      &&current.distanceTo(vector(journey.center))>3&&current.distanceTo(vector(landmark.data))<=8
      &&current.distanceTo(vector(trail.data.at(-1)??journey.center))<=3&&trail.data.some(p=>vector(p).distanceTo(vector(journey.center))<=4)
      &&safeResourceStand(bot,current,protectedPosition)&&!Object.values(bot.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(current)<12)){
      journey.displacements=[...(journey.displacements??[]),{from:{...journey.center},to:position(current)}].slice(-16);journey.displacementCount=(journey.displacementCount??0)+1;
      journey.center=position(current);journey.pending=false;journey.status='searching';this.state.status='searching';
      this.state.reason='다른 재료의 실제 수집과 기록한 원정 경로 연결을 확인해 현재 위치에서 탐색을 이어갑니다.';
    }
    records[item] = this.state as unknown as JsonObject;
  }
  get journey() { return this.state.foodJourney ?? this.state.resourceJourney; }
  private get journeyLabel(): string { return this.item === '$food' ? '식량 원정' : '자원 원정'; }
  private get targetLabel(): string { return this.item === '$food' ? '식량' : this.item === '$utility_wood' ? '작업대용 자연 나무' : this.item; }
  get radius(): number {
    if (this.journey) return 48;
    if (this.item === '$food') return this.state.foodJourney ? 48 : this.state.foodSearchExpanded ? 96 : 48;
    const food = this.services.checkpoint.resourceRecoveryScope === '$food' && savedFoodSearch(this.services.checkpoint);
    if (food && food.success && food.data.foodJourney) return 48;
    return food && food.success && food.data.foodSearchExpanded ? 96 : 48;
  }
  private get searchCenter(): Position {
    if (this.journey) return this.journey.center;
    if (this.item === '$food') return this.state.foodJourney?.center ?? this.state.origin;
    const food = this.services.checkpoint.resourceRecoveryScope === '$food' && savedFoodSearch(this.services.checkpoint);
    return food && food.success && food.data.foodJourney ? food.data.foodJourney.center : this.state.origin;
  }
  private get moveLimit(): number { return this.item === '$food' && this.state.foodSearchExpanded ? 13 : 5; }
  get timeLimit(): number { return this.item === '$food' && this.state.foodSearchExpanded ? 180000 : 60000; }
  async reanchorFoodJourney(): Promise<boolean> {
    if (this.item !== '$food' || !this.canExplore || !canReanchorFoodJourney(this.bot, this.state, this.protectedPosition)) return false;
    const actual = vector(this.bot.entity.position), feet = walkingFeet(this.bot);
    this.services.check(); await this.services.pause(100); this.services.check();
    if (vector(this.bot.entity.position).distanceTo(actual) >= 0.08 || !walkingFeet(this.bot).equals(feet) || !canReanchorFoodJourney(this.bot, this.state, this.protectedPosition)) return false;
    const journey = this.state.foodJourney!, from = { ...journey.center }, to = position(feet);
    // Food search needs the actual safe body, not a return route to a waypoint
    // left behind during retreat. This never certifies a material return path.
    journey.center = to; journey.pending = false; journey.status = 'searching';
    journey.visited = [...journey.visited, to].slice(-512);
    journey.displacements = [...journey.displacements ?? [], { from, to }].slice(-16);
    journey.displacementCount = (journey.displacementCount ?? 0) + 1;
    this.state.status = 'searching'; this.state.reason = ''; this.sampleFoot();
    this.services.progress('식량 탐색 위치 확인', '현재 위치의 실제 안전한 착지를 확인했습니다. 기존 탐색 예산과 방문 기록을 보존하고 이곳에서 식량 탐색을 이어갑니다.');
    return true;
  }
  expandFoodSearch(): boolean {
    if (this.item !== '$food' || !this.canExplore || this.state.foodSearchExpanded) return false;
    this.state.foodSearchExpanded = true; this.state.status = 'searching'; this.state.reason = '';
    this.services.progress('식량 탐색 확대', '가까운 식량 확보가 막혀 다른 안전한 경로와 최대 96블록 범위를 확인합니다.');
    return true;
  }
  beginFoodJourney(): boolean {
    if (this.item !== '$food' || !this.canExplore || !this.state.foodSearchExpanded) return false;
    const journey = this.state.foodJourney;
    if (journey && journey.status !== 'paused') return false;
    if (journey) journey.status = 'searching';
    else this.state.foodJourney = { center: position(walkingFeet(this.bot)), visited: [...this.state.visited], deadEnds: [], pending: false, moves: 0, elapsedMs: 0, status: 'searching' };
    this.state.status = 'searching'; this.state.reason = '';
    this.services.progress('식량 원정', '가까운 식량을 찾지 못해 안전한 지상 구간을 이동하며 더 먼 지역을 관측합니다.');
    return true;
  }
  beginResourceJourney(): boolean {
    if (this.item === '$food' || !this.canExplore || this.services.checkpoint.resourceExpedition !== true || this.services.checkpoint.resourceRecoveryScope === '$food' || this.state.resourceJourney) return false;
    this.state.resourceJourney = { center: position(walkingFeet(this.bot)), visited: [...this.state.visited], deadEnds: [], pending: false, moves: 0, elapsedMs: 0, status: 'searching' };
    this.state.status = 'searching'; this.state.reason = '';
    this.services.progress('자원 원정', `${this.targetLabel}의 가까운 탐색을 마쳐 다른 지역의 실제 자원과 안전한 경로를 확인합니다.`);
    return true;
  }
  pauseFoodJourney(): void {
    if (this.state.foodJourney) this.state.foodJourney.status = 'paused';
  }
  within(p: Position): boolean { const center = this.searchCenter; return Math.hypot(p.x - center.x, p.z - center.z) <= this.radius && Math.abs(p.y - center.y) <= 8; }
  failed(p: Position): boolean {
    const entry = this.state.failed.find(entry => keyOf(entry.position) === keyOf(p));
    if (!entry) return false;
    // A source's approach can change after a real walk around a hill. This
    // does not reopen failed route destinations or refresh any search budget.
    const current = walkingFeet(this.bot);
    return !entry.from || !this.names.includes(entry.name) || Math.hypot(current.x-entry.from.x,current.z-entry.from.z)<8 && Math.abs(current.y-entry.from.y)<2;
  }
  canApproach(): boolean { return this.state.status !== 'exhausted' && this.state.approachesUsed < 8 && (!!this.journey || this.state.elapsedMs < this.timeLimit); }
  sample(p: Position): void {
    const block = this.bot.blockAt(vector(p)); if (!block) return;
    const value = { position: position(vector(p).floored()), name: block.name, ...(this.names.includes(block.name) ? { state: resourceProperties(block) } : {}), ...(this.journey || this.item === '$food' || this.services.checkpoint.resourceRecoveryScope === '$food' ? { threatened: !this.foodThreatClear(vector(p)) } : {}) }, key = keyOf(value.position), existing = this.state.probes.findIndex(entry => keyOf(entry.position) === key);
    if (existing >= 0) this.state.probes.splice(existing, 1);
    if (this.state.probes.length >= 64) this.state.probes.shift(); this.state.probes.push(value);
  }
  sampleFoot(p = this.bot.entity.position): void {
    const feet = walkingFeet(this.bot,p);
    for (const [dx, dz] of [[0, 0], ...directions]) {
      for (const dy of [-1, 0, 1]) this.sample(feet.offset(dx!, dy, dz!));
      if (this.bot.blockAt(feet.offset(dx!, -1, dz!))?.boundingBox === 'empty') this.sample(feet.offset(dx!, -2, dz!));
    }
  }
  reject(p: Position, name: string, reason: string): void {
    const value = { position: position(p), name, reason: reason.slice(0, 500), from: position(walkingFeet(this.bot)) };
    this.state.failed = [...this.state.failed.filter(entry => keyOf(entry.position) !== keyOf(p)), value].slice(-64);
    this.state.reason = value.reason; this.sample(p); this.sampleFoot(vector(p)); this.sampleFoot();
  }
  private checkGathering():void {
    this.services.check();const trip=this.services.checkpoint.resourceTrip;
    if(trip&&typeof trip==='object'&&!Array.isArray(trip)&&trip.phase==='returning')throw new ConditionWait('미완료 재료 원정의 실제 복귀를 먼저 마쳐야 합니다.',this.services.checkpoint);
  }
  async approach(p: Position, radius = 0): Promise<void> {
    this.checkGathering();
    if (!this.canApproach()) throw new ConditionWait(approachBudgetReason);
    this.state.approachesUsed++;
    const start = this.now();
    try {
      if (radius === 0 && !this.route(vector(p).floored())) throw new ConditionWait('자원의 안전한 발판까지 지형을 변경하지 않고 걸을 경로를 확인하지 못했습니다.');
      await this.services.near(p, radius);this.services.check();
      const arrived=walkingFeet(this.bot),journey=this.state.resourceJourney;
      // A source approach is also a real verified walk, even if sight or
      // harvesting subsequently fails. Retain its stand without refilling the
      // approach, travel or time allowance.
      if(journey&&radius===0&&vector(this.bot.entity.position).distanceTo(vector(p))<=1.5&&this.materialStand(arrived)&&this.foodThreatClear(arrived)){
        journey.center=position(arrived);journey.visited=[...journey.visited,position(arrived)].slice(-512);
      }
    }
    catch (error) { this.services.check(); if (!(error instanceof ConditionWait)) throw error; throw error; }
    finally { this.state.elapsedMs = Math.min(this.timeLimit + 20000, this.state.elapsedMs + Math.max(0, this.now() - start)); }
  }
  progress(): void {
    this.collectionHint();
    this.state.status = 'found'; this.state.approachesUsed = 0; this.state.destinationsUsed = 0; this.state.visited = []; this.state.elapsedMs = 0; this.state.reason = '';
    if (this.journey) this.journey.center = position(walkingFeet(this.bot));
  }
  private sources(): { position: Position; name: string }[] {
    if (typeof this.bot.findBlocks !== 'function' || !this.names.length) return [];
    return this.bot.findBlocks({ point: vector(this.searchCenter), matching: b => this.names.includes(b.name), maxDistance: this.radius, count: 64 }).flatMap(p => {
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
      if (p.threatened !== undefined && p.threatened !== !this.foodThreatClear(vector(p.position))) return true;
      const current = this.bot.blockAt(vector(p.position)); if (!current) return false;
      if (this.names.includes(p.name) || this.names.includes(current.name)) return current.name !== p.name || resourceProperties(current) !== (p.state ?? '');
      const safety = (name: string) => `${air.has(name) || vegetation.has(name)}:${danger.has(name)}:${isBuildSiteGround(name) || constructionGround.has(name) || fallingGround.has(name)}`;
      return safety(current.name) !== safety(p.name);
    })) return true;
    return this.sourceFingerprint() !== this.state.sourceFingerprint;
  }
  private get observedMaterialWalk():boolean{return this.services.checkpoint.materialExpedition===true&&this.item!=='$food'&&this.services.checkpoint.resourceRecoveryScope!=='$food'&&this.bot.health>this.services.rules.combat.retreatHealth&&this.bot.food>6;}
  private get observedFoodWalk():boolean{return (this.item==='$food'||this.services.checkpoint.resourceRecoveryScope==='$food')&&this.bot.health>0&&this.bot.food>0;}
  private materialStand(p:Position):boolean {
    // Protection forbids changing the building, not walking on its intact floor.
    return safeResourceStand(this.bot,p,()=>false)||(this.observedFoodWalk||this.observedMaterialWalk)&&observedGroundStand(this.bot,p);
  }
  route(destination: Vec3): boolean {
    if(safeResourceRoute(this.bot, destination, { within: p => this.within(p), clear: p => this.foodThreatClear(vector(p)), onReject: p => this.sampleFoot(vector(p)), onAlternate: () => { this.services.checkpoint.safeDetourRequired = true; } }) !== undefined)return true;
    if(!(this.observedMaterialWalk||this.observedFoodWalk)||!this.materialStand(destination))return false;
    const path=observedGroundRoute(this.bot,destination,48);
    if(!path||path.some(p=>!this.within(p)||!observedGroundStand(this.bot,p)||!this.foodThreatClear(vector(p))))return false;
    this.services.checkpoint.safeDetourRequired=true;return true;
  }
  private foodThreatClear(p: Vec3): boolean {
    return !this.journey && this.item !== '$food' && this.services.checkpoint.resourceRecoveryScope !== '$food' || !Object.values(this.bot.entities).some(entity => HOSTILES.has(entity.name ?? '') && entity.position.distanceTo(p) < 12);
  }
  private collectionHint(): Vec3 | undefined {
    const food=this.item==='$food'||this.services.checkpoint.resourceRecoveryScope==='$food';
    const hints=food?this.services.rules.foodSearchHints.filter(h=>h.observedAt<=Date.now()&&Date.now()-h.observedAt<=900000).map(h=>({...h,item:this.item})):this.services.checkpoint.resourceHints;
    if(!Array.isArray(hints))return;
    const raw=this.services.checkpoint.resourceHintVisits;
    const visits:JsonObject=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
    const checked=z.array(cell).max(32).safeParse(visits[this.item]);
    const visited=checked.success?checked.data:[],current=walkingFeet(this.bot),candidates:Vec3[]=[];
    for(const rawHint of hints.slice(0,32)){
      if(!rawHint||typeof rawHint!=='object'||Array.isArray(rawHint)||rawHint.world!==this.services.rules.world||rawHint.dimension!==this.services.rules.dimension||typeof rawHint.item!=='string'||rawHint.item!==this.item&&!this.names.includes(rawHint.item))continue;
      const p=cell.safeParse(rawHint.position);if(!p.success)continue;
      if(visited.some(v=>keyOf(v)===keyOf(p.data)))continue;
      if(Math.hypot(p.data.x-current.x,p.data.z-current.z)<=24){visited.push(p.data);continue;}
      candidates.push(vector(p.data));
    }
    visits[this.item]=visited.slice(-32);this.services.checkpoint.resourceHintVisits=visits;
    return candidates.sort((a,b)=>a.distanceTo(current)-b.distanceTo(current))[0];
  }
  private destinations(): Vec3[] {
    const current = walkingFeet(this.bot), result: Vec3[] = [];
    // At most 144 possible columns, 7 heights: fixed work in a loaded world.
    for (const radius of this.radius === 96 ? [8, 16, 24, 32, 40, 48, 64, 80, 96] : [8, 16, 24, 32, 40, 48]) for (let angle = 0; angle < 16; angle++) {
      const x = this.state.origin.x + Math.round(Math.cos(angle * Math.PI / 8) * radius), z = this.state.origin.z + Math.round(Math.sin(angle * Math.PI / 8) * radius);
      for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
        const p = new Vec3(x, current.y + dy, z);
        if (!this.within(p) || p.distanceTo(current) < 4 || this.state.visited.some(v => keyOf(v) === keyOf(p)) || this.failed(p)) continue;
        if (this.materialStand(p) && this.foodThreatClear(p)) { result.push(p); break; }
      }
    }
    const explored = Math.max(0, ...this.state.visited.map(p => Math.hypot(p.x - this.state.origin.x, p.z - this.state.origin.z)));
    const hint=this.collectionHint();
    if(hint)return result.sort((a,b)=>a.distanceTo(hint)-b.distanceTo(hint)).slice(0,16);
    const outward = result.filter(p => Math.hypot(p.x - this.state.origin.x, p.z - this.state.origin.z) >= explored + 4);
    const nearest = (a: Vec3, b: Vec3) => a.distanceTo(current) - b.distanceTo(current);
    if (this.item === '$food') {
      // A blocked outward route must not hide safe, unvisited directions.
      const outwardKeys = new Set(outward.map(keyOf));
      return [...outward.sort(nearest).slice(0, 8), ...result.filter(p => !outwardKeys.has(keyOf(p))).sort(nearest).slice(0, 8)];
    }
    return (outward.length ? outward : result).sort(nearest).slice(0, 16);
  }
  async move(): Promise<boolean> {
    this.checkGathering(); this.sampleFoot();
    if (!this.canExplore) { this.state.reason = '이 봇에는 탐색 작업이 허용되지 않았습니다.'; return false; }
    if (this.journey) return this.moveJourney();
    if (this.state.status === 'exhausted' || this.state.destinationsUsed >= this.moveLimit || this.state.elapsedMs >= this.timeLimit) return false;
    for (const destination of this.destinations()) {
      this.checkGathering();
      if (this.state.destinationsUsed >= this.moveLimit || this.state.elapsedMs >= this.timeLimit) break;
      this.services.check();
      // Failed route probes do not consume the food search's walking allowance.
      if (this.item === '$food') {
        const probeStarted = this.now(), reachable = this.route(destination);
        this.state.elapsedMs = Math.min(this.timeLimit + 20000, this.state.elapsedMs + Math.max(0, this.now() - probeStarted));
        if (this.state.elapsedMs >= this.timeLimit) break;
        if (!reachable) { this.reject(destination, this.bot.blockAt(destination)?.name ?? 'unknown', '식량 탐색 경로가 막혀 다른 안전한 방향을 확인합니다.'); continue; }
      }
      this.state.destinationsUsed++; this.state.visited.push(position(destination));
      this.services.progress('자원 탐색', `${this.targetLabel} 접근을 다시 확인하기 위해 안전한 지상으로 이동합니다 (${this.state.destinationsUsed}/${this.moveLimit}).`);
      const start = this.now();
      try {
        if (this.item !== '$food' && !this.route(destination)) throw new ConditionWait('미관측·위험 지형이나 지형 변경 없이 걸을 수 있는 전체 접근 경로를 확인하지 못했습니다.');
        await this.services.near(destination.offset(0.5, 0, 0.5), 0);
        this.services.check();
        if (this.bot.entity.position.distanceTo(destination.offset(0.5, 0, 0.5)) > 1.5 || !this.materialStand(destination) || !this.foodThreatClear(destination)) throw new ConditionWait('안전한 지상 도착을 실제로 확인하지 못했습니다.');
        this.sampleFoot(); const resources = this.sources(); for (const resource of resources) this.sample(resource.position);
        this.state.approachesUsed = 0;
        this.services.observations.push({ ...observationBase(this.services.rules.world, this.services.rules.dimension), kind: 'exploration', data: { position: position(this.bot.entity.position), resources } });
        return true;
      } catch (error) {
        this.services.check();
        if (!(error instanceof ConditionWait)) throw error;
        this.reject(destination, this.bot.blockAt(destination)?.name ?? 'unknown', error.message);
      } finally { this.state.elapsedMs = Math.min(this.timeLimit + 20000, this.state.elapsedMs + Math.max(0, this.now() - start)); }
    }
    return false;
  }
  private async moveJourney(): Promise<boolean> {
    const journey = this.journey!;
    if (this.state.status === 'exhausted' || journey.status !== 'searching') return false;
    const current = walkingFeet(this.bot);
    // The center advances only on a confirmed arrival. It is never shifted by
    // a clock, a restored checkpoint or an unsuccessful navigation attempt.
    if (current.distanceTo(vector(journey.center)) > 3) {
      // A cancelled/failed hop may have moved partway. Reconcile only actual
      // safe ground with a verified connection to the saved waypoint.
      if (!this.within(current) || !this.materialStand(current) || !this.foodThreatClear(current) || !this.route(vector(journey.center))) { this.state.reason = lostJourneyAnchorReason; return false; }
      journey.center = position(current); journey.visited = [...journey.visited, position(current)].slice(-512);
    }
    const sector = (p: Position) => `${Math.floor(p.x / 8)},${Math.floor(p.y / 4)},${Math.floor(p.z / 8)}`;
    const visited = new Set(journey.visited.map(sector)); visited.add(sector(current));
    journey.pending = false;
    const candidates: Vec3[] = [];
    for (const radius of [8, 16, 24]) for (let angle = 0; angle < 16; angle++) {
      const x = current.x + Math.round(Math.cos(angle * Math.PI / 8) * radius), z = current.z + Math.round(Math.sin(angle * Math.PI / 8) * radius);
      for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
        const p = new Vec3(x, current.y + dy, z);
        if (visited.has(sector(p)) || this.failed(p) || !this.within(p)) continue;
        if (this.materialStand(p) && this.foodThreatClear(p)) { candidates.push(p); break; }
      }
    }
    const distanceFromHome = (p: Position) => Math.hypot(p.x - this.state.origin.x, p.z - this.state.origin.z);
    const outward = distanceFromHome(current);
    const hint=this.collectionHint();
    candidates.sort((a, b) => (hint?a.distanceTo(hint)-b.distanceTo(hint):0) || Number(distanceFromHome(b) > outward + 4) - Number(distanceFromHome(a) > outward + 4) || a.distanceTo(current) - b.distanceTo(current) || distanceFromHome(b) - distanceFromHome(a));
    const deadEnds = new Set(journey.deadEnds.map(sector));
    const backtrack = [...journey.visited].reverse().map(vector).filter(p => p.distanceTo(current) >= 4 && p.distanceTo(current) <= 24 && !deadEnds.has(sector(p)) && !this.failed(p) && this.within(p) && this.materialStand(p) && this.foodThreatClear(p));
    const targets = [...candidates, ...backtrack.slice(0, 8)];
    const started = this.now();
    try {
      // Bound the work for one hop, while keeping total travel unrestricted.
      for (let index = 0; index < targets.length; index++) {
        this.checkGathering();
        const destination = targets[index]!;
        this.services.check();
        if (this.now() - started >= 15000) { journey.pending = true; break; }
        const returning = index >= candidates.length;
        if (returning && !deadEnds.has(sector(current))) { journey.deadEnds = [...journey.deadEnds, position(current)].slice(-512); deadEnds.add(sector(current)); }
        if (!this.route(destination)) { this.reject(destination, this.bot.blockAt(destination)?.name ?? 'unknown', '원정 경로가 막혀 다른 관측된 방향을 확인합니다.'); continue; }
        this.services.progress(this.journeyLabel, `${returning ? '막힌 구간에서 다른 탐색 경로로 되돌아갑니다.' : `${this.targetLabel}을 찾으며 새 구간으로 이동합니다.`} 출발점에서 ${Math.round(distanceFromHome(destination))}블록, 원정 이동 ${journey.moves + 1}회.`);
        try {
          await this.services.near(destination.offset(0.5, 0, 0.5), 0); this.services.check();
          if (this.bot.entity.position.distanceTo(destination.offset(0.5, 0, 0.5)) > 1.5 || !this.materialStand(destination) || !this.foodThreatClear(destination)) throw new ConditionWait('원정 구간의 안전한 도착을 실제로 확인하지 못했습니다.');
          journey.center = position(walkingFeet(this.bot)); journey.moves++;
          this.state.approachesUsed = 0;
          journey.visited = [...journey.visited, { ...journey.center }].slice(-512);
          this.sampleFoot(); const resources = this.sources(); for (const resource of resources) this.sample(resource.position);
          this.services.observations.push({ ...observationBase(this.services.rules.world, this.services.rules.dimension), kind: 'exploration', data: { position: position(this.bot.entity.position), resources } });
          if (this.services.observations.length > 256) this.services.observations.splice(0, this.services.observations.length - 256);
          this.services.progress(this.journeyLabel, `안전한 새 구간에 도착해 ${this.targetLabel}을 다시 확인합니다. 출발점에서 ${Math.round(distanceFromHome(journey.center))}블록.`);
          return true;
        } catch (error) {
          this.services.check(); if (!(error instanceof ConditionWait)) throw error;
          this.reject(destination, this.bot.blockAt(destination)?.name ?? 'unknown', error.message);
          // Failed movement can have partial effects. Preserve the verified
          // anchor and wait rather than granting another budget from movement.
          if (walkingFeet(this.bot).distanceTo(vector(journey.center)) > 3) { journey.pending = true; break; }
        }
      }
      this.state.reason ||= '더 이동할 수 있는 관측된 안전한 지상 경로를 확인하지 못했습니다.';
      return false;
    } finally { journey.elapsedMs += Math.max(0, this.now() - started); }
  }
  wait(reason: string, minimum?: number): ConditionWait {
    this.state.status = 'exhausted'; this.state.reason = (this.state.reason || reason).slice(0, 500); this.sampleFoot();
    if (this.journey?.status === 'searching') this.journey.status = 'blocked';
    this.state.sourceSnapshot = this.sourceSnapshot(); this.state.sourceFingerprint = this.sourceFingerprint(this.state.sourceSnapshot);
    const positions = new Map<string, Position>();
    for (const p of [...this.state.failed.map(p => p.position), ...this.state.probes.map(p => p.position), ...this.state.sourceSnapshot.filter(source => source.state?.startsWith('age:')).map(p => p.position)]) { positions.delete(keyOf(p)); positions.set(keyOf(p), p); }
    const resourcePositions = [...positions.values()].slice(-64);
    const context = { missingResource: this.item, ...(minimum === undefined ? {} : { minimum }), resourceNames: [...this.names], resourcePositions, failedCause: this.state.reason, resourceRecovery: this.services.checkpoint.resourceRecovery! };
    return new ConditionWait(reason, { ...context, ...(this.item === '$food' ? {} : { waitingFor: { kind: 'inventory', causeCode: 'RESOURCE_MISSING', item: this.item, minimum: minimum ?? 1, resourceNames: [...this.names], resourcePositions, failedCause: this.state.reason, watchPosition: true } }) });
  }
}
