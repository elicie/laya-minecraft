import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Bot } from 'mineflayer';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import {
  BuildWaitingForSchema, CentralMessageSchema, WorkerLaunchSchema, WorkerMessageSchema, PositionSchema, PROTOCOL_VERSION, survivalRecoveryNeeded, foodReserveReturnAllowed,
  type ActionKind, type AssignmentBlock, type BotReport, type BuildWaitingFor, type CentralMessage, type ItemStack, type JsonObject, type Position, type RecoveryState, type ResultPayload, type SurvivalRecovery, type WorkerLaunch, type WorkerMessage,type ObservationInput,
} from '../../contracts/src';
import { MineflayerExecutor, EXECUTABLE_ACTIONS, type ExecutorOptions } from './actions';
import {passiveFarmObservation} from './farm-observation';
import { foodSearchCanExpand, reconcileResourceJourneys } from './resource-recovery';
import { resourceTrip } from './resource-trip';
import { executeVillageTask } from './village-actions';
import { duskOrNight } from './night-burrow';
import { ActionFailure, ConditionWait, type ActionServices } from './services';
import { inventory, inventoryView, nearbyBlocks, position, vector, walkingFeet } from './observations';
import { assessCombat, combatEquipment, HOSTILES, rangedThreat } from './combat-policy';
import { retreatFingerprint, visibleRangedThreat, visibleThreat } from './combat-retreat';
import { leaveRecoveryEdge } from './recovery-safety';
import { createBotViewer } from './viewer';
import { createCompatibleBot } from './compatibility';
import { copyBuildProtection, foodRecoveryFingerprint, recoveryPositions, watchedPositions, type FoodRecoveryKnowledge } from './worker-recovery';
import { deathRecoveryElapsed, DEATH_RECOVERY_ACTIVE_MS, expireDeathRecovery, playerInventory, recoverDeathStep, recoverySafe } from './death-recovery';

type Assignment = Extract<CentralMessage, { type: 'task.assign' }>;
interface ActiveTask { message: Assignment; controller: AbortController; services: ActionServices; promise: Promise<void>; life: number; interruption?: 'task.cancelled' | 'task.interrupted'; reason?: string; }
interface LocalAction { controller: AbortController; promise: Promise<void>; mode: BotReport['mode']; life: number; }
export interface WorkerDependencies {
  executorFactory?: (bot: Bot, options: ExecutorOptions) => MineflayerExecutor;
  movementsFactory?: (bot: Bot) => Movements;
  viewerFactory?: typeof createBotViewer;
  timers?: boolean;
  now?: () => number;
}

export class MinecraftWorker {
  private ready = false;
  private healthReceived = false;
  private spawnPending = false;
  private stopping = false;
  private centralConnected = true;
  private action = '접속 중';
  private reason = 'Minecraft 서버 연결을 기다립니다.';
  private mode: BotReport['mode'] = 'idle';
  private active?: ActiveTask;
  private local?: LocalAction;
  private life = 0;
  private dead = false;
  private settlingLife = false;
  private deathCleanup = Promise.resolve();
  private lastLiveInventory: ItemStack[] = [];
  private lastLivePosition?: Position;
  private liveEmptySince?: number;
  private liveInventoryWatch?: { window: Bot['inventory']; listener: () => void };
  private liveInventoryRefresh?: NodeJS.Immediate;
  private recovery?: RecoveryState;
  private lastRecoveryAttemptAt = 0;
  private readonly combatCheckpoint: JsonObject = {};
  private combatWait?: { fingerprint: string; retryAt: number; reason: string; threatId: string };
  private recoverySupport?: { deathId: string; fingerprint: string };
  private emergencyPending = false;
  private inbox = Promise.resolve();
  private readonly seenMessages = new Set<string>();
  private readonly completedAttempts = new Set<string>();
  private readonly buildWatches = new Map<string, { attemptId: string; condition: BuildWaitingFor }>();
  private readonly foodCheckpoint: JsonObject = {};
  private readonly foodKnowledge: FoodRecoveryKnowledge = { blocks: new Map() };
  private survivalRecovery?: SurvivalRecovery;
  private foodWait?: { fingerprint: string; reason: string };
  private pendingRules?: Extract<CentralMessage, { type: 'rules.update' }>;
  private viewer?: Awaited<ReturnType<typeof createBotViewer>>;
  private statusTimer?: NodeJS.Timeout;
  private safetyTimer?: NodeJS.Timeout;
  private lastHitAt = 0;
  private hitSource?: Entity;
  private lastWarehouseAt = 0;
  private lastMapAt = 0;
  private lastFoodAttemptAt = 0;
  readonly executor: MineflayerExecutor;
  private now(): number { return this.dependencies.now?.() ?? Date.now(); }

  constructor(readonly launch: WorkerLaunch, readonly bot: Bot, private readonly transport: (message: WorkerMessage) => void, private readonly dependencies: WorkerDependencies = {}) {
    if (launch.restoreRecovery) { this.recovery = structuredClone(launch.restoreRecovery); this.recovery.safe = false; copyBuildProtection(this.recovery.checkpoint, this.foodCheckpoint); }
    if (launch.restoreSurvivalRecovery) {
      this.survivalRecovery = structuredClone(launch.restoreSurvivalRecovery);
      Object.assign(this.foodCheckpoint, this.survivalRecovery.checkpoint);
      this.foodWait = (this.foodCheckpoint.nightBurrowPending===true||this.foodCheckpoint.nightBasePending===true)?undefined:this.survivalRecovery.wait && structuredClone(this.survivalRecovery.wait);
      if(this.foodCheckpoint.nightShelterUnavailable===true&&this.foodCheckpoint.nightSoilShaftSearchVersion!==2){
        // The old current-cell-only refusal cannot describe the new bounded
        // search of nearby deeper soil. Reobserve once; retain resource spend.
        this.foodCheckpoint.nightSoilShaftSearchVersion=2;delete this.foodCheckpoint.nightShelterUnavailable;this.foodWait=undefined;
      }
      this.foodKnowledge.origin = this.survivalRecovery.knowledge?.origin && structuredClone(this.survivalRecovery.knowledge.origin);
      for (const block of this.survivalRecovery.knowledge?.blocks ?? []) this.foodKnowledge.blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, structuredClone(block));
    }
    this.executor = (dependencies.executorFactory ?? ((bot, options) => new MineflayerExecutor(bot, options)))(bot, {
      config: launch.config, rules: launch.rules, world: `${launch.config.connection.host}:${launch.config.connection.port}`,
      dimension: () => String(bot.game?.dimension ?? launch.rules.dimension), villageTask: executeVillageTask,
      onProgress: (action, reason) => {
        if (!this.ready || this.active && this.active.life !== this.life || this.local && this.local.life !== this.life) return;
        this.rememberLive();
        this.action = this.local?.mode === 'survival' && this.foodCheckpoint.nightBurrowPending!==true && this.foodCheckpoint.nightBasePending!==true ? `식량 확보 · ${action}` : action; this.reason = reason;
        const active = this.active;
        if (active) this.taskMessage(active.message, 'task.progress', { action, reason, checkpoint: active.services.checkpoint, observations: active.services.observations.slice(-4) });
      },
    });
    bot.on('spawn', () => this.spawned());
    bot.on('health', () => {
      this.healthReceived = Number.isFinite(bot.health) && Number.isFinite(bot.food);
      this.rememberLive();
      if (this.spawnPending && this.healthReceived && bot.health > 0) this.spawned();
    });
    bot.on('entityHurt', (entity, source) => {
      if (entity.id === bot.entity?.id) { this.lastHitAt = this.now(); this.hitSource = source; }
    });
    bot.on('death', () => this.died());
    bot.on('error', (error) => this.message('bot.error', { code: 'MINECRAFT_ERROR', message: error.message, retryable: true, effectsKnown: false }));
    bot.on('kicked', () => { this.ready = false; this.reason = 'Minecraft 서버에서 연결을 종료했습니다.'; });
    bot.on('end', (reason) => {
      this.ready = false; this.stopping = true; this.active?.controller.abort(); this.local?.controller.abort(); this.clearTimers();
      this.buildWatches.clear();
      this.viewer?.close(); this.viewer = undefined;
      this.message('bot.stopped', { reason: String(reason) });
    });
  }

  private rememberLive(): void {
    if (!this.ready || this.dead || this.bot.health <= 0 || !this.bot.entity) return;
    this.lastLivePosition = position(this.bot.entity.position);
    const items = playerInventory(this.bot);
    // Window 0 may be cleared just before the death packet. Do not replace
    // the last live inventory with that packet until an empty living state
    // has remained confirmed for two seconds.
    if (items.length) { this.lastLiveInventory = items; this.liveEmptySince = undefined; }
    else { this.liveEmptySince ??= this.now(); if (this.now() - this.liveEmptySince >= 2000) this.lastLiveInventory = []; }
  }
  private watchLiveInventory(): void {
    const window = this.bot.inventory;
    if (!window || typeof window.on !== 'function' || this.liveInventoryWatch?.window === window) return;
    this.liveInventoryWatch?.window.off('updateSlot', this.liveInventoryWatch.listener);
    const listener = () => {
      if (this.liveInventoryRefresh) return;
      const life = this.life;
      // Batch a public window update, then recheck health and life. A death
      // packet's inventory clear must not erase the preceding live record.
      this.liveInventoryRefresh = setImmediate(() => {
        this.liveInventoryRefresh = undefined;
        if (life === this.life) this.rememberLive();
      });
    };
    window.on('updateSlot', listener); this.liveInventoryWatch = { window, listener };
  }
  private died(): void {
    if (this.dead || this.stopping) return;
    const priorInventory = this.lastLiveInventory.length ? structuredClone(this.lastLiveInventory) : playerInventory(this.bot);
    const deathPosition = this.bot.entity?.position ? position(this.bot.entity.position) : this.lastLivePosition;
    this.dead = true; this.life++; this.ready = false; this.spawnPending = false; this.settlingLife = true;
    this.healthReceived = false; this.emergencyPending = false; this.combatWait = undefined;
    this.survivalRecovery = undefined;
    // The new body has not entered the old body's warehouse doorway. Keeping
    // this in-flight latch can trap a healthy respawn in shelter recovery.
    delete this.foodCheckpoint.nightBasePending; delete this.foodCheckpoint.nightBase;
    this.lastHitAt = 0; this.hitSource = undefined; this.recoverySupport = undefined;
    this.lastRecoveryAttemptAt = 0;
    for (const field of ['resourceRecovery', 'resourceNames', 'resourcePositions', 'missingResource', 'missingFood', 'foodCause', 'failedCause']) delete this.foodCheckpoint[field];
    this.foodWait = undefined; this.foodKnowledge.blocks.clear(); this.foodKnowledge.origin = undefined; this.lastFoodAttemptAt = 0;
    for (const field of Object.keys(this.combatCheckpoint)) delete this.combatCheckpoint[field];
    const death = { deathId: randomUUID(), occurredAt: this.now(), world: this.executor.options.world, dimension: this.executor.options.dimension(), ...(deathPosition ? { position: deathPosition } : {}), priorInventory };
    this.recovery = { ...death, phase: 'waiting-respawn', reason: '사망을 확인했습니다. 실제 부활 상태와 남은 아이템을 확인합니다.', attemptCount: 0, progress: { recoveredCount: 0, remainingCount: priorInventory.reduce((sum, item) => sum + item.count, 0) }, safe: false, updatedAt: this.now(), checkpoint: {} };
    copyBuildProtection(this.foodCheckpoint, this.recovery.checkpoint);
    if (this.active) copyBuildProtection(this.active.services.checkpoint, this.recovery.checkpoint);
    this.action = '부활 대기'; this.reason = this.recovery.reason; this.mode = 'recovering';
    if (this.active) { this.active.services.checkpoint.deathId = death.deathId; this.active.services.checkpoint.deathPosition = deathPosition ?? null; this.active.services.checkpoint.deathInventory = priorInventory; }
    this.message('bot.died', death); this.publishRecovery();
    const life = this.life;
    this.deathCleanup = Promise.allSettled([this.cancelActive('사망으로 작업을 중단하고 진행을 보존합니다.', 'task.interrupted'), this.stopLocal()]).then(() => {
      if (life !== this.life) return;
      this.settlingLife = false;
      if (this.spawnPending && this.healthReceived && this.bot.health > 0) this.spawned();
    });
  }
  private recoveryPending(): boolean { return !!this.recovery && (this.recovery.phase !== 'resolved' || !this.recovery.safe); }
  private publishRecovery(): void {
    const state = this.recovery; if (!state) return;
    this.message('bot.recovery', structuredClone(state));
    if (!this.ready || state.phase !== 'held' && !(state.phase === 'resolved' && !state.safe)) return;
    const threat = Object.values(this.bot.entities).find(entity => HOSTILES.has(entity.name ?? '') && (entity.position.distanceTo(this.bot.entity.position) < 20 || !!state.position && entity.position.distanceTo(new Vec3(state.position.x, state.position.y, state.position.z)) < 20));
    if (!threat) { this.recoverySupport = undefined; return; }
    const fingerprint = this.combatFingerprint(threat);
    if (this.recoverySupport?.deathId === state.deathId && this.recoverySupport.fingerprint === fingerprint) return;
    this.recoverySupport = { deathId: state.deathId, fingerprint };
    this.message('safety.alert', { response: 'support', reason: '사망 아이템 회수 위치에 위협이 있어 안전한 지원이 필요합니다. 위험한 위치로 진입하지 않고 복구 기록을 보존합니다.', supportRequired: true, threats: [{ entityId: threat.uuid ?? `${threat.id}`, name: threat.name ?? 'unknown', ...position(threat.position) }] });
  }
  private nearbyThreats(): Entity[] {
    return Object.values(this.bot.entities).filter(e => HOSTILES.has(e.name ?? '') && e.position.distanceTo(this.bot.entity.position) < 20).sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position));
  }
  private combatFingerprint(_threat?: Entity): string {
    // The entire observed threat set owns a wait. A vanished hit source or
    // two enemies exchanging nearest position must not create a new action.
    const threats = this.nearbyThreats().map(e => `${e.uuid ?? e.id}:${e.name}:${Math.floor(e.position.x / 2)},${Math.floor(e.position.y / 2)},${Math.floor(e.position.z / 2)}`).sort();
    return `${threats.join('|')}:${retreatFingerprint(this.bot, this.combatCheckpoint)}`;
  }
  private recoverDeath(): void {
    const state = this.recovery;
    if (!state || !this.recoveryPending() || this.now() - this.lastRecoveryAttemptAt < 10000) return;
    this.lastRecoveryAttemptAt = this.now();
    const life = this.life;
    const timeout = state.phase === 'resolved' ? 12000 : Math.min(12000, Math.max(1, DEATH_RECOVERY_ACTIVE_MS - deathRecoveryElapsed(state)));
    const started = vector(this.bot.entity.position), wasUnsafe = !state.safe;
    this.startLocal(async s => {
      await recoverDeathStep(this.bot, state, s, () => { if (life === this.life && state === this.recovery) this.publishRecovery(); }, this.launch.config.enabled, () => this.now());
      if (life === this.life && wasUnsafe && state.phase === 'resolved' && state.safe && this.bot.entity.position.distanceTo(started) > 0.5) {
        // A verified exit changes the usable food routes; retain spent search
        // budgets rather than waiting forever on the former unsafe footing.
        this.foodWait = undefined;
        const records = this.foodCheckpoint.resourceRecovery;
        const food = records && typeof records === 'object' && !Array.isArray(records) ? records.$food : undefined;
        if (food && typeof food === 'object' && !Array.isArray(food)) {
          const journey = food.foodJourney;
          if (journey && typeof journey === 'object' && !Array.isArray(journey) && journey.status === 'blocked') { journey.status = 'searching'; food.status = 'searching'; }
        }
      }
    }, 'recovering', state.checkpoint, timeout);
  }

  private envelope(commandId?: string) { return { protocolVersion: PROTOCOL_VERSION, messageId: randomUUID(), controllerEpoch: this.launch.controllerEpoch, botId: this.launch.botId, sessionId: this.launch.sessionId, sentAt: Date.now(), ...(commandId ? { commandId } : {}) }; }
  private message(type: WorkerMessage['type'], payload: unknown, commandId?: string): void {
    if (!this.centralConnected) return;
    const parsed = WorkerMessageSchema.safeParse({ ...this.envelope(commandId), type, payload });
    if (parsed.success) this.transport(parsed.data);
    else console.error('Worker report rejected by protocol validation:', parsed.error.issues.map((issue) => issue.path.join('.')).join(', '));
  }
  private taskMessage(assignment: Assignment, type: WorkerMessage['type'], payload: unknown, commandId?: string): void {
    if (!this.centralConnected) return;
    const message = WorkerMessageSchema.parse({ ...this.envelope(commandId ?? assignment.commandId), taskId: assignment.taskId, attemptId: assignment.attemptId, type, payload });
    this.transport(message);
  }
  private report(): BotReport {
    this.rememberLive();
    const survival = this.ready && this.survivalUrgent();
    const config = this.launch.config;
    const view = this.ready && !this.stopping && this.bot.inventory ? inventoryView(this.bot) : undefined;
    return {
      ready: this.ready && !this.stopping,
      ...(this.ready && this.bot.entity ? { position: position(this.bot.entity.position) } : {}),
      world: `${config.connection.host}:${config.connection.port}`, dimension: String(this.bot.game?.dimension ?? this.launch.rules.dimension),
      health: Math.max(0, Math.min(20, this.bot.health ?? 0)), food: Math.max(0, Math.min(20, this.bot.food ?? 0)),
      ...(typeof this.bot.time?.isDay==='boolean'?{isDay:this.bot.time.isDay}:{}),
      ...(Number.isSafeInteger(this.bot.time?.timeOfDay)?{timeOfDay:this.bot.time.timeOfDay}:{}),
      ...(Number.isSafeInteger(this.bot.time?.age)?{worldAge:this.bot.time.age}:{}),
      ...(this.ready && this.bot.entity ? {nearbyThreatsClear:!this.nearbyThreats().some(e=>e.position.distanceTo(walkingFeet(this.bot))<12)} : {}),
      inventory: this.ready && this.bot.inventory ? inventory(this.bot) : [], action: this.action, reason: this.reason,
      ...(view ? { inventoryView: view } : {}),
      ...(this.recovery ? { recovery: structuredClone(this.recovery) } : {}),
      ...(this.survivalRecovery ? { survivalRecovery: this.survivalRecoverySnapshot() } : {}),
      // A healthy body's moderate food search yields to central work. A health
      // recovery episode keeps priority through both progress and food waits.
      mode: this.stopping ? 'stopping' : this.emergencyActive() ? 'emergency' : survival ? 'survival' : this.recoveryPending() ? 'recovering' : !config.enabled ? 'paused' : this.mode === 'survival' ? 'idle' : this.mode,
      capabilities: EXECUTABLE_ACTIONS.filter((action) => config.allowedActions.includes(action)),
      ...(this.active ? { currentAttemptId: this.active.message.attemptId } : {}), rulesVersion: this.launch.rules.version, viewerReady: !!this.viewer,
    };
  }
  private spawned(): void {
    if (this.stopping || this.ready) return;
    this.spawnPending = true;
    if (this.settlingLife) return;
    if (!this.healthReceived || this.bot.health <= 0) {
      this.spawnPending = true; this.reason = '서버의 실제 체력과 허기 보고를 기다립니다.'; return;
    }
    this.spawnPending = false;
    this.dead = false;
    if (this.pendingRules) this.applyRules(this.pendingRules);
    const movements = (this.dependencies.movementsFactory ?? ((bot) => new Movements(bot)))(this.bot);
    // Pathfinder counts down to the support block, one below the landing feet.
    // A public limit of 2 allows a one-block foot descent; 1 forbids it entirely.
    movements.canDig = false; movements.canOpenDoors = true; movements.allow1by1towers = false; movements.maxDropDown = 2; movements.infiniteLiquidDropdownDistance = false; movements.allowParkour = false;
    // Public movement settings also need to disable automatic bridging. Only
    // explicitly reserved project actions may change the terrain.
    movements.scafoldingBlocks = [];
    const farmland = this.bot.registry?.blocksByName?.farmland;
    if (farmland && movements.blocksToAvoid) movements.blocksToAvoid.add(farmland.id);
    this.bot.pathfinder.setMovements(movements); this.bot.pathfinder.thinkTimeout = 8000;
    this.ready = true; this.lastLiveInventory = playerInventory(this.bot); this.liveEmptySince = undefined; this.lastLivePosition = position(this.bot.entity.position);
    this.watchLiveInventory();
    if (this.recoveryPending()) {
      if (this.recovery!.phase === 'waiting-respawn') this.recovery!.phase = 'recovering';
      this.recovery!.safe = false; this.recovery!.updatedAt = this.now();
      this.action = '사망 후 복구'; this.reason = '실제 부활을 확인했습니다. 안전한 회수와 남은 작업을 확인합니다.'; this.mode = 'recovering';
    } else { this.action = this.launch.config.role === 'guard' ? '주변 경계' : '대기'; this.reason = '실제 월드 관측과 중앙 배정을 기다립니다.'; this.mode = 'idle'; }
    if (this.survivalUrgent()) {
      this.mode = 'survival'; this.action = this.bot.food < 18 ? '식량 대기' : '회복 대기';
      this.reason = this.foodWait?.reason ?? '서버의 실제 체력 20과 허기 18 이상을 확인한 뒤 보존한 작업을 재개합니다.';
    }
    this.message('bot.ready', this.report());
    this.publishRecovery();
    this.message('rules.applied', { version: this.launch.rules.version });
    this.clearTimers();
    if (this.dependencies.timers !== false) {
      this.statusTimer = setInterval(() => { this.message('bot.status', this.report()); this.mapObservation(); }, this.launch.rules.statusIntervalMs);
      this.safetyTimer = setInterval(() => this.pollSafety(), 300);
    }
    this.mapObservation();
  }
  private clearTimers(): void { if (this.statusTimer) clearInterval(this.statusTimer); if (this.safetyTimer) clearInterval(this.safetyTimer); }
  private mapObservation(): void {
    if (!this.ready || this.now() - this.lastMapAt < 5000) return;
    this.lastMapAt = this.now();
    const observations:ObservationInput[] = [this.executor.services(new AbortController().signal).observeInventory(), nearbyBlocks(this.bot, this.executor.options.world, this.executor.options.dimension())];
    const farm=this.executor.options.world===this.launch.rules.world&&this.executor.options.dimension()===this.launch.rules.dimension?passiveFarmObservation(this.bot,this.launch.rules,this.now()):undefined;if(farm)observations.push(farm);
    // The map samples every two blocks. Observe exact construction conditions
    // separately so a changed support cell can wake a waiting task.
    const cells = new Map<string, { x: number; y: number; z: number }>();
    for (const watch of this.buildWatches.values()) for (const p of watchedPositions(watch.condition)) {
      if (cells.size >= 10000) break;
      cells.set(`${p.x},${p.y},${p.z}`, p);
    }
    for (const p of recoveryPositions(this.foodCheckpoint)) {
      if (cells.size >= 10000) break;
      cells.set(`${p.x},${p.y},${p.z}`, p);
    }
    if (cells.size) observations.push({ id: randomUUID(), kind: 'blocks', observedAt: Date.now(), world: this.executor.options.world, dimension: this.executor.options.dimension(),
      data: { blocks: [...cells.values()].flatMap(p => { const block = this.bot.blockAt(new Vec3(p.x, p.y, p.z)),age=block&&typeof block.getProperties==='function'?Number(block.getProperties().age):NaN; return block ? [{ position: p, name: block.name, ...(typeof block.stateId === 'number' && Number.isInteger(block.stateId) && block.stateId >= 0 ? { stateId: block.stateId } : {}),...(Number.isInteger(age)&&age>=0&&age<=25?{age}:{}) }] : []; }) } });
    this.message('world.observed', { observations });
  }

  private rememberBuildWait(message: Assignment, result: ResultPayload): void {
    this.buildWatches.delete(message.taskId);
    if (message.payload.task.kind === 'build' || message.payload.task.params.mode === 'build-site') copyBuildProtection(result.checkpoint, this.foodCheckpoint);
    if (result.outcome !== 'condition-wait') return;
    const condition = BuildWaitingForSchema.safeParse(result.checkpoint.waitingFor);
    if (!condition.success) return;
    this.buildWatches.set(message.taskId, { attemptId: message.attemptId, condition: condition.data });
    if (this.buildWatches.size > 16) this.buildWatches.delete(this.buildWatches.keys().next().value!);
  }

  receive(value: unknown): Promise<void> {
    this.inbox = this.inbox.then(async () => {
      const parsed = CentralMessageSchema.safeParse(value);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.botId !== this.launch.botId || message.sessionId !== this.launch.sessionId || message.controllerEpoch !== this.launch.controllerEpoch || this.seenMessages.has(message.messageId)) return;
      this.seenMessages.add(message.messageId);
      switch (message.type) {
        case 'task.assign': await this.assign(message); break;
        case 'task.cancel':
          if (this.buildWatches.get(message.taskId)?.attemptId === message.attemptId) this.buildWatches.delete(message.taskId);
          if (this.active?.message.taskId === message.taskId && this.active.message.attemptId === message.attemptId) await this.cancelActive(message.payload.reason, 'task.cancelled');
          break;
        case 'rules.update':
          if (message.payload.rules.version < this.launch.rules.version) break;
          if (this.active && message.payload.mode === 'queued') this.pendingRules = message;
          else { await this.cancelActive('규칙의 즉시 변경을 안전하게 적용합니다.', 'task.cancelled'); await this.stopLocal(); this.applyRules(message); }
          break;
        case 'bot.shutdown': await this.shutdown(message.payload.reason); break;
        case 'viewer.start':
          if (!this.ready) { this.message('bot.error', { code: 'VIEWER_NOT_READY', message: '봇이 실제 월드에 접속해야 화면을 열 수 있습니다.', retryable: false, effectsKnown: true }, message.commandId); break; }
          try {
            if (this.viewer) this.viewer.close();
            const viewer = await (this.dependencies.viewerFactory ?? createBotViewer)(this.bot, message.payload);
            if (!this.ready || this.stopping) { viewer.close(); break; }
            this.viewer = viewer;
            this.message('viewer.ready', message.payload, message.commandId);
          } catch (error) { this.viewer = undefined; this.message('bot.error', { code: 'VIEWER_FAILED', message: error instanceof Error ? error.message : '화면 연결 실패', retryable: false, effectsKnown: true }, message.commandId); }
          break;
        case 'viewer.stop': this.viewer?.close(); this.viewer = undefined; this.message('viewer.stopped', {}, message.commandId); break;
      }
    }).catch((error) => this.message('bot.error', { code: 'WORKER_COMMAND', message: error instanceof Error ? error.message : '명령 처리 실패', retryable: false, effectsKnown: false }));
    return this.inbox;
  }
  private applyRules(message: Extract<CentralMessage, { type: 'rules.update' }>): void {
    const connection = message.payload.config.connection, activeConnection = this.launch.config.connection;
    if (connection.host !== activeConnection.host || connection.port !== activeConnection.port || connection.auth !== activeConnection.auth || connection.version !== activeConnection.version || message.payload.config.name !== this.launch.config.name) {
      this.message('bot.error', { code: 'RECONNECT_REQUIRED', message: '접속 설정을 변경하려면 봇 연결을 새 세션으로 시작해야 합니다.', retryable: false, effectsKnown: true }, message.commandId); return;
    }
    this.launch.rules = message.payload.rules; this.launch.config = message.payload.config; this.executor.setRules(message.payload.rules, message.payload.config);
    this.pendingRules = undefined;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.dependencies.timers !== false) this.statusTimer = setInterval(() => { this.message('bot.status', this.report()); this.mapObservation(); }, this.launch.rules.statusIntervalMs);
    this.message('rules.applied', { version: this.launch.rules.version }, message.commandId);
  }
  private assignmentBlock(message: Assignment): AssignmentBlock | undefined {
    if (!this.ready || this.stopping || this.settlingLife || !this.centralConnected) return 'not-ready';
    if (!this.launch.config.enabled) return 'paused';
    if (this.active) return 'busy';
    if (this.emergencyActive()) return 'emergency';
    if (this.survivalUrgent()&&!foodReserveReturnAllowed(this.launch.rules,this.bot.health,this.bot.food,this.foodCheckpoint,message.payload.task)||this.nightWorkBlocked()) return 'survival';
    if (this.recoveryPending()) return 'recovery';
    if (message.payload.rulesVersion !== this.launch.rules.version) return 'rules';
  }
  private rejectAssignment(message: Assignment, blockedBy: AssignmentBlock): void {
    const reasons: Record<AssignmentBlock, string> = {
      'not-ready': '실제 접속·부활과 이전 동작의 안전한 종료를 기다립니다.',
      paused: '봇이 일시정지되어 작업 재개를 기다립니다.',
      busy: '현재 실행 중인 작업의 실제 종료를 기다립니다.',
      emergency: '실제 위협 대응이 끝난 뒤 보존한 작업을 재개합니다.',
      survival: this.nightWorkBlocked()?'사용할 야간 대피처가 없어 실제 낮 또는 장비 상태가 바뀐 뒤 보존한 작업을 재개합니다.':'체력·허기를 실제로 회복한 뒤 보존한 작업을 재개합니다.',
      recovery: '사망 복구와 현재 지면의 실제 안전을 확인한 뒤 작업을 재개합니다.',
      rules: '적용된 규칙 버전을 먼저 확인해야 합니다.',
      state: '일반 작업을 시작할 수 있는 실제 상태 보고를 기다립니다.',
    };
    this.message('bot.status', this.report());
    this.taskMessage(message, 'task.rejected', { reason: reasons[blockedBy], retryable: true, blockedBy });
  }
  private async assign(message: Assignment): Promise<void> {
    if (this.completedAttempts.has(message.attemptId) || this.active?.message.attemptId === message.attemptId) return;
    const blocked = this.assignmentBlock(message);
    if (blocked) { this.rejectAssignment(message, blocked); return; }
    if (!this.launch.config.allowedActions.includes(message.payload.task.kind) || !EXECUTABLE_ACTIONS.includes(message.payload.task.kind)) {
      this.taskMessage(message, 'task.rejected', { reason: '이 봇에 허용된 실행 가능한 작업이 아닙니다.', retryable: false }); return;
    }
    await this.stopLocal();
    if (this.pendingRules) this.applyRules(this.pendingRules);
    const changed = this.assignmentBlock(message);
    if (changed) { this.rejectAssignment(message, changed); return; }
    const controller = new AbortController(), services = this.executor.services(controller.signal, structuredClone(message.payload.checkpoint));
    if (this.recovery?.phase==='resolved' && this.recovery.safe) services.checkpoint.confirmedRecoveryDeathId=this.recovery.deathId;
    if (['collect','build'].includes(message.payload.task.kind)) reconcileResourceJourneys(this.bot, services.checkpoint, this.recovery);
    if (message.payload.task.kind === 'build' || message.payload.task.params.mode === 'build-site') {
      copyBuildProtection(message.payload.task.params, this.foodCheckpoint);
      copyBuildProtection(services.checkpoint, this.foodCheckpoint);
    }
    this.buildWatches.delete(message.taskId);
    const active: ActiveTask = { message, controller, services, promise: Promise.resolve(), life: this.life };
    this.active = active; this.mode = 'working'; this.action = message.payload.task.kind; this.reason = '중앙에서 배정한 작업을 수락했습니다.';
    this.taskMessage(message, 'task.accepted', {});
    active.promise = this.run(active);
  }
  private async run(active: ActiveTask): Promise<void> {
    const { message, services } = active;
    this.taskMessage(message, 'task.started', {});
    let failure: unknown;
    try {
      const result = await this.executor.execute(message.payload.task, services);
      if (!active.controller.signal.aborted) { this.rememberBuildWait(message, result); this.taskMessage(message, 'task.result', result); }
    } catch (error) {
      failure = error;
      if (!active.controller.signal.aborted) {
        services.observations.push(services.observeInventory());
        const result: ResultPayload = { outcome: error instanceof ConditionWait ? 'condition-wait' : error instanceof ActionFailure && error.effectsKnown ? 'failed' : 'uncertain', observations: services.observations, evidence: services.evidence, checkpoint: { ...services.checkpoint, ...(error instanceof ConditionWait ? error.checkpoint : {}) }, reason: error instanceof Error ? error.message : '실행 결과를 확인해야 합니다.', ...(error instanceof ConditionWait ? {} : { error: { code: error instanceof ActionFailure ? error.code : 'ACTION_UNCERTAIN', message: error instanceof Error ? error.message : '작업 실패', retryable: error instanceof ActionFailure && error.retryable, effectsKnown: error instanceof ActionFailure && error.effectsKnown } }) };
        this.rememberBuildWait(message, result);
        this.taskMessage(message, 'task.result', result);
      }
    } finally {
      this.executor.stopControls();
      if (message.payload.task.kind === 'build' || message.payload.task.params.mode === 'build-site') copyBuildProtection(services.checkpoint, this.foodCheckpoint);
      if (active.controller.signal.aborted) {
        services.observations.push(services.observeInventory());
        const safeStopped = failure === undefined || failure instanceof ConditionWait || failure instanceof ActionFailure && failure.effectsKnown;
        this.taskMessage(message, active.interruption ?? 'task.cancelled', { safeStopped, observations: services.observations, evidence: services.evidence, checkpoint: services.checkpoint, reason: active.reason ?? '진행을 보존하고 중단했습니다.' });
      }
      this.completedAttempts.add(message.attemptId);
      if (this.active === active) this.active = undefined;
      if (active.life !== this.life || !this.ready) return;
      this.mode = this.emergencyActive() ? 'emergency' : this.local?.mode ?? (this.recoveryPending() ? 'recovering' : 'idle'); this.action = this.launch.config.role === 'guard' ? '주변 경계' : '대기';
      this.reason = this.pendingRules ? '예약된 설정을 적용합니다.' : '관측과 다음 배정을 기다립니다.';
      if (this.pendingRules) this.applyRules(this.pendingRules);
      this.message('bot.status', this.report());
    }
  }
  private async cancelActive(reason: string, type: 'task.cancelled' | 'task.interrupted'): Promise<void> {
    const active = this.active; if (!active) return;
    active.reason = reason; active.interruption = type; active.controller.abort(); this.executor.stopControls();
    await active.promise;
  }
  private async stopLocal(): Promise<void> { const local = this.local; if (!local) return; local.controller.abort(); this.executor.stopControls(); await local.promise; }
  private emergencyActive(): boolean { return this.emergencyPending || this.local?.mode === 'emergency' || !!this.combatWait; }
  private survivalUrgent(): boolean {
    if (this.ready && this.healthReceived && this.bot.health > 0) {
      const trip=this.active&&resourceTrip(this.active.services.checkpoint);
      const homeDistance=trip?this.bot.entity.position.distanceTo(vector(trip.home)):0;
      const nearReturn=trip?.phase==='returning'&&homeDistance<=96&&this.bot.health>this.launch.rules.combat.supportHealth&&this.bot.food>6;
      const provision=!!trip&&trip.phase!=='complete'&&homeDistance>48&&this.bot.food<19&&!nearReturn;
      if(provision)this.foodCheckpoint.expeditionFoodTarget=19;
      const targetFood=this.foodCheckpoint.expeditionFoodTarget===19?19:18;
      const sheltered=(this.foodCheckpoint.nightBurrowPending===true||this.foodCheckpoint.nightBasePending===true);
      if (this.bot.health >= 20 && this.bot.food >= targetFood&&!sheltered) { this.survivalRecovery = undefined;delete this.foodCheckpoint.expeditionFoodTarget; }
      else if (!this.survivalRecovery && (sheltered||provision||survivalRecoveryNeeded(this.bot.health, this.bot.food, this.launch.rules.combat))) this.survivalRecovery = { startedAt: this.now(), targetHealth: 20, checkpoint: {} };
    }
    return !!this.survivalRecovery || survivalRecoveryNeeded(this.bot.health, this.bot.food, this.launch.rules.combat);
  }
  private survivalRecoverySnapshot(): SurvivalRecovery {
    return { startedAt: this.survivalRecovery!.startedAt, targetHealth: 20, checkpoint: structuredClone(this.foodCheckpoint),
      ...(this.foodWait ? { wait: structuredClone(this.foodWait) } : {}),
      knowledge: { ...(this.foodKnowledge.origin ? { origin: { ...this.foodKnowledge.origin } } : {}), blocks: [...this.foodKnowledge.blocks.values()].map(block => structuredClone(block)) } };
  }
  private startLocal(action: (s: ActionServices) => Promise<void>, mode: BotReport['mode'], checkpoint: JsonObject = {}, timeoutMs?: number): void {
    if (this.local || this.stopping || !this.ready || this.settlingLife) return;
    const controller = new AbortController(); this.mode = mode;let failed=false;
    const local: LocalAction = { controller, promise: Promise.resolve(), mode, life: this.life }; this.local = local;
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort('recovery-timeout'), Math.max(1, timeoutMs));
    local.promise = action(this.executor.services(controller.signal, checkpoint)).catch((error) => {
      failed=true;
      if (local.life === this.life && this.ready && (!controller.signal.aborted || controller.signal.reason === 'recovery-timeout')) {
        this.reason = error instanceof Error ? error.message : '조건을 확인해야 합니다.';
        if (mode === 'survival') {
          if (error instanceof ConditionWait) Object.assign(checkpoint, error.checkpoint);
          this.foodWait = { fingerprint: foodRecoveryFingerprint(this.bot, checkpoint, this.launch.rules.combat.retreatHealth, this.foodKnowledge), reason: this.reason };
        }
        if (mode === 'emergency') {
          if (error instanceof ConditionWait) Object.assign(checkpoint, error.checkpoint);
          const threats = this.nearbyThreats();
          const threat = threats.find(e => e.id === this.hitSource?.id && e.uuid === this.hitSource?.uuid) ?? threats[0];
          this.combatWait = { fingerprint: this.combatFingerprint(threat), retryAt: this.now() + 5000, reason: this.reason, threatId: threat?.uuid ?? `${threat?.id ?? ''}` };
          this.action = '지원·안전 경로 대기';
          if (threat) this.message('safety.alert', { response: 'support', reason: `안전한 대응을 확인하지 못했습니다. ${this.reason}`, supportRequired: true, threats: [{ entityId: threat.uuid ?? `${threat.id}`, name: threat.name ?? 'unknown', ...position(threat.position) }] });
        }
        if (mode === 'recovering' && this.recovery) {
          this.recovery.phase = 'held'; this.recovery.safe = recoverySafe(this.bot, this.launch.rules.combat.retreatHealth);
          this.recovery.reason = controller.signal.reason === 'recovery-timeout' ? '회수 이동의 시간 제한을 확인해 안전하게 중단했습니다. 남은 시도와 회수 수량을 보존합니다.' : this.reason;
          this.recovery.updatedAt = this.now(); this.publishRecovery();
        }
      }
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.executor.stopControls(); if (this.local === local) this.local = undefined;
      if (local.life !== this.life || !this.ready) return;
      this.mode = this.emergencyActive() ? 'emergency' : this.active ? 'working' : this.recoveryPending() ? 'recovering' : 'idle';
      if(mode==='idle'&&this.mode==='idle'){
        this.action=this.launch.config.role==='guard'?'주변 경계':'대기';
        if(!failed)this.reason=controller.signal.aborted?'재고 관측을 안전하게 중단했습니다. 다음 작업을 기다립니다.':'창고 재고 관측을 마쳤습니다. 다음 작업을 기다립니다.';
      }
      if (mode === 'survival' && !this.active && !this.emergencyActive()) {
        this.action = this.bot.food < 18 ? '식량 대기' : this.survivalUrgent() ? '회복 대기' : this.launch.config.role === 'guard' ? '주변 경계' : '대기';
        if (controller.signal.aborted) this.reason = '식량 복구 진행을 보존하고 안전하게 중단했습니다.';
        else if (!this.foodWait) this.reason = '기본 생존 상태를 확인했습니다. 다음 작업을 기다립니다.';
      }
      if (mode === 'recovering' && this.recovery && !this.emergencyActive()) {
        if (controller.signal.aborted && controller.signal.reason !== 'recovery-timeout' && this.recovery.phase !== 'resolved') { this.recovery.phase = 'held'; this.recovery.reason = '회수 진행을 보존하고 안전하게 중단했습니다. 재개 조건을 확인한 뒤 남은 회수를 진행합니다.'; }
        this.recovery.updatedAt = this.now();
        this.action = this.recovery.phase === 'resolved' ? this.recovery.safe ? '대기' : '안전 지면 대기' : '사망 아이템 회수 대기'; this.reason = this.recovery.reason;
        this.publishRecovery();
      }
      if (mode === 'emergency' && !this.combatWait && !this.emergencyPending) { this.action = '안전 상태 확인'; this.reason = '위험 대응 동작을 마쳤습니다. 현재 위협과 기본 생존 상태를 다시 확인합니다.'; }
      this.message('bot.status', this.report());
    });
  }
  private nightWorkBlocked():boolean {
    const gear=combatEquipment(this.bot);
    return this.launch.config.enabled&&this.foodCheckpoint.nightShelterUnavailable===true&&this.bot.time?.doDaylightCycle===true&&duskOrNight(this.bot)&&!(gear.weapon&&(gear.shield||gear.armorPoints>=12));
  }
  pollSafety(): void {
    if (!this.ready || this.stopping) return;
    if (this.recovery && expireDeathRecovery(this.bot, this.recovery, this.launch.rules.combat.retreatHealth, this.now())) {
      this.publishRecovery();
      if (this.local?.mode === 'recovering') void this.stopLocal();
    }
    if (this.emergencyPending || this.local?.mode === 'emergency' || this.executor.fighting) return;
    const enemies = this.nearbyThreats();
    if (this.hitSource && !enemies.some(e => e.id === this.hitSource!.id && e.uuid === this.hitSource!.uuid)) this.hitSource = undefined;
    if (this.combatWait && !enemies.length && recoverySafe(this.bot, this.launch.rules.combat.retreatHealth)) {
      this.combatWait = undefined;
      if (!this.local && !this.active) { this.mode = this.recoveryPending() ? 'recovering' : 'idle'; this.action = '대기'; this.reason = '위협 이탈과 현재 지면의 안전을 실제로 확인했습니다.'; this.message('bot.status', this.report()); }
    }
    if (this.combatWait && !enemies.length && !this.survivalUrgent()) {
      // The enemy leaving is a real change, but an edge remains unsafe. Use
      // the same bounded, observed exit rather than keeping an orphaned gate.
      // Critical hunger/health recovery must run first: the footing gate
      // itself requires health above retreatHealth and cannot heal the actor.
      // Keep combatWait intact until actual recovery proves it safe.
      if (!this.local && this.launch.config.enabled && this.now() >= this.combatWait.retryAt && this.combatWait.fingerprint !== this.combatFingerprint()) this.startLocal(async s => {
        if (!await leaveRecoveryEdge(this.bot, s, () => this.now()) || !recoverySafe(this.bot, this.launch.rules.combat.retreatHealth)) throw new ConditionWait(String((s.checkpoint.recoverySafety as JsonObject | undefined)?.reason ?? '현재 발판에서 안전한 지면으로 벗어날 경로를 기다립니다.'), s.checkpoint);
        this.combatWait = undefined; this.lastHitAt = 0; this.hitSource = undefined;
      }, 'emergency', this.combatCheckpoint);
      return;
    }
    const recentHit = this.now() - this.lastHitAt < 4000;
    const attacked = recentHit || !!this.combatWait;
    const equipment = combatEquipment(this.bot);
    const blastThreat=this.launch.config.enabled?enemies.find(e=>e.name==='creeper'&&e.position.distanceTo(this.bot.entity.position)<12&&visibleThreat(this.bot,e)):undefined;
    const exposed = blastThreat??(!attacked && this.launch.config.enabled ? enemies.find(e => !equipment.shield && equipment.armorPoints < 12 && visibleRangedThreat(this.bot,e) || !equipment.weapon && e.position.distanceTo(this.bot.entity.position)<12 && visibleThreat(this.bot,e)) : undefined);
    // Proactive defense needs actual sight. A mob behind a wall or above a
    // closed roof must not make a guard abandon its shelter to chase it.
    // A recent actual hit still permits defensive handling without a ray;
    // unavailable sight data remains conservative rather than proving cover.
    const target = blastThreat??(recentHit && this.hitSource && enemies.some((e) => e.id === this.hitSource!.id) ? this.hitSource : exposed ?? enemies.find(e=>visibleThreat(this.bot,e)) ?? (recentHit || typeof this.bot.world?.raycast !== 'function' ? enemies[0] : undefined));
    if (target) {
      const allies = Object.values(this.bot.players).filter((p) => p.entity && p.entity.id !== this.bot.entity.id && p.entity.position.distanceTo(this.bot.entity.position) < 8);
      const center = this.launch.rules.center;
      const threateningVillage = !!center && Math.hypot(target.position.x - center.x, target.position.z - center.z) <= this.launch.rules.radius || allies.some((p) => p.entity!.position.distanceTo(target.position) < 8);
      const decision = exposed ? { response: 'retreat' as const, reason: '가까운 실제 적에게 노출돼 피격 전에 안전한 지면과 엄폐를 확보합니다.', supportRequired: true } : assessCombat({ role: this.launch.config.role, health: this.bot.health, food: this.bot.food, ...equipment, rangedEnemies: enemies.filter(e => rangedThreat(e.name ?? '')).length, enemies: enemies.filter((e) => e.position.distanceTo(this.bot.entity.position) < 8).length, allies: allies.length, attacked, threateningVillage, targetName: target.name ?? '', distance: target.position.distanceTo(this.bot.entity.position) }, this.launch.rules);
      if (decision.response !== 'ignore') {
        if (this.combatWait && (this.now() < this.combatWait.retryAt || this.combatWait.fingerprint === this.combatFingerprint(target))) {
          this.action = '지원·안전 경로 대기'; this.reason = this.combatWait.reason; return;
        }
        this.combatWait = undefined;
        this.message('safety.alert', { response: decision.response, reason: decision.reason, supportRequired: decision.supportRequired, threats: enemies.slice(0, 64).map((e) => ({ entityId: e.uuid ?? `${e.id}`, name: e.name ?? 'unknown', ...position(e.position) })) });
        const life = this.life;
        const response = async (s: ActionServices) => {
          s.check(); await this.cancelActive(decision.reason, 'task.interrupted'); s.check();
          if (life !== this.life || !this.ready) return;
          this.mode = 'emergency'; this.action = decision.response; this.reason = decision.reason;
          copyBuildProtection(this.foodCheckpoint, s.checkpoint);
          if (decision.response === 'retreat' || decision.response === 'support') await this.executor.retreat(blastThreat??enemies.find(e => visibleRangedThreat(this.bot, e)) ?? target, s);
          else await this.executor.fightEntity(target, s);
          s.check();
          this.lastHitAt = 0; this.hitSource = undefined;
        };
        if (this.local) {
          this.emergencyPending = true; this.mode = 'emergency';
          void this.stopLocal().then(() => { if (life === this.life && this.ready && !this.stopping) this.startLocal(response, 'emergency', this.combatCheckpoint); })
            .finally(() => { if (life === this.life) this.emergencyPending = false; });
        } else this.startLocal(response, 'emergency', this.combatCheckpoint);
        return;
      }
    }
    // A long-running food search must yield when dusk arrives. It otherwise
    // bypasses the idle-only night policy until the entire search finishes.
    if(this.local?.mode==='survival'&&this.launch.config.enabled&&this.foodCheckpoint.nightBurrowPending!==true&&this.foodCheckpoint.nightBasePending!==true&&this.foodCheckpoint.nightShelterUnavailable!==true&&this.bot.time?.doDaylightCycle===true&&duskOrNight(this.bot)&&this.bot.health>this.launch.rules.combat.retreatHealth&&['build','collect'].every(action=>this.launch.config.allowedActions.includes(action as ActionKind))){
      const gear=combatEquipment(this.bot);
      if(!(gear.weapon&&(gear.shield||gear.armorPoints>=12))){
        if(!this.local.controller.signal.aborted){const life=this.life;void this.stopLocal().then(()=>{if(life!==this.life||!this.ready||this.stopping||!this.launch.config.enabled)return;this.startLocal(async s=>{if(!await this.executor.shelterAtNight(s))this.foodCheckpoint.nightShelterUnavailable=true;},'survival',this.foodCheckpoint);});}
        return;
      }
    }
    // Optional reserve provisioning must not keep a restored body's stale
    // death-safety gate unresolved. Prove the current ground first, without
    // altering either recovery record or any spent search allowance.
    if(this.launch.config.enabled&&this.recoveryPending()&&foodReserveReturnAllowed(this.launch.rules,this.bot.health,this.bot.food,this.foodCheckpoint)){
      if(this.local?.mode==='survival'){
        if(!this.local.controller.signal.aborted){const life=this.life;void this.stopLocal().then(()=>{if(life===this.life&&this.ready&&!this.stopping)this.recoverDeath();});}
      }else if(!this.local)this.recoverDeath();
      return;
    }
    if (this.local) return;
    const urgentSurvival = this.survivalUrgent() && !(this.active && foodReserveReturnAllowed(this.launch.rules,this.bot.health,this.bot.food,this.foodCheckpoint,this.active.message.payload.task));
    if(this.launch.config.enabled&&(!this.recovery||this.recovery.phase==='resolved')&&(this.foodCheckpoint.nightBurrowPending===true||this.foodCheckpoint.nightBasePending===true)){
      // A restored body can be deliberately below ground or behind a closed
      // door. Finish that shelter's verified exit before generic death-recovery
      // footing checks, which would otherwise try to leave the sealed room.
      this.startLocal(async s=>{await this.cancelActive('보존한 은신처의 안전한 종료를 먼저 확인합니다.','task.interrupted');await this.executor.shelterAtNight(s);},'survival',this.foodCheckpoint);return;
    }
    if (urgentSurvival && this.launch.config.enabled && this.recovery?.phase === 'resolved' && !this.recovery.safe && !this.recovery.checkpoint.recoverySafety && this.bot.health > this.launch.rules.combat.retreatHealth && this.bot.food > 6 && !enemies.length) { this.recoverDeath(); return; }
    if (this.combatWait && !urgentSurvival) { this.action = '지원·안전 경로 대기'; this.reason = this.combatWait.reason; return; }
    if (this.recoveryPending() && (!urgentSurvival||(this.foodCheckpoint.nightBurrowPending===true||this.foodCheckpoint.nightBasePending===true)&&!survivalRecoveryNeeded(this.bot.health,this.bot.food,this.launch.rules.combat))) { this.recoverDeath(); return; }
    if (!this.launch.config.enabled && !urgentSurvival) return;
    const actualNight=this.bot.time?.doDaylightCycle===true&&duskOrNight(this.bot);
    if(this.bot.time?.isDay===true&&!duskOrNight(this.bot)){delete this.foodCheckpoint.nightShelterUnavailable;delete this.foodCheckpoint.nightBurrowChecked;}
    const searchOrigin=PositionSchema.safeParse((this.foodCheckpoint.nightBurrowSearch as JsonObject|undefined)?.origin);
    if(searchOrigin.success&&vector(this.bot.entity.position).distanceTo(vector(searchOrigin.data))>16)delete this.foodCheckpoint.nightShelterUnavailable;
    const nightGear=combatEquipment(this.bot);
    if(actualNight&&this.launch.config.enabled&&this.foodCheckpoint.nightShelterUnavailable!==true&&!(nightGear.weapon&&(nightGear.shield||nightGear.armorPoints>=12))&&['build','collect'].every(action=>this.launch.config.allowedActions.includes(action as ActionKind))){
      this.survivalRecovery??={startedAt:this.now(),targetHealth:20,checkpoint:{}};
      this.startLocal(async s=>{await this.cancelActive('야간 거점 대피를 위해 작업 진행을 보존합니다.','task.interrupted');if(!await this.executor.shelterAtNight(s)){this.foodCheckpoint.nightBurrowPending=false;this.foodCheckpoint.nightShelterUnavailable=true;}},'survival',this.foodCheckpoint);return;
    }
    if(this.nightWorkBlocked()&&!urgentSurvival){
      this.startLocal(async s=>{
        await this.cancelActive('사용할 야간 대피처가 없어 일반 작업의 진행을 보존합니다.','task.interrupted');
        while(this.nightWorkBlocked()&&!this.survivalUrgent()){
          s.check();this.action='안전한 대피처 대기';this.reason='실제로 사용할 대피처를 찾지 못해 일반 원정을 중단하고 낮이나 장비 상태 변화를 기다립니다.';await s.pause(1000);
        }
      },'survival',this.foodCheckpoint);return;
    }
    if (this.active && !urgentSurvival) return;
    const needsFood = urgentSurvival || this.bot.food < 18;
    const urgentInterruption = urgentSurvival && !!this.active;
    const foodCheckDue = needsFood && (urgentInterruption || this.now() - this.lastFoodAttemptAt > 10000);
    const canExpandFood = this.launch.config.enabled && this.launch.config.allowedActions.includes('explore') && foodSearchCanExpand(this.foodCheckpoint, this.bot);
    const changedFoodCondition = foodCheckDue && (urgentInterruption || !this.foodWait || canExpandFood || foodRecoveryFingerprint(this.bot, this.foodCheckpoint, this.launch.rules.combat.retreatHealth, this.foodKnowledge) !== this.foodWait.fingerprint);
    if (foodCheckDue) this.lastFoodAttemptAt = this.now();
    if (changedFoodCondition) {
      this.foodWait = undefined;
      this.startLocal(async (s) => {
        if (urgentSurvival) await this.cancelActive('기본 생존 상태를 회복하기 위해 진행을 보존합니다.', 'task.interrupted');
        this.mode = 'survival';
        while (this.bot.food < 18 || this.survivalUrgent()) {
          s.check();
          if((s.checkpoint.nightBurrowPending===true||s.checkpoint.nightBasePending===true)){await this.executor.shelterAtNight(s);continue;}
          if (this.bot.food >= (s.checkpoint.expeditionFoodTarget===19?19:18)) {
            this.action = '회복 대기'; this.reason = '허기가 충분하므로 서버에서 체력이 20까지 실제로 회복되는지 확인합니다.';
            this.message('bot.status', this.report()); await s.pause(1000); continue;
          }
          this.action = '식량 확보'; this.reason = '기본 생존에 필요한 식량을 확보합니다.';
          if (!await this.executor.eat(s)) {
            await this.executor.ensureFood(s);
            if (this.bot.food<(s.checkpoint.expeditionFoodTarget===19?19:18)&&!await this.executor.eat(s)) throw new ConditionWait('확보한 식량의 실제 섭취 조건을 확인해야 합니다.');
          }
          await s.pause(250);
        }
      }, 'survival', this.foodCheckpoint);
      return;
    }
    if (this.active) return;
    const warehouse = this.launch.rules.warehouse;
    const base = this.launch.rules.baseShelter;
    // At dawn the designated producer can be just outside a closed warehouse.
    // A local-only refresh there deadlocks supply planning on stale stock.
    // Permit that idle producer's short registered door passage; other actors
    // and distant work still retain their position. Survival gates run first.
    const producerAtBase = !!warehouse && !!base && this.launch.config.enabled && this.launch.rules.autonomyEnabled &&
      this.launch.rules.baseAutonomy?.botId === this.launch.botId && base.warehouseId === warehouse.id &&
      base.world === this.launch.rules.world && base.dimension === this.launch.rules.dimension &&
      warehouse.world === base.world && warehouse.dimension === base.dimension && this.bot.entity.onGround === true &&
      vector(this.bot.entity.position).distanceTo(vector(base.outside)) <= 6;
    if (this.centralConnected && warehouse && (this.executor.canObserveContainerHere(warehouse) || producerAtBase) && Date.now() - this.lastWarehouseAt > 10000) {
      this.lastWarehouseAt = Date.now();
      this.startLocal(async (s) => {
        const observation = await this.executor.observeContainer(warehouse, s, producerAtBase);
        if (observation.kind === 'container') this.foodCheckpoint.foodWarehouse = { container: { ...observation.data.container, position: { ...observation.data.container.position } }, items: observation.data.items.map(item => ({ ...item })) };
        this.message('world.observed', { observations: s.observations });
      }, 'idle');
    }
  }
  centralDisconnected(): void {
    this.centralConnected = false;
    void this.cancelActive('중앙 연결이 끊겨 일반 작업을 중단합니다.', 'task.interrupted');
    if (this.local?.mode === 'idle') void this.stopLocal();
    this.reason = '중앙 연결 없이 위험 대응과 기본 생존을 수행합니다.';
  }
  async shutdown(reason = '봇 종료 요청'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true; this.clearTimers();
    if (this.liveInventoryRefresh) clearImmediate(this.liveInventoryRefresh);
    this.liveInventoryRefresh = undefined;
    this.liveInventoryWatch?.window.off('updateSlot', this.liveInventoryWatch.listener);
    this.liveInventoryWatch = undefined;
    await this.cancelActive(reason, 'task.cancelled'); await this.stopLocal(); this.viewer?.close(); this.viewer = undefined;
    await this.deathCleanup;
    this.bot.quit(reason);
  }
}

export async function bootWorker(): Promise<MinecraftWorker> {
  const launch = WorkerLaunchSchema.parse(JSON.parse(process.env.LAYA_WORKER_BOOTSTRAP ?? 'null'));
  if (process.env.LAYA_WORKER_SESSION !== launch.sessionId) throw new Error('워커 세션 식별이 일치하지 않습니다.');
  const bot = await createCompatibleBot({ ...launch.config.connection, username: launch.config.name, profilesFolder: join(process.env.RUNTIME_DIR ?? 'runtime', 'auth', Buffer.from(launch.botId).toString('base64url')) });
  bot.loadPlugin(pathfinder);
  const worker = new MinecraftWorker(launch, bot, (message) => { if (process.connected) process.send?.(message, (error) => { if (error) worker.centralDisconnected(); }); });
  process.on('message', (message) => { void worker.receive(message); });
  process.on('disconnect', () => worker.centralDisconnected());
  if (!process.connected) worker.centralDisconnected();
  process.on('SIGTERM', () => { void worker.shutdown('프로세스 종료 요청'); });
  process.on('SIGINT', () => { void worker.shutdown('프로세스 종료 요청'); });
  bot.once('end', () => { setTimeout(() => process.exit(0), 20); });
  return worker;
}
if (require.main === module) void bootWorker().catch((error: unknown) => {
  console.error('Minecraft worker startup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
