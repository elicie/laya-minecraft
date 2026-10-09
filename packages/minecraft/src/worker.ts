import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Bot } from 'mineflayer';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import type { Entity } from 'prismarine-entity';
import {
  CentralMessageSchema, WorkerLaunchSchema, WorkerMessageSchema, PROTOCOL_VERSION,
  type BotReport, type CentralMessage, type ResultPayload, type WorkerLaunch, type WorkerMessage,
} from '../../contracts/src';
import { MineflayerExecutor, EXECUTABLE_ACTIONS, type ExecutorOptions } from './actions';
import { executeVillageTask } from './village-actions';
import { ActionFailure, ConditionWait, type ActionServices } from './services';
import { inventory, nearbyBlocks, position } from './observations';
import { assessCombat, HOSTILES } from './combat-policy';
import { createBotViewer } from './viewer';
import { createCompatibleBot } from './compatibility';

type Assignment = Extract<CentralMessage, { type: 'task.assign' }>;
interface ActiveTask { message: Assignment; controller: AbortController; services: ActionServices; promise: Promise<void>; interruption?: 'task.cancelled' | 'task.interrupted'; reason?: string; }
export interface WorkerDependencies {
  executorFactory?: (bot: Bot, options: ExecutorOptions) => MineflayerExecutor;
  movementsFactory?: (bot: Bot) => Movements;
  viewerFactory?: typeof createBotViewer;
  timers?: boolean;
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
  private local?: { controller: AbortController; promise: Promise<void>; mode: BotReport['mode'] };
  private emergencyPending = false;
  private inbox = Promise.resolve();
  private readonly seenMessages = new Set<string>();
  private readonly completedAttempts = new Set<string>();
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

  constructor(readonly launch: WorkerLaunch, readonly bot: Bot, private readonly transport: (message: WorkerMessage) => void, private readonly dependencies: WorkerDependencies = {}) {
    this.executor = (dependencies.executorFactory ?? ((bot, options) => new MineflayerExecutor(bot, options)))(bot, {
      config: launch.config, rules: launch.rules, world: `${launch.config.connection.host}:${launch.config.connection.port}`,
      dimension: () => String(bot.game?.dimension ?? launch.rules.dimension), villageTask: executeVillageTask,
      onProgress: (action, reason) => {
        this.action = action; this.reason = reason;
        const active = this.active;
        if (active) this.taskMessage(active.message, 'task.progress', { action, reason, checkpoint: active.services.checkpoint, observations: active.services.observations.slice(-4) });
      },
    });
    bot.on('spawn', () => this.spawned());
    bot.on('health', () => {
      this.healthReceived = Number.isFinite(bot.health) && Number.isFinite(bot.food);
      if (this.spawnPending && this.healthReceived && bot.health > 0) this.spawned();
    });
    bot.on('entityHurt', (entity, source) => {
      if (entity.id === bot.entity?.id) { this.lastHitAt = Date.now(); this.hitSource = source; }
    });
    bot.on('death', () => {
      this.ready = false; this.action = '사망 후 복구'; this.reason = '월드와 남은 작업을 다시 확인합니다.';
      this.healthReceived = false;
      void this.stopLocal();
      if (this.active) {
        this.active.services.checkpoint.deathPosition = position(bot.entity.position);
        this.active.services.checkpoint.deathInventory = inventory(bot);
        void this.cancelActive('사망으로 작업을 중단하고 진행을 보존합니다.', 'task.interrupted');
      }
    });
    bot.on('error', (error) => this.message('bot.error', { code: 'MINECRAFT_ERROR', message: error.message, retryable: true, effectsKnown: false }));
    bot.on('kicked', () => { this.ready = false; this.reason = 'Minecraft 서버에서 연결을 종료했습니다.'; });
    bot.on('end', (reason) => {
      this.ready = false; this.stopping = true; this.active?.controller.abort(); this.local?.controller.abort(); this.clearTimers();
      this.viewer?.close(); this.viewer = undefined;
      this.message('bot.stopped', { reason: String(reason) });
    });
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
    const config = this.launch.config;
    return {
      ready: this.ready && !this.stopping,
      ...(this.ready && this.bot.entity ? { position: position(this.bot.entity.position) } : {}),
      world: `${config.connection.host}:${config.connection.port}`, dimension: String(this.bot.game?.dimension ?? this.launch.rules.dimension),
      health: Math.max(0, Math.min(20, this.bot.health ?? 0)), food: Math.max(0, Math.min(20, this.bot.food ?? 0)),
      inventory: this.ready && this.bot.inventory ? inventory(this.bot) : [], action: this.action, reason: this.reason,
      mode: this.stopping ? 'stopping' : !config.enabled ? 'paused' : this.mode,
      capabilities: EXECUTABLE_ACTIONS.filter((action) => config.allowedActions.includes(action)),
      ...(this.active ? { currentAttemptId: this.active.message.attemptId } : {}), rulesVersion: this.launch.rules.version, viewerReady: !!this.viewer,
    };
  }
  private spawned(): void {
    if (this.stopping) return;
    if (!this.healthReceived || this.bot.health <= 0) {
      this.spawnPending = true; this.reason = '서버의 실제 체력과 허기 보고를 기다립니다.'; return;
    }
    this.spawnPending = false;
    const movements = (this.dependencies.movementsFactory ?? ((bot) => new Movements(bot)))(this.bot);
    movements.canDig = false; movements.canOpenDoors = true; movements.allow1by1towers = false; movements.maxDropDown = 3; movements.allowParkour = false;
    const farmland = this.bot.registry?.blocksByName?.farmland;
    if (farmland && movements.blocksToAvoid) movements.blocksToAvoid.add(farmland.id);
    this.bot.pathfinder.setMovements(movements); this.bot.pathfinder.thinkTimeout = 8000;
    this.ready = true; this.action = this.launch.config.role === 'guard' ? '주변 경계' : '대기'; this.reason = '실제 월드 관측과 중앙 배정을 기다립니다.';
    this.message('bot.ready', this.report());
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
    if (!this.ready || Date.now() - this.lastMapAt < 5000) return;
    this.lastMapAt = Date.now();
    this.message('world.observed', { observations: [this.executor.services(new AbortController().signal).observeInventory(), nearbyBlocks(this.bot, this.executor.options.world, this.executor.options.dimension())] });
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
        case 'task.cancel': if (this.active?.message.taskId === message.taskId && this.active.message.attemptId === message.attemptId) await this.cancelActive(message.payload.reason, 'task.cancelled'); break;
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
  private async assign(message: Assignment): Promise<void> {
    if (this.completedAttempts.has(message.attemptId) || this.active?.message.attemptId === message.attemptId) return;
    if (!this.ready || this.stopping || !this.centralConnected || !this.launch.config.enabled || this.active || this.emergencyActive() || this.survivalUrgent()) {
      this.taskMessage(message, 'task.rejected', { reason: '현재 상태에서는 일반 작업을 시작할 수 없습니다.', retryable: true }); return;
    }
    if (!this.launch.config.allowedActions.includes(message.payload.task.kind) || !EXECUTABLE_ACTIONS.includes(message.payload.task.kind)) {
      this.taskMessage(message, 'task.rejected', { reason: '이 봇에 허용된 실행 가능한 작업이 아닙니다.', retryable: false }); return;
    }
    if (message.payload.rulesVersion !== this.launch.rules.version) { this.taskMessage(message, 'task.rejected', { reason: '적용된 규칙 버전을 먼저 확인해야 합니다.', retryable: true }); return; }
    await this.stopLocal();
    if (this.pendingRules) this.applyRules(this.pendingRules);
    if (!this.ready || this.stopping || !this.centralConnected || !this.launch.config.enabled || this.emergencyActive() || this.survivalUrgent() || message.payload.rulesVersion !== this.launch.rules.version) {
      this.taskMessage(message, 'task.rejected', { reason: '작업 준비 중 월드 상태나 규칙이 바뀌었습니다.', retryable: true }); return;
    }
    const controller = new AbortController(), services = this.executor.services(controller.signal, structuredClone(message.payload.checkpoint));
    const active: ActiveTask = { message, controller, services, promise: Promise.resolve() };
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
      if (!active.controller.signal.aborted) this.taskMessage(message, 'task.result', result);
    } catch (error) {
      failure = error;
      if (!active.controller.signal.aborted) {
        services.observations.push(services.observeInventory());
        const result: ResultPayload = { outcome: error instanceof ConditionWait ? 'condition-wait' : error instanceof ActionFailure && error.effectsKnown ? 'failed' : 'uncertain', observations: services.observations, evidence: services.evidence, checkpoint: { ...services.checkpoint, ...(error instanceof ConditionWait ? error.checkpoint : {}) }, reason: error instanceof Error ? error.message : '실행 결과를 확인해야 합니다.', ...(error instanceof ConditionWait ? {} : { error: { code: error instanceof ActionFailure ? error.code : 'ACTION_UNCERTAIN', message: error instanceof Error ? error.message : '작업 실패', retryable: error instanceof ActionFailure && error.retryable, effectsKnown: error instanceof ActionFailure && error.effectsKnown } }) };
        this.taskMessage(message, 'task.result', result);
      }
    } finally {
      this.executor.stopControls();
      if (active.controller.signal.aborted) {
        services.observations.push(services.observeInventory());
        const safeStopped = failure === undefined || failure instanceof ConditionWait || failure instanceof ActionFailure && failure.effectsKnown;
        this.taskMessage(message, active.interruption ?? 'task.cancelled', { safeStopped, observations: services.observations, evidence: services.evidence, checkpoint: services.checkpoint, reason: active.reason ?? '진행을 보존하고 중단했습니다.' });
      }
      this.completedAttempts.add(message.attemptId);
      if (this.active === active) this.active = undefined;
      this.mode = this.emergencyPending ? 'emergency' : this.local?.mode ?? 'idle'; this.action = this.launch.config.role === 'guard' ? '주변 경계' : '대기';
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
  private emergencyActive(): boolean { return this.emergencyPending || this.local?.mode === 'emergency'; }
  private survivalUrgent(): boolean { return this.bot.food <= 6 || this.bot.health <= this.launch.rules.combat.retreatHealth; }
  private startLocal(action: (s: ActionServices) => Promise<void>, mode: BotReport['mode']): void {
    if (this.local || this.stopping) return;
    const controller = new AbortController(); this.mode = mode;
    const local = { controller, promise: Promise.resolve(), mode }; this.local = local;
    local.promise = action(this.executor.services(controller.signal)).catch((error) => { if (!controller.signal.aborted) this.reason = error instanceof Error ? error.message : '조건을 확인해야 합니다.'; }).finally(() => { this.executor.stopControls(); if (this.local === local) this.local = undefined; this.mode = this.emergencyPending ? 'emergency' : this.active ? 'working' : 'idle'; this.message('bot.status', this.report()); });
  }
  pollSafety(): void {
    if (!this.ready || this.stopping || this.emergencyPending || this.local?.mode === 'emergency' || this.executor.fighting) return;
    const enemies = Object.values(this.bot.entities).filter((e) => HOSTILES.has(e.name ?? '') && e.position.distanceTo(this.bot.entity.position) < 20).sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position));
    const attacked = Date.now() - this.lastHitAt < 4000;
    const target = this.hitSource && enemies.some((e) => e.id === this.hitSource!.id) ? this.hitSource : enemies[0];
    if (target) {
      const allies = Object.values(this.bot.players).filter((p) => p.entity && p.entity.id !== this.bot.entity.id && p.entity.position.distanceTo(this.bot.entity.position) < 8);
      const center = this.launch.rules.center;
      const threateningVillage = !!center && Math.hypot(target.position.x - center.x, target.position.z - center.z) <= this.launch.rules.radius || allies.some((p) => p.entity!.position.distanceTo(target.position) < 8);
      const decision = assessCombat({ role: this.launch.config.role, health: this.bot.health, food: this.bot.food, weapon: this.bot.inventory.items().some((i) => /_(sword|axe)$/.test(i.name)), shield: this.bot.inventory.slots[45]?.name === 'shield', enemies: enemies.filter((e) => e.position.distanceTo(this.bot.entity.position) < 8).length, allies: allies.length, attacked, threateningVillage, targetName: target.name ?? '', distance: target.position.distanceTo(this.bot.entity.position) }, this.launch.rules);
      if (decision.response !== 'ignore') {
        this.message('safety.alert', { response: decision.response, reason: decision.reason, supportRequired: decision.supportRequired, threats: enemies.map((e) => ({ entityId: `${e.id}`, name: e.name ?? 'unknown', ...position(e.position) })) });
        const response = async (s: ActionServices) => {
          await this.cancelActive(decision.reason, 'task.interrupted'); this.mode = 'emergency'; this.action = decision.response; this.reason = decision.reason;
          if (decision.response === 'retreat' || decision.response === 'support') await this.executor.retreat(target, s);
          else await this.executor.fightEntity(target, s);
          this.lastHitAt = 0; this.hitSource = undefined;
        };
        if (this.local) {
          this.emergencyPending = true; this.mode = 'emergency';
          void this.stopLocal().then(() => { if (this.ready && !this.stopping) this.startLocal(response, 'emergency'); })
            .finally(() => { this.emergencyPending = false; });
        } else this.startLocal(response, 'emergency');
        return;
      }
    }
    if (this.local) return;
    const urgentSurvival = this.survivalUrgent();
    if (this.active && !urgentSurvival) return;
    if ((urgentSurvival || this.bot.food < 18) && Date.now() - this.lastFoodAttemptAt > 10000) {
      this.lastFoodAttemptAt = Date.now();
      this.startLocal(async (s) => {
        if (urgentSurvival) await this.cancelActive('기본 생존 상태를 회복하기 위해 진행을 보존합니다.', 'task.interrupted');
        this.mode = 'survival';
        this.action = '식량 확보'; this.reason = '기본 생존에 필요한 식량을 확보합니다.';
        if (this.bot.food >= 18) { await s.pause(1000); return; }
        if (await this.executor.eat(s)) return;
        for (const item of ['bread', 'carrot', 'cooked_beef']) {
          try { await this.executor.ensureItem(item, 1, s); if (await this.executor.eat(s)) return; } catch { s.check(); }
        }
        throw new ConditionWait('먹을 수 있는 식량이나 자원을 기다립니다.');
      }, 'survival');
      return;
    }
    if (this.active) return;
    const warehouse = this.launch.rules.warehouse;
    if (this.centralConnected && warehouse && Date.now() - this.lastWarehouseAt > 10000) {
      this.lastWarehouseAt = Date.now();
      this.startLocal(async (s) => { await this.executor.observeContainer(warehouse, s); this.message('world.observed', { observations: s.observations }); }, 'idle');
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
    await this.cancelActive(reason, 'task.cancelled'); await this.stopLocal(); this.viewer?.close(); this.viewer = undefined;
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
