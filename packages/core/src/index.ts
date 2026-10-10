import { randomUUID } from 'node:crypto';
import {
  BuildAccessPreparationSchema, accessPreparationFinalBlocks, validateBuildAccessPreparation, BlueprintDefinitionSchema, BlueprintInputSchema, BotInputSchema, BotPatchSchema, BuildSiteSchema, BuildSitePreparationSchema, BuildWaitingForSchema, DeathRecordSchema, DEFAULT_RULES, FleetCheckpointSchema, GoalInputSchema, GoalPatchSchema, PositionSchema, PreparationVerificationSchema, PROTOCOL_VERSION, RulesPatchSchema, RulesSchema, WorkerMessageSchema,
  buildSiteCells, isBuildSiteAir, isBuildSiteGround, itemCount, matchesPreparationTarget, resourceNamesFor, sameContainer, validateBuildSitePreparation,
  type Agent, type BotInput, type BotPatch, type CentralMessage, type CoreEvent, type ExecutionMode, type FleetCheckpoint, type FleetSnapshot,
  type Goal, type GoalInput, type GoalPatch, type JsonObject, type Observation, type ObservationInput, type ResultPayload,
  type DeathRecord, type RecoveryState, type BlueprintDefinition, type BlueprintInput, type BuildSite, type BuildSitePreparation, type BuildWaitingFor, type ExpectedBlock, type GoalDefinition, type Position, type Rules, type RulesPatch, type Task, type TaskAttempt, type WorkerMessage,
} from '../../contracts/src';
import { containerKey, goalTitle, jsonObject, planGoal, roleFits } from './planning';
import { BLUEPRINTS, blueprint, resolveBlueprint } from '../../contracts/src/blueprints';
import { distance, footprintInside, freshObservations, positionKey, verifyCompletion } from './verification';

export { planGoal, containerKey, roleFits } from './planning';
export { verifyCompletion, footprintInside } from './verification';
export interface SchedulerDecision { id: string; source: 'laya' | 'code'; reason: string; confidence?: number; model?: string; }
export interface FleetControllerOptions {
  now?: () => number;
  controllerEpoch?: string;
  send: (botId: string, message: CentralMessage) => void;
  onChange?: (snapshot: FleetSnapshot, event: CoreEvent) => void;
  checkpoint?: FleetCheckpoint;
  rules?: Partial<Rules>;
  decide?: (request: { state: string; candidates: { id: string; description: string }[]; signal?: AbortSignal }) => Promise<SchedulerDecision>;
}
const terminalGoals = new Set(['completed', 'cancelled']);
const activeAttempts = new Set(['assigned', 'accepted', 'running', 'cancelling']);
const runnable = new Set(['waiting', 'interrupted', 'retry-wait', 'condition-wait']);
const isStockGoal = (goal: Goal) => goal.input.kind === 'collect' || (goal.input.kind === 'hunt' && !!goal.input.item);
const isBuildSiteTask = (task: Task) => task.kind === 'explore' && task.params.mode === 'build-site';
const isSitePreparationTask = (task: Task) => task.kind === 'build' && task.params.mode === 'prepare-site';
const isAccessPreparationTask = (task: Task) => task.kind === 'build' && task.params.mode === 'prepare-access';
const isPreparationTask = (task: Task) => isSitePreparationTask(task) || isAccessPreparationTask(task);
const isBuildStageTask = (task: Task) => isBuildSiteTask(task) || isSitePreparationTask(task);
const resourceActions = new Set(['collect', 'craft', 'smelt', 'build', 'farm', 'breed']);
const clone = <T>(value: T): T => structuredClone(value);
const taskSpec = (task: Task) => ({ id: task.id, goalId: task.goalId, kind: task.kind, ...(task.source ? { source: task.source } : {}), params: task.params, dependencies: task.dependencies, completion: task.completion, reservationKeys: task.reservationKeys, ...(task.affinityBotId ? { affinityBotId: task.affinityBotId } : {}) });

export class FleetController {
  readonly controllerEpoch: string;
  private readonly now: () => number;
  private readonly options: FleetControllerOptions;
  private state: FleetCheckpoint;
  private messageIds: Set<string>;
  private ticking = false;
  private disposed = false;
  private decisions = new Map<string, { token: string; sessionId: string; taskIds: string[]; requestedAt: number; abort: AbortController }>();

  constructor(options: FleetControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.controllerEpoch = options.controllerEpoch ?? randomUUID();
    this.state = options.checkpoint ? FleetCheckpointSchema.parse(options.checkpoint) : {
      schemaVersion: 1, controllerEpoch: this.controllerEpoch, revision: 0, updatedAt: this.now(), rules: RulesSchema.parse(options.rules ?? DEFAULT_RULES),
      blueprints: [], agents: [], goals: [], tasks: [], attempts: [], reservations: [], observations: [], events: [], processedMessageIds: [], pendingRuleCommands: [], pendingCommands: [], stoppedSessionIds: [],
    };
    this.state.pendingCommands ??= [];
    this.state.stoppedSessionIds ??= [];
    this.state.pendingRuleCommands ??= [];
    this.state.controllerEpoch = this.controllerEpoch;
    this.state.revision = 0;
    this.state.observations = [];
    this.messageIds = new Set(this.state.processedMessageIds ?? []);
    for (const agent of this.state.agents) {
      if (agent.session && agent.session.state !== 'stopped') {
        agent.session.state = 'abnormal';
        agent.session.report = undefined;
        agent.status = agent.status === 'removing' ? 'removing' : agent.config.enabled ? 'abnormal' : 'paused';
      }
      if (agent.recovery) { agent.recovery.safe = false; agent.recovery.reason = '새 중앙 세션에서 복구 결과와 안전 상태를 다시 확인합니다.'; }
      agent.viewer = { state: 'stopped' };
    }
    for (const attempt of this.state.attempts) if (activeAttempts.has(attempt.state)) {
      attempt.state = 'uncertain';
      const task = this.state.tasks.find(t => t.id === attempt.taskId);
      if (task) { task.state = 'held'; task.reason = '중앙 재시작: 이전 실행 종료와 실제 월드를 확인해야 합니다.'; task.checkpoint.reconcile = true; }
    }
  }

  getSnapshot(): FleetSnapshot {
    const { processedMessageIds: _messages, pendingRuleCommands: _rules, pendingCommands: _commands, stoppedSessionIds: _stopped, ...snapshot } = this.state;
    return clone(snapshot);
  }
  checkpoint(): FleetCheckpoint { return clone(this.state); }
  createBlueprint(input: BlueprintInput, commandId?: string): BlueprintDefinition {
    if (this.state.blueprints.length >= 1000) throw new Error('설계도는 최대 1000개까지 저장할 수 있습니다.');
    const editable = this.validateBlueprintInput(input), definition = BlueprintDefinitionSchema.parse({ ...editable, id: randomUUID(), version: 1, createdAt: this.now(), updatedAt: this.now() });
    blueprint(definition.id, { x: 0, y: 0, z: 0 }, definition.wood, definition);
    this.state.blueprints.push(definition);
    this.changed('blueprint.created', '사용자 설계도를 저장했습니다.', { commandId, data: { blueprintId: definition.id, version: definition.version } }); this.applied(commandId, { blueprintId: definition.id, version: definition.version });
    return clone(definition);
  }
  updateBlueprint(id: string, input: BlueprintInput, commandId?: string): BlueprintDefinition {
    const index = this.state.blueprints.findIndex(b => b.id === id); if (index < 0) throw new Error('수정할 사용자 설계도를 찾을 수 없습니다.');
    const old = this.state.blueprints[index]!, editable = this.validateBlueprintInput(input, id), definition = BlueprintDefinitionSchema.parse({ ...editable, id, version: old.version + 1, createdAt: old.createdAt, updatedAt: this.now() });
    blueprint(id, { x: 0, y: 0, z: 0 }, definition.wood, definition); this.state.blueprints[index] = definition;
    this.changed('blueprint.updated', '설계도의 새 버전을 저장했습니다. 기존 작업은 고정한 버전을 유지합니다.', { commandId, data: { blueprintId: id, version: definition.version } }); this.applied(commandId, { blueprintId: id, version: definition.version });
    return clone(definition);
  }
  deleteBlueprint(id: string, commandId?: string): void {
    const index = this.state.blueprints.findIndex(b => b.id === id); if (index < 0) throw new Error('삭제할 사용자 설계도를 찾을 수 없습니다.');
    this.state.blueprints.splice(index, 1);
    this.changed('blueprint.deleted', '사용자 설계도를 삭제했습니다. 기존 작업은 고정한 버전을 유지합니다.', { commandId, data: { blueprintId: id } }); this.applied(commandId, { blueprintId: id });
  }
  private validateBlueprintInput(input: BlueprintInput, exceptId?: string): BlueprintInput {
    const parsed = BlueprintInputSchema.parse(input), normalize = (title: string) => title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
    if (this.state.blueprints.some(b => b.id !== exceptId && normalize(b.title) === normalize(parsed.title))) throw new Error('같은 이름의 설계도가 이미 있습니다. 다른 이름을 정해 주세요.');
    return parsed;
  }
  private pinBlueprint(input: GoalDefinition, previous?: GoalDefinition): void {
    if (input.kind !== 'build') return;
    const design = String(input.params.design ?? input.params.blueprint ?? 'cabin');
    if (Object.hasOwn(BLUEPRINTS, design)) { delete input.params.blueprintDefinition; return; }
    const catalog = this.state.blueprints.find(b => b.id === design);
    const existing = previous && String(previous.params.design ?? previous.params.blueprint ?? 'cabin') === design ? BlueprintDefinitionSchema.safeParse(previous.params.blueprintDefinition) : undefined;
    const definition = catalog ?? (existing?.success ? existing.data : undefined);
    if (!definition || definition.id !== design) throw new Error('선택한 사용자 설계도가 없거나 삭제되었습니다.');
    input.params.blueprintDefinition = jsonObject(clone(definition));
    delete input.params.requiredBlocks;
    if (!input.params.siteSelection && !input.params.origin && !input.params.position) input.params.siteSelection = 'nearby';
  }
  dispose(): void {
    this.disposed = true;
    for (const decision of this.decisions.values()) decision.abort.abort();
    this.decisions.clear();
    for (const agent of this.state.agents) this.cancelAgentAttempt(agent, '중앙 종료: 진행 상태 보존', true);
  }

  private agent(id: string): Agent { const agent = this.state.agents.find(a => a.id === id); if (!agent || agent.status === 'removed') throw new Error(`Unknown bot: ${id}`); return agent; }
  private goal(id: string): Goal { const goal = this.state.goals.find(g => g.id === id); if (!goal) throw new Error(`Unknown goal: ${id}`); return goal; }
  private changed(type: string, message: string, metadata: Partial<CoreEvent> = {}, record = true): void {
    this.state.revision++;
    this.state.updatedAt = this.now();
    const event: CoreEvent = { id: randomUUID(), time: this.now(), revision: this.state.revision, type, message, ...metadata };
    if (record) {
      const oldest = this.now() - this.state.rules.logRetentionDays * 86400000;
      this.state.events = [...this.state.events.filter(e => e.time >= oldest).slice(-4999), event];
    }
    this.options.onChange?.(this.getSnapshot(), event);
  }
  private applied(commandId?: string, data?: JsonObject): void {
    if (!commandId) return;
    this.state.pendingCommands = this.state.pendingCommands.filter(c => c.commandId !== commandId);
    this.changed('command.applied', '변경이 실제 적용되었습니다.', { commandId, data });
  }
  private pending(commandId: string | undefined, type: FleetCheckpoint['pendingCommands'][number]['type'], targetId: string, expected?: JsonObject): void {
    if (commandId) this.state.pendingCommands.push({ commandId, type, targetId, ...(expected ? { expected } : {}) });
  }
  private expectedApplied(expected: JsonObject | undefined, actual: unknown): boolean {
    if (!expected) return true;
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([key, value]) => value && typeof value === 'object' && !Array.isArray(value) ? this.expectedApplied(value, (actual as Record<string, unknown>)[key]) : JSON.stringify((actual as Record<string, unknown>)[key]) === JSON.stringify(value));
  }
  private failed(commandId: string, reason: string): void { this.state.pendingCommands = this.state.pendingCommands.filter(c => c.commandId !== commandId); this.changed('command.failed', reason, { commandId }); }
  private finishCommands(targetId: string, types: FleetCheckpoint['pendingCommands'][number]['type'][]): void {
    for (const command of [...this.state.pendingCommands]) if (command.targetId === targetId && types.includes(command.type)) {
      if (['agent-update', 'pause', 'resume'].includes(command.type) && !this.expectedApplied(command.expected, this.state.agents.find(a => a.id === targetId)?.config)) this.failed(command.commandId, '후속 설정 요청으로 이 변경이 대체되었습니다.');
      else this.applied(command.commandId, { targetId });
    }
  }
  private send(agent: Agent, type: CentralMessage['type'], payload: unknown, extra: Partial<CentralMessage> = {}): void {
    if (!agent.session || agent.session.state === 'stopped') return;
    const message = { protocolVersion: PROTOCOL_VERSION, messageId: randomUUID(), controllerEpoch: this.controllerEpoch, botId: agent.id, sessionId: agent.session.id, sentAt: this.now(), type, payload, ...extra } as CentralMessage;
    try { this.options.send(agent.id, clone(message)); }
    catch (error) {
      agent.session.state = 'abnormal';
      agent.status = agent.status === 'removing' ? 'removing' : 'abnormal';
      this.changed('bot.send-failed', error instanceof Error ? error.message : String(error), { botId: agent.id });
    }
  }

  addAgent(input: BotInput, commandId?: string): Agent {
    const { id = randomUUID(), ...config } = BotInputSchema.parse(input);
    if (this.state.agents.some(a => a.id === id || (a.status !== 'removed' && a.config.name === config.name))) throw new Error('Bot ID or Minecraft name is already registered');
    const agent: Agent = { id, config, pendingCommandIds: [], status: config.enabled ? 'registered' : 'paused', viewer: { state: 'stopped' }, createdAt: this.now(), updatedAt: this.now() };
    this.state.agents.push(agent);
    this.changed('bot.registered', `${config.name} 봇을 등록했습니다.`, { botId: id, commandId });
    this.applied(commandId, { botId: id });
    return clone(agent);
  }
  startSession(botId: string, sessionId: string): Agent {
    const agent = this.agent(botId);
    if (agent.session?.id === sessionId && agent.session.state !== 'stopped') return clone(agent);
    if (agent.session?.activeAttemptId) {
      const attempt = this.state.attempts.find(a => a.id === agent.session!.activeAttemptId);
      if (attempt && activeAttempts.has(attempt.state)) {
        attempt.state = 'uncertain';
        const task = this.state.tasks.find(t => t.id === attempt.taskId)!;
        task.state = 'held'; task.reason = '이전 세션의 실행 종료와 결과 확인이 필요합니다.'; task.checkpoint.reconcile = true;
      }
    }
    if (agent.recovery) { agent.recovery.safe = false; agent.recovery.reason = '새 실행 세션에서 복구 상태 확인을 기다립니다.'; }
    agent.session = { id: sessionId, state: 'starting', lastReportAt: this.now(), rulesVersion: 0 };
    agent.status = agent.status === 'removing' ? 'removing' : agent.config.enabled ? 'connecting' : 'paused';
    agent.updatedAt = this.now();
    this.changed('bot.session-started', '새 실행 세션을 시작했습니다.', { botId });
    return clone(agent);
  }
  confirmWorkerStopped(botId: string, sessionId: string): void {
    const agent = this.state.agents.find(a => a.id === botId);
    if (!agent) return;
    if (!this.state.stoppedSessionIds.includes(sessionId)) this.state.stoppedSessionIds.push(sessionId);
    for (const attempt of this.state.attempts.filter(a => a.botId === botId && a.sessionId === sessionId && (activeAttempts.has(a.state) || a.state === 'uncertain'))) {
      attempt.state = 'uncertain'; attempt.finishedAt = this.now();
      const task = this.state.tasks.find(t => t.id === attempt.taskId);
      if (task && task.state !== 'completed' && task.state !== 'cancelled') { task.state = 'held'; task.checkpoint.reconcile = true; task.reason = '프로세스 종료 확인: 월드 재관측 후 남은 작업을 재계획합니다.'; }
    }
    if (agent.session?.id === sessionId) {
      agent.session.state = 'stopped'; agent.session.activeAttemptId = undefined;
      agent.status = agent.status === 'removing' ? 'removed' : agent.config.enabled ? 'registered' : 'paused';
      agent.viewer = { state: 'stopped' };
      if (agent.status === 'removed') this.finishCommands(botId, ['remove']);
    }
    for (const command of [...this.state.pendingRuleCommands]) {
      command.awaitingBotIds = command.awaitingBotIds.filter(id => id !== botId);
      if (!command.awaitingBotIds.length) { this.state.pendingRuleCommands = this.state.pendingRuleCommands.filter(c => c !== command); if (this.expectedApplied(command.expected, this.state.rules)) this.applied(command.commandId, { version: this.state.rules.version }); else this.failed(command.commandId, '후속 규칙 요청으로 이 변경이 대체되었습니다.'); }
    }
    this.changed('bot.process-stopped', '실제 봇 프로세스 종료를 확인했습니다.', { botId, data: { sessionId } });
    this.tick();
  }
  updateAgent(botId: string, patch: BotPatch, mode: ExecutionMode = 'queued', commandId?: string): Agent {
    const agent = this.agent(botId), parsed = BotPatchSchema.parse(patch);
    const previous = agent.desiredConfig ?? agent.config;
    const desired = BotInputSchema.omit({ id: true }).parse({ ...previous, ...parsed, connection: parsed.connection ? { ...previous.connection, ...parsed.connection } : previous.connection });
    if (desired.name !== agent.config.name || JSON.stringify(desired.connection) !== JSON.stringify(agent.config.connection)) {
      if (agent.session && agent.session.state !== 'stopped') throw new Error('Name and connection changes require a stopped bot');
    }
    if (this.state.agents.some(a => a.id !== botId && a.status !== 'removed' && a.config.name === desired.name)) throw new Error('Minecraft name is already registered');
    agent.desiredConfig = desired;
    if (agent.session && agent.session.state !== 'stopped') this.state.rules = { ...this.state.rules, version: this.state.rules.version + 1 };
    agent.updatedAt = this.now();
    this.pending(commandId, 'agent-update', botId, jsonObject(parsed));
    if (mode === 'immediate' || !desired.enabled) this.cancelAgentAttempt(agent, '봇 설정 변경', true);
    this.changed('bot.config-requested', '봇 설정 변경을 예약했습니다.', { botId, commandId });
    this.applyAgentRules(agent, mode);
    return clone(agent);
  }
  pauseAgent(botId: string, commandId?: string): Agent { this.agent(botId); this.pending(commandId, 'pause', botId, { enabled: false }); return this.updateAgent(botId, { enabled: false }, 'immediate'); }
  resumeAgent(botId: string, commandId?: string): Agent { this.agent(botId); this.pending(commandId, 'resume', botId, { enabled: true }); return this.updateAgent(botId, { enabled: true }, 'queued'); }
  removeAgent(botId: string, commandId?: string): Agent {
    const agent = this.agent(botId);
    agent.status = 'removing';
    agent.desiredConfig = { ...(agent.desiredConfig ?? agent.config), enabled: false };
    this.pending(commandId, 'remove', botId);
    this.changed('bot.remove-requested', '작업 중단과 연결 종료를 요청했습니다.', { botId, commandId });
    if (!agent.session || agent.session.state === 'stopped') { agent.status = 'removed'; this.finishCommands(botId, ['remove']); }
    else if (!this.cancelAgentAttempt(agent, '봇 제거', true)) this.send(agent, 'bot.shutdown', { reason: '봇 제거' });
    return clone(agent);
  }
  updateRules(patch: RulesPatch, mode: ExecutionMode = 'queued', commandId?: string): Rules {
    const parsed = RulesPatchSchema.parse(patch), rules = RulesSchema.parse({ ...this.state.rules, ...parsed, combat: parsed.combat ? { ...this.state.rules.combat, ...parsed.combat } : this.state.rules.combat, version: this.state.rules.version + 1 });
    if (rules.statusTimeoutMs <= rules.statusIntervalMs) throw new Error('Status timeout must exceed report interval');
    this.state.rules = rules;
    const awaiting = this.state.agents.filter(a => a.session && a.session.state !== 'stopped' && a.status !== 'removed').map(a => a.id);
    if (commandId && awaiting.length) this.state.pendingRuleCommands.push({ commandId, version: rules.version, awaitingBotIds: awaiting, expected: jsonObject(parsed) });
    this.changed('rules.updated', '새 마을 규칙을 저장하고 적용을 요청했습니다.', { commandId, data: { version: rules.version } });
    for (const agent of this.state.agents.filter(a => a.status !== 'removed')) {
      const attempt = this.state.attempts.find(a => a.id === agent.session?.activeAttemptId), task = this.state.tasks.find(t => t.id === attempt?.taskId), goal = task ? this.goal(task.goalId) : undefined;
      const outside = goal?.input.source === 'autonomous' && task?.completion.kind === 'blocks' && (!rules.center || !footprintInside(rules.center, rules.radius, task.completion.blocks));
      if (mode === 'immediate' || outside) this.cancelAgentAttempt(agent, outside ? '마을 범위 변경으로 건축을 재계획합니다.' : '규칙 즉시 변경', true);
      this.applyAgentRules(agent, mode);
    }
    if (!awaiting.length) this.applied(commandId, { version: rules.version });
    return clone(rules);
  }
  private applyAgentRules(agent: Agent, mode: ExecutionMode = 'queued'): void {
    if (agent.status === 'removed' || agent.status === 'removing' || agent.session?.activeAttemptId) return;
    if (!agent.session || agent.session.state === 'stopped') {
      if (agent.desiredConfig) { agent.config = agent.desiredConfig; agent.desiredConfig = undefined; }
      agent.status = agent.config.enabled ? 'registered' : 'paused';
      this.finishCommands(agent.id, ['agent-update', 'pause', 'resume']);
      return;
    }
    if (agent.session.state !== 'ready') return;
    if (agent.session.pendingRulesVersion === this.state.rules.version) return;
    if (agent.session.rulesVersion === this.state.rules.version && !agent.desiredConfig) return;
    agent.session.pendingRulesVersion = this.state.rules.version;
    this.send(agent, 'rules.update', { rules: this.state.rules, config: agent.desiredConfig ?? agent.config, mode });
  }

  createGoal(input: GoalInput, commandId?: string): Goal {
    const definition = GoalInputSchema.parse(input);
    this.pinBlueprint(definition);
    if (['guard', 'follow', 'survive'].includes(definition.kind)) definition.mode = 'maintain';
    if (!definition.destination && this.state.rules.warehouse && (['collect', 'store', 'take'].includes(definition.kind) || (definition.kind === 'hunt' && definition.item) || (definition.kind === 'farm' && definition.params.mode === 'harvest'))) definition.destination = clone(this.state.rules.warehouse);
    if (definition.preferredBotId) this.agent(definition.preferredBotId);
    const goal: Goal = { id: randomUUID(), input: definition, title: goalTitle(definition), state: 'queued', taskIds: [], createdAt: this.now(), updatedAt: this.now(), progress: { current: 0, target: definition.quantity }, generation: 0 };
    if (definition.quantityMode === 'total') goal.targetQuantity = definition.quantity;
    this.state.goals.push(goal);
    if (definition.executionMode === 'immediate' && definition.preferredBotId) {
      const agent = this.agent(definition.preferredBotId), old = this.state.tasks.find(t => t.attemptId === agent.session?.activeAttemptId);
      if (old) old.blockedByGoalId = goal.id;
      this.cancelAgentAttempt(agent, '새 목표로 즉시 전환', true);
    }
    this.changed('goal.created', '목표를 등록했습니다.', { goalId: goal.id, commandId });
    this.applied(commandId, { goalId: goal.id });
    this.tick();
    return clone(goal);
  }
  updateGoal(goalId: string, patch: GoalPatch, commandId?: string): Goal {
    const goal = this.goal(goalId), parsed = GoalPatchSchema.parse(patch);
    if (terminalGoals.has(goal.state)) throw new Error('A finished goal cannot be edited');
    if (parsed.preferredBotId) this.agent(parsed.preferredBotId);
    const updated = GoalInputSchema.parse({ ...goal.input, ...parsed, preferredBotId: parsed.preferredBotId === null ? undefined : parsed.preferredBotId ?? goal.input.preferredBotId });
    if (parsed.params !== undefined) this.pinBlueprint(updated, goal.input);
    goal.input = updated;
    goal.replanRequested = true;
    goal.title = goalTitle(goal.input);
    if (parsed.quantity !== undefined) goal.targetQuantity = goal.input.quantityMode === 'total' ? parsed.quantity : undefined;
    this.pending(commandId, 'goal-update', goalId);
    for (const task of this.currentTasks(goal)) {
      if (this.taskHasActor(task)) this.cancelTask(task, '목표 수정 후 재계획', false);
      else { task.state = 'cancelled'; this.release(task.attemptId); }
    }
    goal.reason = '목표 변경 후 실행 결과를 확인하고 재계획합니다.';
    goal.updatedAt = this.now();
    this.changed('goal.updated', goal.reason, { goalId, commandId });
    this.tick();
    return clone(goal);
  }
  cancelGoal(goalId: string, commandId?: string): Goal {
    const goal = this.goal(goalId);
    if (goal.state === 'cancelled') { this.applied(commandId, { goalId }); return clone(goal); }
    goal.state = 'cancelling'; goal.updatedAt = this.now();
    this.pending(commandId, 'goal-cancel', goalId);
    for (const task of this.currentTasks(goal)) {
      if (this.taskHasActor(task)) this.cancelTask(task, '목표 취소', false);
      else { task.state = 'cancelled'; this.release(task.attemptId); }
    }
    this.changed('goal.cancel-requested', '목표의 실제 작업 중단을 요청했습니다.', { goalId, commandId });
    this.finishGoalCancellation(goal);
    return clone(goal);
  }
  requestViewer(botId: string, enabled: boolean, port = 4100, commandId?: string): Agent {
    const agent = this.agent(botId);
    if (!agent.session || agent.session.state !== 'ready') throw new Error('Viewer requires a connected bot');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid viewer port');
    for (const previous of [...this.state.pendingCommands]) if (previous.targetId === botId && (previous.type === 'viewer-start' || previous.type === 'viewer-stop')) this.failed(previous.commandId, '후속 화면 요청으로 이 변경이 대체되었습니다.');
    this.pending(commandId, enabled ? 'viewer-start' : 'viewer-stop', botId);
    agent.viewer = enabled ? { state: 'starting', port, prefix: `/viewer/${encodeURIComponent(botId)}` } : { ...agent.viewer, state: 'stopping' };
    this.send(agent, enabled ? 'viewer.start' : 'viewer.stop', enabled ? { port, prefix: agent.viewer.prefix } : {});
    this.changed('viewer.requested', enabled ? '봇 3D 화면 연결을 요청했습니다.' : '봇 3D 화면 종료를 요청했습니다.', { botId, commandId });
    return clone(agent);
  }

  onWorkerMessage(value: unknown): boolean {
    const parsed = WorkerMessageSchema.safeParse(value);
    if (!parsed.success) { this.changed('message.invalid', '유효하지 않은 워커 메시지를 거절했습니다.'); return false; }
    const message = parsed.data;
    if (message.controllerEpoch !== this.controllerEpoch || this.messageIds.has(message.messageId)) return false;
    const agent = this.state.agents.find(a => a.id === message.botId);
    if (!agent?.session || agent.session.id !== message.sessionId || agent.session.state === 'stopped' || agent.status === 'removed') return false;
    if ('attemptId' in message) {
      const attempt = this.state.attempts.find(a => a.id === message.attemptId), task = this.state.tasks.find(t => t.id === message.taskId);
      const recoveringStop = attempt?.state === 'uncertain' && !attempt.finishedAt && agent.session.activeAttemptId === attempt.id && ['task.cancelled', 'task.interrupted', 'task.result'].includes(message.type);
      if (!attempt || !task || task.attemptId !== attempt.id || attempt.botId !== agent.id || attempt.sessionId !== message.sessionId || attempt.controllerEpoch !== this.controllerEpoch || (!activeAttempts.has(attempt.state) && !recoveringStop)) return false;
    }
    this.messageIds.add(message.messageId);
    this.state.processedMessageIds.push(message.messageId);
    if (this.state.processedMessageIds.length > 10000) this.messageIds.delete(this.state.processedMessageIds.shift()!);
    this.handleMessage(agent, message);
    this.tick();
    return true;
  }
  receive(value: unknown): boolean { return this.onWorkerMessage(value); }
  private observe(agent: Agent, observations: readonly ObservationInput[], attemptId?: string): void {
    for (const input of observations) {
      if (input.world !== agent.session?.report?.world || input.dimension !== agent.session?.report?.dimension || input.observedAt > this.now() + 1000) continue;
      if (input.kind === 'container' && (input.data.container.world !== input.world || input.data.container.dimension !== input.dimension)) continue;
      if (this.state.observations.some(o => o.id === input.id && o.sessionId === agent.session?.id)) continue;
      if (input.kind === 'inventory' && agent.session?.report && !this.state.observations.some(o => o.kind === 'inventory' && o.botId === agent.id && o.sessionId === agent.session?.id && o.observedAt > input.observedAt)) agent.session.report.inventory = clone(input.data.items);
      if (input.kind === 'position' && agent.session?.report && !this.state.observations.some(o => o.kind === 'position' && o.botId === agent.id && o.sessionId === agent.session?.id && o.observedAt > input.observedAt)) agent.session.report.position = clone(input.data.position);
      this.state.observations.push({ ...clone(input), botId: agent.id, sessionId: agent.session!.id, controllerEpoch: this.controllerEpoch, receivedAt: this.now(), ...(attemptId ? { attemptId } : {}) });
    }
    this.state.observations = this.state.observations.filter(o => this.now() - o.receivedAt <= Math.max(300000, this.state.rules.observationMaxAgeMs)).slice(-5000);
  }
  private recordDeath(agent: Agent, death: DeathRecord): void {
    if (death.occurredAt > this.now() + 1000 || agent.deaths?.some(d => d.deathId === death.deathId)) return;
    // Old deaths may be replayed after IPC restoration, but cannot supersede a later death.
    if (agent.recovery && death.occurredAt < agent.recovery.occurredAt) return;
    agent.deaths = [...(agent.deaths ?? []), clone(death)].slice(-20);
    agent.recovery = { ...clone(death), phase: 'waiting-respawn', reason: '사망을 확인했습니다. 재생성과 안전한 물품 복구를 기다립니다.', attemptCount: 0, progress: { recoveredCount: 0, remainingCount: death.priorInventory.reduce((n, item) => n + item.count, 0) }, safe: false, updatedAt: death.occurredAt, checkpoint: {} };
    if (agent.session?.report) { agent.session.report.ready = false; agent.session.report.health = 0; agent.session.report.mode = 'recovering'; }
    this.cancelAgentAttempt(agent, '사망 후 실제 실행 중단과 복구를 확인합니다.', true);
    this.changed('bot.died', '봇이 사망했습니다. 마지막 위치와 소지품을 기록하고 복구를 시작합니다.', { botId: agent.id, data: jsonObject(death) });
  }
  private recordRecovery(agent: Agent, recovery: RecoveryState): void {
    if (recovery.updatedAt > this.now() + 1000 || recovery.occurredAt > this.now() + 1000) return;
    const prior = agent.recovery;
    if (!prior || prior.deathId !== recovery.deathId) {
      if (prior && recovery.occurredAt <= prior.occurredAt) return;
      this.recordDeath(agent, DeathRecordSchema.parse({ deathId: recovery.deathId, occurredAt: recovery.occurredAt, world: recovery.world, dimension: recovery.dimension, position: recovery.position, priorInventory: recovery.priorInventory }));
    }
    const current = agent.recovery;
    if (!current || current.deathId !== recovery.deathId || recovery.updatedAt < current.updatedAt || recovery.attemptCount < current.attemptCount) return;
    if (current.world !== recovery.world || current.dimension !== recovery.dimension || JSON.stringify(current.position) !== JSON.stringify(recovery.position) || JSON.stringify(current.priorInventory) !== JSON.stringify(recovery.priorInventory)) return;
    if (current.phase === 'resolved' && current.safe && (recovery.phase !== 'resolved' || !recovery.safe)) return;
    // The worker must report a live, ready body in this session before it can release recovery.
    const report = agent.session?.report;
    const confirmed = recovery.safe && report?.ready && report.health > 0;
    const next = { ...clone(recovery), safe: !!confirmed };
    const significant = (value: RecoveryState) => JSON.stringify({ ...value, updatedAt: 0 });
    agent.recovery = next; agent.updatedAt = this.now();
    if (report) report.recovery = clone(next);
    if (significant(current) !== significant(next)) this.changed('bot.recovery', next.reason, { botId: agent.id, data: jsonObject(next) });
  }
  private supportEligible(agent: Agent, requester: Agent, position: Position): boolean {
    const session = agent.session, report = session?.report;
    const config = agent.desiredConfig ?? agent.config;
    // A busy helper can have queued rules. Select it for a safe stop first;
    // candidateTasks still requires the latest rules acknowledgement to assign.
    return agent.id !== requester.id && agent.config.enabled && config.enabled && !['removed', 'removing', 'paused'].includes(agent.status) && session?.state === 'ready' && !!report?.ready && this.now() - session.lastReportAt < this.state.rules.statusTimeoutMs && !['emergency', 'survival', 'recovering', 'paused', 'stopping'].includes(report.mode) && report.health > this.state.rules.combat.supportHealth && report.food > 6 && report.world === requester.session?.report?.world && report.dimension === requester.session?.report?.dimension && config.allowedActions.includes('fight') && report.capabilities.includes('fight') && !!report.position && distance(report.position, position) <= 32 && (!agent.recovery || agent.recovery.phase === 'resolved' && agent.recovery.safe) && !this.state.tasks.some(t => t.attemptId === session.activeAttemptId && typeof t.params.supportRequestId === 'string');
  }
  private supportUnavailable(agent: Agent, key: string, reason: string): void {
    if (this.state.events.some(e => e.type === 'support.unavailable' && e.botId === agent.id && e.data?.key === key && this.now() - e.time < 15000)) return;
    this.changed('support.unavailable', reason, { botId: agent.id, data: { key } });
  }
  private requestSupport(requester: Agent, threats: JsonObject[], sentAt: number): void {
    if (sentAt > this.now() + 1000 || this.now() - sentAt >= this.state.rules.statusTimeoutMs || !requester.session || this.now() - requester.session.lastReportAt >= this.state.rules.statusTimeoutMs) { this.supportUnavailable(requester, 'stale-threat', '현재 세션의 최신 위협 관측이 필요합니다.'); return; }
    const active = this.state.tasks.find(t => t.attemptId === requester.session?.activeAttemptId);
    if (typeof active?.params.supportRequestId === 'string') { this.supportUnavailable(requester, 'nested-support', '지원 중인 봇의 추가 지원 요청은 중첩 배정하지 않습니다.'); return; }
    const hostileNames = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'creeper', 'endermite', 'silverfish', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom', 'slime', 'magma_cube', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'guardian', 'elder_guardian', 'wither', 'warden']);
    const threat = threats.find(t => typeof t.entityId === 'string' && hostileNames.has(String(t.name)) && PositionSchema.safeParse(t.position ?? { x: t.x, y: t.y, z: t.z }).success);
    if (!threat || !requester.session?.report) { this.supportUnavailable(requester, 'unknown-threat', '확인된 적의 ID와 위치가 없어 지원 공격을 배정할 수 없습니다.'); return; }
    const position = PositionSchema.parse(threat.position ?? { x: threat.x, y: threat.y, z: threat.z }), report = requester.session.report;
    if (!report.position || distance(report.position, position) > 32 || report.world !== this.state.rules.world || report.dimension !== this.state.rules.dimension) { this.supportUnavailable(requester, 'unverified-threat', '요청한 봇 주변의 같은 월드에서 확인한 위협이 필요합니다.'); return; }
    const key = `${requester.id}:${requester.session.id}:${report.world}:${report.dimension}:${String(threat.entityId)}`;
    const previous = this.state.goals.find(g => g.input.params.supportKey === key && this.now() - g.createdAt < 60000);
    if (previous) {
      if (!terminalGoals.has(previous.state) && previous.state !== 'held') { previous.input.params.expiresAt = Math.min(previous.createdAt + 60000, this.now() + 15000); previous.input.params.position = jsonObject(position); }
      return;
    }
    const helpers = this.state.agents.filter(a => this.supportEligible(a, requester, position)).sort((a, b) => Number(!!a.session?.activeAttemptId) - Number(!!b.session?.activeAttemptId) || Number(['guard', 'hunter'].includes(b.config.role)) - Number(['guard', 'hunter'].includes(a.config.role)) || distance(a.session!.report!.position!, position) - distance(b.session!.report!.position!, position));
    const helper = helpers[0];
    if (!helper) { this.supportUnavailable(requester, key, '지금 지원 가능한 봇이 없습니다. 요청한 봇은 반격·퇴각과 기본 생존을 유지합니다.'); return; }
    if (this.state.goals.filter(g => typeof g.input.params.supportRequestId === 'string' && !terminalGoals.has(g.state)).length >= 50) { this.supportUnavailable(requester, key, '동시 지원 요청 한도에 도달했습니다.'); return; }
    const id = randomUUID(), input = GoalInputSchema.parse({ kind: 'fight', quantity: 1, source: 'user', priority: 100, executionMode: 'immediate', preferredBotId: helper.id, title: `${requester.config.name} 지원`, params: { supportRequestId: id, supportKey: key, supportHelperId: helper.id, requesterBotId: requester.id, requesterSessionId: requester.session.id, targetEntityId: String(threat.entityId), targetName: String(threat.name), position: jsonObject(position), world: report.world, dimension: report.dimension, expiresAt: this.now() + 15000 } });
    const goal: Goal = { id, input, title: input.title!, state: 'queued', taskIds: [], createdAt: this.now(), updatedAt: this.now(), progress: { current: 0, target: 1 }, generation: 0 };
    this.state.goals.push(goal);
    this.changed('support.requested', `${helper.config.name} 봇에 확인된 위협의 지원 작업을 요청했습니다.`, { botId: requester.id, goalId: id, data: { helperBotId: helper.id, targetEntityId: String(threat.entityId) } });
  }
  private yieldSupport(): void {
    for (const goal of this.state.goals.filter(g => typeof g.input.params.supportRequestId === 'string' && !terminalGoals.has(g.state) && !['held', 'cancelling'].includes(g.state))) {
      const helper = this.state.agents.find(a => a.id === goal.input.params.supportHelperId), requester = this.state.agents.find(a => a.id === goal.input.params.requesterBotId), position = PositionSchema.safeParse(goal.input.params.position);
      if (!helper || !requester || !position.success || !this.supportEligible(helper, requester, position.data)) continue;
      const active = this.state.tasks.find(t => t.attemptId === helper.session?.activeAttemptId);
      if (!active || active.state === 'cancelling' || active.goalId === goal.id) continue;
      active.blockedByGoalId = goal.id;
      this.cancelTask(active, '확인된 동료 위협에 지원하고 현재 작업의 진행 상태를 보존합니다.', true);
      this.changed('support.work-preserved', '기존 작업을 안전하게 중단한 뒤 지원 작업을 수행합니다.', { botId: helper.id, taskId: active.id, goalId: goal.id });
    }
  }
  private expireSupport(): void {
    for (const goal of this.state.goals.filter(g => typeof g.input.params.supportRequestId === 'string' && !terminalGoals.has(g.state) && g.state !== 'cancelling')) {
      const requester = this.state.agents.find(a => a.id === goal.input.params.requesterBotId), helper = this.state.agents.find(a => a.id === goal.input.params.supportHelperId);
      const actualDeath = this.state.observations.some(o => o.kind === 'entity-death' && o.controllerEpoch === this.controllerEpoch && o.observedAt >= goal.createdAt && this.now() - o.observedAt <= this.state.rules.observationMaxAgeMs && o.world === goal.input.params.world && o.dimension === goal.input.params.dimension && o.data.entityId === goal.input.params.targetEntityId && o.data.entityName === goal.input.params.targetName && (o.botId === requester?.id && o.sessionId === requester.session?.id || o.botId === helper?.id && o.sessionId === helper.session?.id));
      if (actualDeath) {
        goal.state = 'completed'; goal.progress.current = 1; goal.updatedAt = this.now(); goal.reason = '확인한 위협의 실제 사망을 관측했습니다.';
        for (const task of this.currentTasks(goal)) if (this.taskHasActor(task)) this.cancelTask(task, '지원 대상의 실제 사망을 확인해 공격을 중단합니다.', true); else if (task.state !== 'completed') { task.state = 'completed'; this.release(task.attemptId); }
        this.changed('support.resolved', goal.reason, { goalId: goal.id, botId: requester?.id, data: { targetEntityId: String(goal.input.params.targetEntityId) } });
        continue;
      }
      const reason = !requester?.session || requester.session.id !== goal.input.params.requesterSessionId || requester.recovery && !(requester.recovery.phase === 'resolved' && requester.recovery.safe) ? '요청한 봇의 세션이나 생존 상태가 바뀌어 지원 대상을 다시 확인해야 합니다.' : !helper || helper.status === 'removed' || helper.status === 'removing' || !helper.config.enabled || !helper.config.allowedActions.includes('fight') ? '허용된 지원 봇을 사용할 수 없습니다.' : this.now() >= Number(goal.input.params.expiresAt) || this.now() - goal.createdAt >= 60000 ? '위협 관측의 유효 시간이 지나 지원 작업을 안전하게 종료합니다.' : undefined;
      if (!reason) continue;
      goal.state = 'cancelling'; goal.reason = reason;
      for (const task of this.currentTasks(goal)) if (this.taskHasActor(task)) this.cancelTask(task, reason, true); else if (task.state !== 'completed') { task.state = 'cancelled'; this.release(task.attemptId); }
      this.finishGoalCancellation(goal);
      this.changed('support.expired', reason, { goalId: goal.id, botId: requester?.id });
    }
  }
  private handleMessage(agent: Agent, message: WorkerMessage): void {
    const session = agent.session!;
    switch (message.type) {
      case 'bot.ready': case 'bot.status': {
        session.lastReportAt = this.now(); session.report = clone(message.payload);
        if (message.payload.recovery) this.recordRecovery(agent, message.payload.recovery);
        if (message.payload.ready) session.state = 'ready';
        if (agent.status !== 'removing') agent.status = (agent.desiredConfig ?? agent.config).enabled ? message.payload.ready ? 'ready' : 'connecting' : 'paused';
        this.observe(agent, [{ id: `inventory:${message.messageId}`, observedAt: message.sentAt, world: message.payload.world, dimension: message.payload.dimension, kind: 'inventory', data: { items: message.payload.inventory } }]);
        if (agent.status === 'removing' && !session.activeAttemptId) this.send(agent, 'bot.shutdown', { reason: '봇 제거' });
        else this.applyAgentRules(agent);
        this.changed(message.type, message.payload.reason, { botId: agent.id }, message.type === 'bot.ready');
        return;
      }
      case 'rules.applied': {
        if (message.payload.version !== session.pendingRulesVersion || message.payload.version !== this.state.rules.version) return;
        session.rulesVersion = message.payload.version; session.pendingRulesVersion = undefined;
        if (agent.desiredConfig) { agent.config = agent.desiredConfig; agent.desiredConfig = undefined; }
        if (agent.status !== 'removing') agent.status = agent.config.enabled ? 'ready' : 'paused';
        this.finishCommands(agent.id, ['agent-update', 'pause', 'resume']);
        for (const command of [...this.state.pendingRuleCommands]) if (command.version <= session.rulesVersion) {
          command.awaitingBotIds = command.awaitingBotIds.filter(id => id !== agent.id);
          if (!command.awaitingBotIds.length) { this.state.pendingRuleCommands = this.state.pendingRuleCommands.filter(c => c !== command); if (this.expectedApplied(command.expected, this.state.rules)) this.applied(command.commandId, { version: session.rulesVersion }); else this.failed(command.commandId, '후속 규칙 요청으로 이 변경이 대체되었습니다.'); }
        }
        this.changed('rules.applied', '봇이 규칙을 실제 적용했습니다.', { botId: agent.id, data: { version: session.rulesVersion } });
        return;
      }
      case 'world.observed': this.observe(agent, message.payload.observations); this.changed('world.observed', '실제 월드 관측을 반영했습니다.', { botId: agent.id }, false); return;
      case 'viewer.ready':
        if (agent.viewer.state !== 'starting' || agent.viewer.port !== message.payload.port || agent.viewer.prefix !== message.payload.prefix) return;
        agent.viewer = { state: 'ready', ...message.payload }; this.finishCommands(agent.id, ['viewer-start']); this.changed('viewer.ready', '3D 화면 연결을 확인했습니다.', { botId: agent.id }); return;
      case 'viewer.stopped': agent.viewer = { state: 'stopped' }; this.finishCommands(agent.id, ['viewer-stop']); this.changed('viewer.stopped', '3D 화면 종료를 확인했습니다.', { botId: agent.id }); return;
      case 'bot.died': this.recordDeath(agent, message.payload); return;
      case 'bot.recovery': this.recordRecovery(agent, message.payload); return;
      case 'safety.alert':
        session.report && (session.report.mode = 'emergency'); this.changed('safety.alert', message.payload.reason, { botId: agent.id, data: jsonObject(message.payload) });
        if (message.payload.supportRequired) this.requestSupport(agent, message.payload.threats, message.sentAt); return;
      case 'bot.stopped': session.state = 'abnormal'; agent.status = agent.status === 'removing' ? 'removing' : 'abnormal'; this.changed('bot.connection-stopped', message.payload.reason, { botId: agent.id }); return;
      case 'bot.error':
        this.changed('bot.error', message.payload.message, { botId: agent.id, data: jsonObject(message.payload) });
        if (agent.viewer.state === 'starting') { agent.viewer.state = 'failed'; for (const command of this.state.pendingCommands.filter(c => c.targetId === agent.id && c.type === 'viewer-start')) this.changed('command.failed', message.payload.message, { commandId: command.commandId }); this.state.pendingCommands = this.state.pendingCommands.filter(c => c.targetId !== agent.id || c.type !== 'viewer-start'); }
        return;
    }
    if (!('attemptId' in message)) return;
    const task = this.state.tasks.find(t => t.id === message.taskId)!, attempt = this.state.attempts.find(a => a.id === message.attemptId)!;
    switch (message.type) {
      case 'task.accepted': if (attempt.state === 'assigned') { task.state = 'accepted'; attempt.state = 'accepted'; this.changed('task.accepted', '봇이 작업을 수락했습니다.', { taskId: task.id, attemptId: attempt.id, botId: agent.id }); } return;
      case 'task.started': if (attempt.state === 'assigned' || attempt.state === 'accepted') { task.state = 'running'; attempt.state = 'running'; attempt.startedAt = this.now(); this.changed('task.started', '실제 작업 실행을 시작했습니다.', { taskId: task.id, attemptId: attempt.id, botId: agent.id }); } return;
      case 'task.progress':
        if (attempt.state === 'cancelling') return;
        this.observe(agent, message.payload.observations, attempt.id); task.progress = message.payload.progress ?? task.progress; task.checkpoint = clone(message.payload.checkpoint); task.reason = message.payload.reason;
        this.changed('task.progress', task.reason, { taskId: task.id, botId: agent.id }, false); return;
      case 'task.rejected': this.finishResult(agent, task, attempt, { outcome: 'failed', observations: [], evidence: [], checkpoint: task.checkpoint, error: { code: 'TASK_REJECTED', message: message.payload.reason, retryable: message.payload.retryable, effectsKnown: true } }); return;
      case 'task.result': this.finishResult(agent, task, attempt, message.payload); return;
      case 'task.cancelled': case 'task.interrupted': {
        this.observe(agent, message.payload.observations, attempt.id);
        task.checkpoint = clone(message.payload.checkpoint);
        if (!message.payload.safeStopped) { task.state = 'held'; attempt.state = 'uncertain'; task.reason = '실제 중단 확인이 필요합니다.'; this.changed('task.held', task.reason, { taskId: task.id }); return; }
        const completion = this.verify(task, attempt, message.payload.evidence);
        attempt.finishedAt = this.now(); attempt.state = message.type === 'task.interrupted' ? 'interrupted' : 'cancelled';
        this.release(attempt.id); session.activeAttemptId = undefined;
        if (completion.complete) this.completeTask(task, attempt);
        else {
          this.reducePartialTransfer(task, attempt, message.payload.evidence);
          const goal = this.goal(task.goalId);
          task.state = goal.state === 'cancelling' || terminalGoals.has(goal.state) ? 'cancelled' : 'interrupted'; task.resumeCount++; task.reason = message.payload.reason ?? '안전하게 중단한 진행 상태를 보존했습니다.';
          if (message.type === 'task.interrupted' && session.report) session.report.mode = 'emergency';
          if (agent.status === 'removing' || !agent.config.allowedActions.includes(task.kind)) this.invalidatePlan(goal, '봇 변경 후 남은 작업을 재계획합니다.');
        }
        this.changed(message.type, task.reason ?? '작업 중단을 확인했습니다.', { taskId: task.id, attemptId: attempt.id, botId: agent.id });
        if (agent.status === 'removing') this.send(agent, 'bot.shutdown', { reason: '안전 중단 후 봇 제거' }); else this.applyAgentRules(agent);
        this.finishGoalCancellation(this.goal(task.goalId));
        return;
      }
    }
  }

  private verify(task: Task, attempt: TaskAttempt, evidence: ResultPayload['evidence'] = []) {
    // Visiting a site is a planning step, never proof that the building exists.
    if (isBuildStageTask(task) || isAccessPreparationTask(task)) return { complete: false, current: 0, target: 1, reason: '부지의 실제 지반·빈 공간·접근 관측이 필요합니다.' };
    const agent = this.state.agents.find(a => a.id === attempt.botId);
    return verifyCompletion(task.completion, { observations: this.state.observations, evidence, now: this.now(), maxAgeMs: this.state.rules.observationMaxAgeMs, world: agent?.session?.report?.world ?? this.state.rules.world, dimension: agent?.session?.report?.dimension ?? this.state.rules.dimension, botId: attempt.botId, sessionId: attempt.sessionId, attemptId: attempt.id, notBefore: attempt.assignedAt });
  }
  private finishResult(agent: Agent, task: Task, attempt: TaskAttempt, result: ResultPayload): void {
    this.observe(agent, result.observations, attempt.id);
    task.state = 'verifying'; task.checkpoint = clone(result.checkpoint); attempt.result = clone(result);
    const accessProof = isAccessPreparationTask(task) ? this.verifyAccessCompletion(task, attempt, result) : undefined;
    const siteProof = isBuildStageTask(task) ? this.verifyBuildSite(task, attempt) : undefined;
    const preparationProof = isBuildSiteTask(task) && result.checkpoint.buildSitePreparation !== undefined ? this.verifyPreparationProposal(task, attempt) : undefined;
    const verification = accessProof ? { complete: accessProof.ok && result.outcome === 'completed', current: 0, target: 1, reason: accessProof.reason } : siteProof ? { complete: (!!siteProof.site || !!preparationProof?.preparation) && result.outcome === 'completed', current: 0, target: 1, reason: preparationProof?.reason ?? siteProof.reason } : this.verify(task, attempt, result.evidence);
    attempt.finishedAt = this.now(); agent.session!.activeAttemptId = undefined;
    if (verification.complete) {
      this.release(attempt.id); this.completeTask(task, attempt); task.waitState = undefined;
      const goal = this.goal(task.goalId);
      if (!goal.replanRequested && goal.state !== 'cancelling' && !terminalGoals.has(goal.state) && !this.state.pendingCommands.some(c => c.type === 'goal-update' && c.targetId === goal.id)) {
        if (siteProof?.site) this.selectBuildSite(goal, task, attempt, siteProof.site);
        else if (preparationProof?.preparation) this.selectPreparationPlan(goal, task, attempt, preparationProof.preparation);
      }
    }
    else if (this.goal(task.goalId).state === 'cancelling') { task.state = 'cancelled'; attempt.state = 'cancelled'; this.release(attempt.id); }
    else if (result.outcome === 'uncertain' || (result.outcome === 'completed' && task.completion.kind !== 'continuous') || (result.outcome === 'failed' && !result.error?.effectsKnown)) {
      task.state = 'held'; attempt.state = 'uncertain'; task.reason = isBuildStageTask(task) && result.outcome === 'completed' ? verification.reason : result.reason ?? result.error?.message ?? verification.reason;
    } else if (result.outcome === 'failed') {
      attempt.state = 'failed'; this.release(attempt.id);
      if (result.error?.retryable && task.retryCount < this.state.rules.maxRetries) { task.retryCount++; task.state = 'retry-wait'; task.retryAt = this.now() + Math.min(30000, 1000 * 2 ** (task.retryCount - 1)); task.reason = result.error.message; }
      else { task.state = 'held'; task.reason = result.error?.message ?? '허용된 재시도 횟수를 모두 사용했습니다.'; }
    } else {
      attempt.state = 'interrupted'; this.release(attempt.id); this.reducePartialTransfer(task, attempt, result.evidence);
      task.state = 'condition-wait'; task.retryAt = this.now() + 5000; task.resumeCount++; task.reason = result.reason ?? verification.reason;
      const support = typeof task.params.supportRequestId === 'string';
      if (support) { if (task.retryCount >= this.state.rules.maxRetries) { task.state = 'held'; task.reason = '확인한 지원 조건으로 가능한 재시도를 모두 사용했습니다.'; } else { task.retryCount++; task.state = 'retry-wait'; } }
      const accessPlanned = !support && result.outcome === 'condition-wait' && task.kind === 'build' && !isPreparationTask(task) && task.checkpoint.buildAccessPreparation !== undefined && this.planAccessPreparation(task, attempt);
      const resourceWait = BuildWaitingForSchema.safeParse(task.checkpoint.waitingFor);
      if (!accessPlanned && !support && result.outcome === 'condition-wait' && (task.kind === 'build' || isBuildSiteTask(task) || resourceWait.success && resourceWait.data.kind === 'inventory')) this.recordBuildWait(task, attempt, verification.current);
    }
    task.updatedAt = this.now();
    this.changed(verification.complete ? 'task.completed' : `task.${task.state}`, task.reason ?? '실제 결과를 검증했습니다.', { taskId: task.id, attemptId: attempt.id, botId: agent.id });
    if (agent.status === 'removing') this.send(agent, 'bot.shutdown', { reason: '작업 종료 후 봇 제거' }); else this.applyAgentRules(agent);
    this.finishGoalCancellation(this.goal(task.goalId));
  }
  private expectedBuildEntrance(task: Task): Position | undefined {
    const origin = PositionSchema.safeParse(task.params.origin ?? this.goal(task.goalId).input.params.origin);
    if (!origin.success) return undefined;
    try { const size = resolveBlueprint(String(task.params.design ?? task.params.blueprint ?? 'cabin'), task.params.blueprintDefinition); return { x: origin.data.x + Math.floor(size.width / 2), y: origin.data.y, z: origin.data.z - 1 }; } catch { return undefined; }
  }
  private planAccessPreparation(parent: Task, attempt: TaskAttempt): boolean {
    const target = this.expectedBuildEntrance(parent), proposed = BuildAccessPreparationSchema.safeParse(parent.checkpoint.buildAccessPreparation), report = this.state.agents.find(a => a.id === attempt.botId)?.session?.report;
    if (!proposed.success || !target || !report?.position || proposed.data.observedAt < attempt.assignedAt || proposed.data.observedAt > this.now() + 1000 || this.now() - proposed.data.observedAt > this.state.rules.observationMaxAgeMs || distance(report.position, { ...proposed.data.start, x: proposed.data.start.x + 0.5, z: proposed.data.start.z + 0.5 }) > 1.5) return false;
    const previous = this.state.tasks.filter(t => t.params.parentTaskId === parent.id && isAccessPreparationTask(t));
    if (previous.some(t => !['completed', 'cancelled'].includes(t.state)) || previous.length >= this.state.rules.maxRetries) return false;
    const before = this.attemptBlocks(attempt), protectedPositions = parent.completion.kind === 'blocks' ? parent.completion.blocks.map(b => b.position) : [];
    const verified = validateBuildAccessPreparation(proposed.data, before, { expectedTarget: target, protectedPositions });
    if (!verified.ok) { parent.reason = verified.reason; this.changed('build.access-rejected', verified.reason, { taskId: parent.id, botId: attempt.botId }); return false; }
    const keys = verified.proofPositions.map(p => `block:${this.state.rules.world}:${this.state.rules.dimension}:${positionKey(p)}`), keySet = new Set(keys);
    if (this.state.reservations.some(r => r.attemptId !== attempt.id && keySet.has(r.key)) || this.state.tasks.some(t => t.id !== parent.id && t.goalId !== parent.goalId && !['completed', 'cancelled'].includes(t.state) && !terminalGoals.has(this.goal(t.goalId).state) && t.reservationKeys.some(k => keySet.has(k)))) { parent.reason = '다른 작업이 예약한 접근 경로와 주변을 보존합니다.'; return false; }
    const goal = this.goal(parent.goalId);
    if (goal.input.source === 'autonomous' && (!this.state.rules.center || !footprintInside(this.state.rules.center, this.state.rules.radius, verified.proofPositions.map(position => ({ position }))))) return false;
    const child: Task = { id: randomUUID(), goalId: parent.goalId, generation: parent.generation, kind: 'build', source: parent.source, params: { mode: 'prepare-access', parentTaskId: parent.id, preparation: jsonObject(verified.plan), accessApproval: { attemptId: attempt.id, botId: attempt.botId, sessionId: attempt.sessionId, controllerEpoch: attempt.controllerEpoch }, ...(parent.params.blueprintDefinition ? { blueprintDefinition: parent.params.blueprintDefinition } : {}) }, dependencies: [...parent.dependencies], completion: { kind: 'blocks', blocks: accessPreparationFinalBlocks(verified.plan, before) }, reservationKeys: keys, affinityBotId: attempt.botId, state: 'waiting', retryCount: 0, resumeCount: 0, checkpoint: {}, progress: 0, createdAt: this.now(), updatedAt: this.now() };
    this.state.tasks.push(child); goal.taskIds.push(child.id); parent.dependencies.push(child.id); parent.state = 'interrupted'; parent.retryAt = this.now(); parent.waitState = undefined; parent.reason = '기존 건축 진행을 보존하고 승인한 접근 경로를 먼저 준비합니다.';
    this.changed('build.access-planned', parent.reason, { taskId: child.id, goalId: goal.id, botId: attempt.botId, data: { parentTaskId: parent.id, edits: verified.plan.edits.length } });
    return true;
  }
  private accessApproved(task: Task): boolean {
    const approval = task.params.accessApproval as JsonObject | undefined, plan = BuildAccessPreparationSchema.safeParse(task.params.preparation), parent = this.state.tasks.find(t => t.id === task.params.parentTaskId && t.goalId === task.goalId && t.generation === task.generation);
    const attempt = this.state.attempts.find(a => a.id === approval?.attemptId && a.taskId === parent?.id && a.botId === approval?.botId && a.sessionId === approval?.sessionId && a.controllerEpoch === approval?.controllerEpoch && a.state === 'interrupted');
    return !!parent && !!attempt && plan.success && parent.dependencies.includes(task.id) && JSON.stringify(attempt.result?.checkpoint.buildAccessPreparation) === JSON.stringify(plan.data);
  }
  private verifyAccessCompletion(task: Task, attempt: TaskAttempt, result: ResultPayload): { ok: boolean; reason: string } {
    const fail = (reason: string) => ({ ok: false, reason }), plan = BuildAccessPreparationSchema.safeParse(task.params.preparation), marker = task.checkpoint.accessPreparationComplete as JsonObject | undefined;
    const parent = this.state.tasks.find(t => t.id === task.params.parentTaskId);
    if (!this.accessApproved(task) || !plan.success || !parent || !marker || Number(marker.observedAt) < attempt.assignedAt || Number(marker.observedAt) > this.now() + 1000 || this.now() - Number(marker.observedAt) > this.state.rules.observationMaxAgeMs || !Number.isInteger(marker.observedAt)) return fail('현재 시도의 승인된 접근 경로와 최신 완료 증거가 필요합니다.');
    const target = PositionSchema.safeParse(marker.target);
    if (!target.success || positionKey(target.data) !== positionKey(plan.data.target)) return fail('기존 건축 입구의 실제 완료 증거가 필요합니다.');
    const blocks = this.attemptBlocks(attempt), checked = validateBuildAccessPreparation(plan.data, blocks, { allowCompletedEdits: true, expectedTarget: this.expectedBuildEntrance(parent), protectedPositions: parent.completion.kind === 'blocks' ? parent.completion.blocks.map(b => b.position) : [] }), names = new Map(blocks.map(b => [positionKey(b.position), b.name]));
    if (!checked.ok) return fail(checked.reason);
    if (plan.data.edits.some(e => !matchesPreparationTarget(e, names.get(positionKey(e.position)) ?? 'unknown'))) return fail('접근 경로 변경의 실제 완료 상태를 확인해야 합니다.');
    const observations = freshObservations({ observations: this.state.observations, now: this.now(), maxAgeMs: this.state.rules.observationMaxAgeMs, world: this.state.rules.world, dimension: this.state.rules.dimension, botId: attempt.botId, sessionId: attempt.sessionId, attemptId: attempt.id, notBefore: attempt.assignedAt });
    const visit = observations.filter(o => o.kind === 'exploration').sort((a, b) => b.observedAt - a.observedAt || b.receivedAt - a.receivedAt)[0];
    if (!visit || visit.kind !== 'exploration' || distance(visit.data.position, { ...plan.data.target, x: plan.data.target.x + 0.5, z: plan.data.target.z + 0.5 }) > 1.5 || result.outcome !== 'completed') return fail('봇이 실제로 기존 건축 입구에 도착한 관측이 필요합니다.');
    return { ok: true, reason: '예약한 접근 경로와 실제 입구 도착을 확인했습니다. 기존 건축을 재개합니다.' };
  }
  private verifyBuildSite(task: Task, attempt: TaskAttempt): { site?: BuildSite; reason: string } {
    const parsed = BuildSiteSchema.safeParse(task.checkpoint.buildSite), near = PositionSchema.safeParse(task.params.near);
    const design = String(task.params.design ?? task.params.blueprint ?? 'cabin');
    const fail = (reason: string) => ({ reason });
    if (!parsed.success || !near.success) return fail('지원하는 설계도와 실제 부지 좌표 증거가 필요합니다.');
    let size: ReturnType<typeof resolveBlueprint>;
    try { size = resolveBlueprint(design, task.params.blueprintDefinition); } catch { return fail('고정한 설계도와 실제 부지 증거가 필요합니다.'); }
    const site = parsed.data;
    if (!this.sameBlueprintDefinition(design, task.params.blueprintDefinition, site.blueprintDefinition)) return fail('부지 증거는 목표에 고정한 설계도 버전·크기·재료와 일치해야 합니다.');
    if (isSitePreparationTask(task)) {
      const preparation = BuildSitePreparationSchema.safeParse(task.params.preparation);
      if (!preparation.success || positionKey(site.origin) !== positionKey(preparation.data.origin) || site.design !== preparation.data.design || !this.sameBlueprintDefinition(design, task.params.blueprintDefinition, preparation.data.blueprintDefinition)) return fail('예약하고 정리한 부지의 실제 완료 증거가 필요합니다.');
      const actual = this.attemptBlocks(attempt), validated = validateBuildSitePreparation(preparation.data, actual, { allowCompletedEdits: true });
      const names = new Map(actual.map(b => [positionKey(b.position), b.name]));
      if (!validated.ok || preparation.data.edits.some(e => !matchesPreparationTarget(e, names.get(positionKey(e.position)) ?? 'unknown'))) return fail(validated.ok ? '모든 예약한 지형 변경의 실제 결과를 확인해야 합니다.' : validated.reason);
    }
    if (site.design !== design || site.observedAt < attempt.assignedAt || site.observedAt > this.now() + 1000 || this.now() - site.observedAt > this.state.rules.observationMaxAgeMs) return fail('현재 시도의 최신 부지 관측이 필요합니다.');
    const center = { x: site.origin.x + (size.width - 1) / 2, y: site.origin.y, z: site.origin.z + (size.depth - 1) / 2 };
    if (Math.hypot(center.x - near.data.x, center.z - near.data.z) > 32 || Math.abs(site.origin.y - near.data.y) > 8) return fail('부지는 탐색한 봇 주변의 확인 가능한 범위 안에 있어야 합니다.');
    const entrance = { x: site.origin.x + Math.floor(size.width / 2), y: site.origin.y, z: site.origin.z - 1 };
    if (positionKey(site.entrance) !== positionKey(entrance)) return fail('설계도의 실제 출입 경로 위치를 확인해야 합니다.');
    const blocks = blueprint(design, site.origin, typeof task.params.wood === 'string' ? task.params.wood : 'oak', task.params.blueprintDefinition);
    const cells = buildSiteCells(site.origin, size.width, size.depth, Math.max(size.height, ...blocks.map(b => b.position.y - site.origin.y)));
    const goal = this.goal(task.goalId);
    if (goal.input.source === 'autonomous' && (!this.state.rules.center || !footprintInside(this.state.rules.center, this.state.rules.radius, cells))) return fail('부지와 출입 경로 전체가 설정한 마을 범위 안에 있어야 합니다.');
    const observations = freshObservations({ observations: this.state.observations.filter(o => o.controllerEpoch === this.controllerEpoch), now: this.now(), maxAgeMs: this.state.rules.observationMaxAgeMs, world: this.state.rules.world, dimension: this.state.rules.dimension, botId: attempt.botId, sessionId: attempt.sessionId, attemptId: attempt.id, notBefore: attempt.assignedAt });
    const actual = new Map<string, { name: string; observedAt: number; receivedAt: number }>();
    for (const observation of observations) if (observation.kind === 'blocks') for (const block of observation.data.blocks) {
      const key = positionKey(block.position), previous = actual.get(key);
      if (!previous || observation.observedAt >= previous.observedAt) actual.set(key, { name: block.name, observedAt: observation.observedAt, receivedAt: observation.receivedAt });
    }
    if (cells.some(cell => { const name = actual.get(positionKey(cell.position))?.name; return !name || !(cell.requirement === 'air' ? isBuildSiteAir(name) : isBuildSiteGround(name)); })) return fail('부지 전체의 빈 공간, 안전한 지반과 출입 경로를 실제 블록으로 확인해야 합니다.');
    const visits = observations.filter(o => o.kind === 'exploration').sort((a, b) => b.observedAt - a.observedAt || b.receivedAt - a.receivedAt);
    const visit = visits[0];
    if (!visit || visit.kind !== 'exploration' || distance(visit.data.position, { ...entrance, x: entrance.x + 0.5, z: entrance.z + 0.5 }) > 1.5) return fail('탐색한 봇이 실제 출입 경로에 접근한 관측이 필요합니다.');
    const keys = new Set(cells.map(cell => `block:${this.state.rules.world}:${this.state.rules.dimension}:${positionKey(cell.position)}`));
    if (this.state.reservations.some(r => r.attemptId !== attempt.id && keys.has(r.key)) || this.state.tasks.some(other => other.goalId !== goal.id && other.generation === this.goal(other.goalId).generation && !['completed', 'cancelled'].includes(other.state) && !terminalGoals.has(this.goal(other.goalId).state) && other.reservationKeys.some(key => keys.has(key)))) return fail('다른 작업이 예약한 부지와 출입 경로를 보존해야 합니다.');
    return { site, reason: '현재 시도의 실제 블록과 접근 관측으로 부지를 확인했습니다.' };
  }
  private selectBuildSite(goal: Goal, task: Task, attempt: TaskAttempt, site: BuildSite): void {
    goal.input.params = { ...goal.input.params, origin: jsonObject(site.origin), siteSelection: 'fixed', siteVerification: { controllerEpoch: this.controllerEpoch, botId: attempt.botId, sessionId: attempt.sessionId, attemptId: attempt.id, observedAt: site.observedAt } };
    delete goal.input.params.sitePreparation;
    delete goal.input.params.preparationVerification;
    goal.progress.current = 0;
    this.invalidatePlan(goal, '실제로 확인한 부지에서 건축 단계를 계획합니다.');
    this.changed('goal.build-site-selected', goal.reason!, { goalId: goal.id, taskId: task.id, attemptId: attempt.id, botId: attempt.botId, data: { origin: jsonObject(site.origin), design: site.design } });
  }
  private attemptBlocks(attempt: TaskAttempt): ExpectedBlock[] {
    const observations = freshObservations({ observations: this.state.observations.filter(o => o.controllerEpoch === this.controllerEpoch), now: this.now(), maxAgeMs: this.state.rules.observationMaxAgeMs, world: this.state.rules.world, dimension: this.state.rules.dimension, botId: attempt.botId, sessionId: attempt.sessionId, attemptId: attempt.id, notBefore: attempt.assignedAt }).sort((a, b) => a.observedAt - b.observedAt || a.receivedAt - b.receivedAt);
    const actual = new Map<string, ExpectedBlock>();
    for (const observation of observations) if (observation.kind === 'blocks') for (const block of observation.data.blocks) actual.set(positionKey(block.position), block);
    return [...actual.values()];
  }
  private verifyPreparationProposal(task: Task, attempt: TaskAttempt): { preparation?: BuildSitePreparation; reason: string } {
    if (task.params.allowPreparation === false) return { reason: '이 목표는 지형 정리를 허용하지 않습니다.' };
    const near = PositionSchema.safeParse(task.params.near);
    if (!near.success) return { reason: '탐색한 봇의 실제 위치 증거가 필요합니다.' };
    const proposed = BuildSitePreparationSchema.safeParse(task.checkpoint.buildSitePreparation);
    if (!proposed.success || !this.sameBlueprintDefinition(String(task.params.design ?? task.params.blueprint), task.params.blueprintDefinition, proposed.data.blueprintDefinition)) return { reason: '정리 계획은 목표에 고정한 설계도 버전·크기·재료와 일치해야 합니다.' };
    const validated = validateBuildSitePreparation(task.checkpoint.buildSitePreparation, this.attemptBlocks(attempt), { near: near.data });
    if (!validated.ok) return { reason: validated.reason };
    const preparation = validated.plan;
    if (preparation.design !== String(task.params.design ?? task.params.blueprint) || preparation.observedAt < attempt.assignedAt || preparation.observedAt > this.now() + 1000 || this.now() - preparation.observedAt > this.state.rules.observationMaxAgeMs) return { reason: '현재 시도의 설계도와 최신 정리 계획 관측이 필요합니다.' };
    const goal = this.goal(task.goalId), keys = new Set(validated.proofPositions.map(p => `block:${this.state.rules.world}:${this.state.rules.dimension}:${positionKey(p)}`));
    if (goal.input.source === 'autonomous' && (!this.state.rules.center || !footprintInside(this.state.rules.center, this.state.rules.radius, validated.proofPositions.map(position => ({ position }))))) return { reason: '전체 정리 부지와 접근로가 마을 범위 안에 있어야 합니다.' };
    if (this.state.reservations.some(r => r.attemptId !== attempt.id && keys.has(r.key)) || this.state.tasks.some(t => t.goalId !== goal.id && t.generation === this.goal(t.goalId).generation && !['completed', 'cancelled'].includes(t.state) && !terminalGoals.has(this.goal(t.goalId).state) && t.reservationKeys.some(key => keys.has(key)))) return { reason: '다른 작업이 예약한 부지와 변경 주변을 보존해야 합니다.' };
    return { preparation, reason: '현재 시도의 실제 관측으로 제한된 부지 정리 계획을 검증했습니다.' };
  }
  private selectPreparationPlan(goal: Goal, task: Task, attempt: TaskAttempt, preparation: BuildSitePreparation): void {
    goal.input.params = { ...goal.input.params, siteSelection: 'preparing', sitePreparation: jsonObject(preparation), preparationVerification: { controllerEpoch: this.controllerEpoch, sessionId: attempt.sessionId, attemptId: attempt.id, botId: attempt.botId, observedAt: preparation.observedAt } };
    this.invalidatePlan(goal, '검증한 부지와 접근로를 예약하고 지형 정리 단계를 준비합니다.');
    this.changed('goal.build-site-preparation-planned', goal.reason!, { goalId: goal.id, taskId: task.id, attemptId: attempt.id, data: { edits: preparation.edits.length, origin: jsonObject(preparation.origin) } });
  }
  private preparationApproved(goal: Goal, taskPlan: unknown = goal.input.params.sitePreparation): boolean {
    if (this.state.tasks.some(t => t.goalId === goal.id && t.generation === goal.generation && isAccessPreparationTask(t) && JSON.stringify(t.params.preparation) === JSON.stringify(taskPlan) && this.accessApproved(t))) return true;
    if (goal.input.kind !== 'build' || goal.input.params.siteSelection !== 'preparing') return false;
    const marker = PreparationVerificationSchema.safeParse(goal.input.params.preparationVerification), plan = BuildSitePreparationSchema.safeParse(goal.input.params.sitePreparation), assignedPlan = BuildSitePreparationSchema.safeParse(taskPlan);
    if (!marker.success || !plan.success || !assignedPlan.success || plan.data.design !== String(goal.input.params.design ?? goal.input.params.blueprint ?? 'cabin') || !this.sameBlueprintDefinition(plan.data.design, goal.input.params.blueprintDefinition, plan.data.blueprintDefinition) || JSON.stringify(plan.data) !== JSON.stringify(assignedPlan.data) || marker.data.observedAt !== plan.data.observedAt) return false;
    const attempt = this.state.attempts.find(a => a.id === marker.data.attemptId && a.botId === marker.data.botId && a.sessionId === marker.data.sessionId && a.controllerEpoch === marker.data.controllerEpoch && a.state === 'completed');
    const survey = this.state.tasks.find(t => t.id === attempt?.taskId && t.goalId === goal.id && isBuildSiteTask(t) && t.state === 'completed' && t.attemptId === attempt?.id && t.generation < goal.generation);
    const reported = BuildSitePreparationSchema.safeParse(attempt?.result?.checkpoint.buildSitePreparation), checkpoint = BuildSitePreparationSchema.safeParse(survey?.checkpoint.buildSitePreparation);
    return !!survey && attempt?.result?.outcome === 'completed' && reported.success && checkpoint.success && JSON.stringify(plan.data) === JSON.stringify(reported.data) && JSON.stringify(plan.data) === JSON.stringify(checkpoint.data);
  }
  private sameBlueprintDefinition(design: string, expected: unknown, actual: unknown): boolean {
    try {
      const resolved = resolveBlueprint(design, expected);
      return resolved.definition ? JSON.stringify(resolved.definition) === JSON.stringify(BlueprintDefinitionSchema.parse(actual)) : actual === undefined;
    } catch { return false; }
  }
  private buildWaitFingerprint(condition: BuildWaitingFor, botId: string, previous?: string): string {
    let saved: { blocks?: Record<string, string | null>; inventory?: number; position?: string; resources?: Record<string, string>; resourceStates?: Record<string, number> } = {};
    try { if (previous) saved = JSON.parse(previous); } catch { /* An absent legacy fingerprint has no known values. */ }
    const observations = freshObservations({ observations: this.state.observations.filter(o => o.controllerEpoch === this.controllerEpoch), now: this.now(), maxAgeMs: this.state.rules.observationMaxAgeMs, world: this.state.rules.world, dimension: this.state.rules.dimension }).sort((a, b) => a.observedAt - b.observedAt || a.receivedAt - b.receivedAt);
    const actual = new Map<string, { name: string; stateId?: number }>();
    for (const observation of observations) {
      const blocks = observation.kind === 'blocks' ? observation.data.blocks : observation.kind === 'exploration' ? observation.data.resources : [];
      for (const block of blocks) {
        const key = positionKey(block.position), stateId = block.stateId ?? actual.get(key)?.stateId;
        actual.set(key, { name: block.name, ...(stateId === undefined ? {} : { stateId }) });
      }
    }
    const agent = this.state.agents.find(a => a.id === botId), report = agent?.session?.report;
    const validReport = report && report.world === this.state.rules.world && report.dimension === this.state.rules.dimension && this.now() - agent!.session!.lastReportAt < this.state.rules.statusTimeoutMs;
    const fingerprint: typeof saved = {};
    if (condition.kind === 'blocks') fingerprint.blocks = Object.fromEntries([...new Set(condition.positions.map(positionKey))].sort().map(key => [key, actual.get(key)?.name ?? saved.blocks?.[key] ?? null]));
    else {
      fingerprint.inventory = validReport ? itemCount(report.inventory, condition.item) : saved.inventory ?? 0;
      const probed = new Set(condition.resourcePositions?.map(positionKey));
      if (probed.size) fingerprint.blocks = Object.fromEntries([...probed].sort().map(key => [key, actual.get(key)?.name ?? saved.blocks?.[key] ?? null]));
      const resourceNames = resourceNamesFor(condition.item, condition.resourceNames);
      if (resourceNames.length) {
        const resources = { ...saved.resources };
        for (const [key, block] of actual) if (resourceNames.includes(block.name) || key in resources) resources[key] = block.name;
        fingerprint.resources = Object.fromEntries(Object.entries(resources).sort(([a], [b]) => a.localeCompare(b)).slice(0, 2048));
      }
      const states = { ...saved.resourceStates };
      for (const [key, block] of actual) if (block.stateId !== undefined && (probed.has(key) || key in (fingerprint.resources ?? {}))) states[key] = block.stateId;
      if (Object.keys(states).length) fingerprint.resourceStates = Object.fromEntries(Object.entries(states).sort(([a], [b]) => a.localeCompare(b)).slice(0, 2112));
    }
    if (condition.watchPosition) fingerprint.position = validReport && report.position ? positionKey({ x: Math.floor(report.position.x), y: Math.floor(report.position.y), z: Math.floor(report.position.z) }) : saved.position;
    return JSON.stringify(fingerprint);
  }
  private recordBuildWait(task: Task, attempt: TaskAttempt, verified: number): void {
    const parsed = BuildWaitingForSchema.safeParse(task.checkpoint.waitingFor), previous = task.waitState;
    const waitingFor = parsed.success ? parsed.data.kind === 'inventory' ? { ...parsed.data, resourceNames: resourceNamesFor(parsed.data.item, parsed.data.resourceNames) } : parsed.data : undefined;
    if (waitingFor) task.checkpoint.waitingFor = jsonObject(waitingFor);
    const sameCondition = JSON.stringify(waitingFor) === JSON.stringify(previous?.waitingFor);
    const fingerprint = waitingFor ? this.buildWaitFingerprint(waitingFor, attempt.botId, sameCondition ? previous?.fingerprint : undefined) : JSON.stringify({ reason: task.reason, verified, build: task.checkpoint.build, inventory: [...(this.state.agents.find(a => a.id === attempt.botId)?.session?.report?.inventory ?? [])].sort((a, b) => a.name.localeCompare(b.name)) });
    const repeatCount = previous && sameCondition && previous.fingerprint === fingerprint ? previous.repeatCount + 1 : 0;
    task.waitState = { ...(waitingFor ? { waitingFor } : {}), botId: attempt.botId, sessionId: attempt.sessionId, fingerprint, repeatCount };
    if (waitingFor) task.retryAt = undefined;
    else if (repeatCount >= this.state.rules.maxRetries) { task.state = 'held'; task.reason = `${task.reason ?? '건축 조건 대기'} 동일한 조건으로 ${this.state.rules.maxRetries}회 재확인했으나 진행이 없어 보류했습니다.`; }
  }
  private refreshBuildWait(task: Task): void {
    const wait = task.waitState;
    if (task.state !== 'condition-wait' || !wait?.waitingFor) return;
    if (wait.waitingFor.kind === 'inventory') {
      const normalized = resourceNamesFor(wait.waitingFor.item, wait.waitingFor.resourceNames);
      if (JSON.stringify(normalized) !== JSON.stringify(wait.waitingFor.resourceNames)) {
        wait.waitingFor.resourceNames = normalized;
        task.checkpoint.waitingFor = jsonObject(wait.waitingFor);
      }
    }
    const agent = this.state.agents.find(a => a.id === wait.botId);
    // The old worker owned the passive block watch. A confirmed replacement
    // session must inspect the preserved conditions once to restore that watch.
    const replacement = agent?.session?.state === 'ready' && agent.session.id !== wait.sessionId && this.state.stoppedSessionIds.includes(wait.sessionId);
    const fingerprint = this.buildWaitFingerprint(wait.waitingFor, wait.botId, wait.fingerprint);
    if (!replacement && fingerprint === wait.fingerprint) return;
    if (isBuildSiteTask(task) && wait.waitingFor.watchPosition) {
      const position = this.state.agents.find(a => a.id === wait.botId)?.session?.report?.position;
      if (position) task.params.near = jsonObject(position);
    }
    task.state = 'interrupted'; task.retryAt = this.now(); task.reason = replacement ? '이전 실행 종료와 새 세션을 확인하고 보존한 건축 조건을 다시 관측합니다.' : '관련 실제 관측이 바뀌어 실행 조건을 다시 확인합니다.';
    delete task.checkpoint.waitingFor;
    this.changed('task.condition-changed', task.reason, { taskId: task.id, goalId: task.goalId });
  }
  private reducePartialTransfer(task: Task, attempt: TaskAttempt, evidence: ResultPayload['evidence']): void {
    if (task.completion.kind !== 'transfer') return;
    const confirmed = this.verify(task, attempt, evidence).current;
    if (confirmed > 0 && confirmed < task.completion.quantity) { task.completion.quantity -= confirmed; task.params.quantity = task.completion.quantity; task.checkpoint.transferred = Number(task.checkpoint.transferred ?? 0) + confirmed; }
  }
  private completeTask(task: Task, attempt: TaskAttempt): void {
    task.state = 'completed'; task.progress = 1; task.updatedAt = this.now(); attempt.state = 'completed'; attempt.finishedAt = this.now();
    for (const dependent of this.state.tasks.filter(t => t.dependencies.includes(task.id))) dependent.affinityBotId = attempt.botId;
  }
  private release(attemptId?: string): void { if (attemptId) this.state.reservations = this.state.reservations.filter(r => r.attemptId !== attemptId); }
  private taskHasActor(task: Task): boolean {
    const attempt = this.state.attempts.find(a => a.id === task.attemptId);
    return !!attempt && (activeAttempts.has(attempt.state) || (attempt.state === 'uncertain' && !attempt.finishedAt && !this.state.stoppedSessionIds.includes(attempt.sessionId)));
  }
  private cancelAgentAttempt(agent: Agent, reason: string, preserve: boolean): boolean {
    const task = this.state.tasks.find(t => t.attemptId === agent.session?.activeAttemptId);
    if (!task) return false;
    this.cancelTask(task, reason, preserve);
    return true;
  }
  private cancelTask(task: Task, reason: string, preserve: boolean): void {
    const attempt = this.state.attempts.find(a => a.id === task.attemptId), agent = this.state.agents.find(a => a.id === attempt?.botId);
    if (!attempt || !agent?.session || agent.session.id !== attempt.sessionId || !activeAttempts.has(attempt.state) || attempt.state === 'cancelling') return;
    task.state = 'cancelling'; task.reason = reason; attempt.state = 'cancelling';
    this.send(agent, 'task.cancel', { reason, preserveProgress: preserve }, { taskId: task.id, attemptId: attempt.id });
    this.changed('task.cancel-requested', reason, { taskId: task.id, botId: agent.id, attemptId: attempt.id });
  }
  private currentTasks(goal: Goal): Task[] { return this.state.tasks.filter(t => t.goalId === goal.id && t.generation === goal.generation); }
  private invalidatePlan(goal: Goal, reason: string): void {
    if (terminalGoals.has(goal.state) || goal.state === 'cancelling') return;
    for (const task of this.currentTasks(goal)) {
      if (this.taskHasActor(task)) return;
    }
    for (const task of this.currentTasks(goal)) if (task.state !== 'completed') { task.state = 'cancelled'; this.release(task.attemptId); }
    goal.generation++; goal.state = 'queued'; goal.reason = reason; goal.updatedAt = this.now();
  }
  private finishGoalCancellation(goal: Goal): void {
    if (goal.state !== 'cancelling' || this.currentTasks(goal).some(t => this.taskHasActor(t))) return;
    for (const task of this.currentTasks(goal)) if (task.state !== 'completed') { task.state = 'cancelled'; this.release(task.attemptId); }
    goal.state = 'cancelled'; goal.updatedAt = this.now();
    this.changed('goal.cancelled', '목표의 실제 실행 중단을 확인했습니다.', { goalId: goal.id });
    this.finishCommands(goal.id, ['goal-cancel']);
  }

  private warehouseCount(goal: Goal): number | undefined {
    const container = goal.input.destination ?? this.state.rules.warehouse;
    if (!container || !goal.input.item) return undefined;
    const observations = freshObservations({ observations: this.state.observations.filter(o => o.controllerEpoch === this.controllerEpoch), now: this.now(), maxAgeMs: this.state.rules.observationMaxAgeMs, world: container.world, dimension: container.dimension });
    const observed = observations.filter(o => o.kind === 'container' && sameContainer(o.data.container, container)).reverse().sort((a, b) => b.observedAt - a.observedAt || b.receivedAt - a.receivedAt)[0];
    return observed?.kind === 'container' ? itemCount(observed.data.items, goal.input.item) : undefined;
  }
  private reconcileAndPlan(goal: Goal): void {
    if (goal.state === 'cancelling') { this.finishGoalCancellation(goal); return; }
    if (terminalGoals.has(goal.state)) return;
    if (!goal.input.destination && this.state.rules.warehouse && (isStockGoal(goal) || ['store', 'take'].includes(goal.input.kind) || (goal.input.kind === 'farm' && goal.input.params.mode === 'harvest'))) goal.input.destination = clone(this.state.rules.warehouse);
    let tasks = this.currentTasks(goal), stock = this.warehouseCount(goal);
    for (const task of tasks) this.refreshBuildWait(task);
    if (goal.input.source === 'autonomous' && !this.state.rules.autonomyEnabled) { goal.state = 'condition-wait'; goal.reason = '자율 마을 발전이 꺼져 있습니다.'; return; }
    if (goal.input.source === 'autonomous' && tasks.some(t => t.completion.kind === 'blocks' && (!this.state.rules.center || !footprintInside(this.state.rules.center, this.state.rules.radius, t.completion.blocks))) && !tasks.some(t => this.taskHasActor(t))) { this.invalidatePlan(goal, '마을 범위에 맞는 전체 배치를 다시 확인합니다.'); tasks = []; }
    if (isStockGoal(goal)) {
      if (stock !== undefined) {
        if (goal.targetQuantity === undefined) goal.targetQuantity = stock + goal.input.quantity;
        goal.progress = { current: stock, target: goal.targetQuantity };
        if (stock >= goal.targetQuantity) {
          for (const task of tasks) if (this.taskHasActor(task)) this.cancelTask(task, '공동 창고 목표 수량 확인', false); else if (task.state !== 'completed') { task.state = 'cancelled'; this.release(task.attemptId); }
          const nextState = goal.input.mode === 'maintain' ? 'maintaining' : 'completed';
          if (goal.state !== nextState) { goal.state = nextState; goal.updatedAt = this.now(); this.changed('goal.verified', '공동 창고에서 목표 총수량을 확인했습니다.', { goalId: goal.id }); }
          return;
        }
        if (goal.state === 'maintaining' && !tasks.some(t => this.taskHasActor(t))) { this.invalidatePlan(goal, '재고가 줄어 보충합니다.'); tasks = []; }
      }
    }
    const reconciliation = tasks.filter(t => t.checkpoint.reconcile === true);
    if (reconciliation.length) {
      const stopped = reconciliation.every(t => { const a = this.state.attempts.find(a => a.id === t.attemptId); return !a || this.state.stoppedSessionIds.includes(a.sessionId); });
      const observed = isStockGoal(goal) ? stock !== undefined : reconciliation.every(t => {
        const a = this.state.attempts.find(a => a.id === t.attemptId), bot = this.state.agents.find(b => b.id === a?.botId);
        return bot?.session?.state === 'ready' && this.state.observations.some(o => o.botId === bot.id && o.sessionId === bot.session?.id && o.controllerEpoch === this.controllerEpoch && this.now() - o.receivedAt <= this.state.rules.observationMaxAgeMs);
      });
      if (!stopped || !observed) { goal.state = 'held'; goal.reason = '이전 실행 종료와 최신 월드 관측을 기다립니다.'; return; }
      const accessResume = reconciliation.every(t => isAccessPreparationTask(t) || t.kind === 'build' && tasks.some(child => isAccessPreparationTask(child) && child.params.parentTaskId === t.id));
      const observedAccess = accessResume && reconciliation.every(t => { const a = this.state.attempts.find(a => a.id === t.attemptId), bot = this.state.agents.find(b => b.id === a?.botId); return bot?.session?.state === 'ready' && this.state.observations.some(o => o.kind === 'blocks' && o.botId === bot.id && o.sessionId === bot.session?.id && o.controllerEpoch === this.controllerEpoch && this.now() - o.receivedAt <= this.state.rules.observationMaxAgeMs); });
      if (accessResume && !observedAccess) { goal.state = 'held'; goal.reason = '확인한 접근 경로와 건축의 실제 블록 재관측을 기다립니다.'; return; }
      if (accessResume) {
        for (const task of reconciliation) { this.release(task.attemptId); delete task.checkpoint.reconcile; task.state = 'interrupted'; task.resumeCount++; task.reason = '실제 종료와 새 세션의 블록 관측을 확인하고 기존 접근·건축 진행을 보존합니다.'; }
        goal.state = 'queued'; goal.reason = '기존 건축과 승인한 접근 경로의 남은 작업을 자동 재개합니다.';
        this.changed('build.access-resumed', goal.reason, { goalId: goal.id });
      } else { this.invalidatePlan(goal, '실제 월드를 확인하고 남은 작업을 자동 재개합니다.'); tasks = []; }
    }
    const goalEdit = goal.replanRequested || this.state.pendingCommands.some(c => c.targetId === goal.id && c.type === 'goal-update');
    if (goalEdit && !tasks.some(t => this.taskHasActor(t))) { this.invalidatePlan(goal, '수정한 목표를 재계획합니다.'); goal.replanRequested = undefined; tasks = []; this.finishCommands(goal.id, ['goal-update']); }
    if (tasks.some(t => t.state === 'held')) { goal.state = 'held'; goal.reason = tasks.find(t => t.state === 'held')?.reason; return; }
    if (goal.input.kind === 'build' && goal.input.params.siteSelection === 'preparing' && !tasks.some(t => this.taskHasActor(t)) && !this.preparationApproved(goal)) { goal.state = 'held'; goal.reason = '같은 목표의 실제 탐색 결과로 중앙에서 승인한 부지 정리 계획이 필요합니다.'; return; }
    if (tasks.length && tasks.every(t => t.state === 'completed' || t.state === 'cancelled')) {
      if (goal.input.kind === 'build' && ['nearby', 'preparing'].includes(String(goal.input.params.siteSelection)) && tasks.some(isBuildStageTask) && !goalEdit) { goal.state = 'held'; goal.reason = '부지 탐색과 정리는 건설 완료가 아닙니다. 실제 부지 확인이 필요합니다.'; return; }
      if (isStockGoal(goal) && stock === undefined) { goal.state = 'condition-wait'; goal.reason = '최종 창고 재고 관측이 필요합니다.'; return; }
      const ongoing = goal.input.mode === 'maintain' || ['guard', 'follow', 'survive'].includes(goal.input.kind);
      if (!isStockGoal(goal) && !ongoing) {
        goal.state = 'completed'; goal.progress.current = goal.targetQuantity ?? goal.input.quantity; goal.progress.target = goal.targetQuantity ?? goal.input.quantity; goal.updatedAt = this.now();
        this.changed('goal.completed', '목표의 실제 결과를 확인했습니다.', { goalId: goal.id }); return;
      }
      if (ongoing && !isStockGoal(goal)) {
        if (goal.nextRunAt === undefined) { goal.nextRunAt = this.now() + (goal.input.kind === 'guard' ? 30000 : 5000); goal.state = 'maintaining'; return; }
        if (goal.nextRunAt > this.now()) return;
        goal.nextRunAt = undefined;
      }
      this.invalidatePlan(goal, '다음 실행 주기를 준비합니다.'); tasks = [];
    }
    if (!tasks.length) {
      const builders = this.state.agents.filter(a => a.config.enabled && a.status !== 'removed' && a.status !== 'removing' && a.session?.state === 'ready' && a.session.report?.ready && a.session.report.world === this.state.rules.world && a.session.report.dimension === this.state.rules.dimension && this.now() - a.session.lastReportAt < this.state.rules.statusTimeoutMs && ['build', 'explore'].every(kind => a.config.allowedActions.includes(kind as 'build' | 'explore') && a.session!.report!.capabilities.includes(kind as 'build' | 'explore'))).sort((a, b) => Number(b.id === goal.input.preferredBotId) - Number(a.id === goal.input.preferredBotId));
      const nearbyPosition = builders.find(a => a.session?.report?.position)?.session?.report?.position;
      const plan = planGoal(goal, this.state.rules, randomUUID, stock, nearbyPosition);
      if (plan.waiting) { goal.state = 'condition-wait'; goal.reason = plan.waiting; return; }
      for (const spec of plan.tasks) {
        if (typeof goal.input.params.supportHelperId === 'string') spec.affinityBotId = goal.input.params.supportHelperId;
        const task: Task = { ...spec, generation: goal.generation, state: 'waiting', retryCount: 0, resumeCount: 0, checkpoint: {}, progress: 0, createdAt: this.now(), updatedAt: this.now() };
        this.state.tasks.push(task); goal.taskIds.push(task.id);
      }
      if (plan.tasks.length) { goal.state = 'queued'; goal.reason = undefined; this.changed('goal.planned', '실행 단계와 선행 조건을 계획했습니다.', { goalId: goal.id, data: { tasks: plan.tasks.length } }); }
    }
    const frontier = this.currentTasks(goal).filter(t => !['completed', 'cancelled'].includes(t.state) && t.dependencies.every(id => this.state.tasks.find(d => d.id === id)?.state === 'completed'));
    if (frontier.length && frontier.every(t => t.state === 'condition-wait')) { goal.state = 'condition-wait'; goal.reason = frontier[0].reason; goal.updatedAt = this.now(); }
    else if (frontier.some(t => isPreparationTask(t) && !this.taskHasActor(t) && this.protectedPositions(t).length > 10000)) { goal.state = 'condition-wait'; goal.reason = '보호할 건축·농장 좌표가 너무 많아 먼저 진행 중인 작업을 기다립니다.'; }
    else if (frontier.some(t => isPreparationTask(t) && !this.taskHasActor(t) && this.otherResourceActor(t))) { goal.state = 'condition-wait'; goal.reason = '부지 보호를 위해 먼저 시작한 자원 작업의 실제 종료를 기다립니다.'; }
    else if (goal.state === 'condition-wait') { goal.state = 'queued'; goal.reason = undefined; }
  }
  private candidateTasks(agent: Agent): Task[] {
    if (agent.recovery && !(agent.recovery.phase === 'resolved' && agent.recovery.safe)) return [];
    if (!agent.config.enabled || agent.desiredConfig?.enabled === false || agent.status === 'removing' || agent.status === 'removed' || agent.session?.state !== 'ready' || !agent.session.report?.ready || agent.session.activeAttemptId || agent.session.rulesVersion !== this.state.rules.version || this.now() - agent.session.lastReportAt >= this.state.rules.statusTimeoutMs || ['emergency', 'survival', 'recovering', 'paused', 'stopping'].includes(agent.session.report.mode) || agent.session.report.health <= this.state.rules.combat.retreatHealth || agent.session.report.food <= 6) return [];
    const pinned = this.state.tasks.some(t => t.affinityBotId === agent.id && t.state !== 'completed' && t.state !== 'cancelled' && t.generation === this.goal(t.goalId).generation && !terminalGoals.has(this.goal(t.goalId).state) && (!t.blockedByGoalId || terminalGoals.has(this.goal(t.blockedByGoalId).state)));
    return this.state.tasks.filter(task => {
      const goal = this.goal(task.goalId);
      if (!runnable.has(task.state) || task.generation !== goal.generation || terminalGoals.has(goal.state) || goal.state === 'cancelling' || goal.state === 'held' || (task.retryAt ?? 0) > this.now()) return false;
      if (task.state === 'condition-wait' && task.waitState?.waitingFor) return false;
      if (isPreparationTask(task) && (!this.preparationApproved(goal, task.params.preparation) || this.otherResourceActor(task))) return false;
      if (resourceActions.has(task.kind) && !isPreparationTask(task) && this.preparationBarrier(task)) return false;
      if (goal.input.source === 'autonomous' && !this.state.rules.autonomyEnabled) return false;
      if (task.blockedByGoalId && !terminalGoals.has(this.goal(task.blockedByGoalId).state)) return false;
      if (task.affinityBotId && task.affinityBotId !== agent.id) return false;
      if (pinned && task.affinityBotId !== agent.id) return false;
      if (!task.dependencies.every(id => this.state.tasks.find(t => t.id === id)?.state === 'completed')) return false;
      if (!agent.config.allowedActions.includes(task.kind) || !agent.session!.report!.capabilities.includes(task.kind)) return false;
      if (isBuildSiteTask(task) && (!agent.session!.report!.position || !agent.config.allowedActions.includes('build') || !agent.session!.report!.capabilities.includes('build'))) return false;
      if (task.reservationKeys.some(key => this.state.reservations.some(r => r.key === key && r.attemptId !== task.attemptId))) return false;
      if (agent.session!.report!.world !== this.state.rules.world || agent.session!.report!.dimension !== this.state.rules.dimension) return false;
      if (goal.input.source === 'autonomous' && task.completion.kind === 'blocks' && (!this.state.rules.center || !footprintInside(this.state.rules.center, this.state.rules.radius, task.completion.blocks))) return false;
      return true;
    }).sort((a, b) => this.taskPriority(b) - this.taskPriority(a) || Number(roleFits(agent.config.role, b.kind)) - Number(roleFits(agent.config.role, a.kind)) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  private taskPriority(task: Task): number {
    const goal = this.goal(task.goalId);
    return (isAccessPreparationTask(task) ? 500 : 0) + (typeof goal.input.params.supportRequestId === 'string' ? 3000 : 0) + (goal.input.source === 'user' ? 1000 : 0) + goal.input.priority + (goal.input.executionMode === 'immediate' ? 200 : 0);
  }
  private otherResourceActor(task: Task): boolean { return this.state.tasks.some(t => t.id !== task.id && resourceActions.has(t.kind) && this.taskHasActor(t)); }
  private potentialPreparationActor(task: Task): boolean {
    if (this.protectedPositions(task).length > 10000 || !this.preparationApproved(this.goal(task.goalId), task.params.preparation)) return false;
    return this.state.agents.some(agent => {
      const session = agent.session, report = session?.report;
      if (agent.recovery && !(agent.recovery.phase === 'resolved' && agent.recovery.safe)) return false;
      if (!agent.config.enabled || agent.desiredConfig?.enabled === false || ['removed', 'removing'].includes(agent.status) || session?.state !== 'ready' || !report?.ready || session.rulesVersion !== this.state.rules.version || this.now() - session.lastReportAt >= this.state.rules.statusTimeoutMs || ['emergency', 'survival', 'recovering', 'paused', 'stopping'].includes(report.mode) || report.health <= this.state.rules.combat.retreatHealth || report.food <= 6 || report.world !== this.state.rules.world || report.dimension !== this.state.rules.dimension || !agent.config.allowedActions.includes('build') || !report.capabilities.includes('build')) return false;
      if (task.affinityBotId && task.affinityBotId !== agent.id) return false;
      if (this.state.tasks.some(t => t.affinityBotId === agent.id && t.id !== task.id && t.id !== task.params.parentTaskId && !['completed', 'cancelled'].includes(t.state) && t.generation === this.goal(t.goalId).generation && !terminalGoals.has(this.goal(t.goalId).state) && (!t.blockedByGoalId || terminalGoals.has(this.goal(t.blockedByGoalId).state)))) return false;
      return !task.reservationKeys.some(key => this.state.reservations.some(r => r.key === key && r.attemptId !== task.attemptId));
    });
  }
  private preparationBarrier(task: Task): boolean {
    return this.state.tasks.some(preparation => {
      if (!isPreparationTask(preparation) || preparation.id === task.id) return false;
      if (this.taskHasActor(preparation)) return true;
      const goal = this.goal(preparation.goalId);
      return preparation.generation === goal.generation && !terminalGoals.has(goal.state) && !['held', 'cancelling'].includes(goal.state) && runnable.has(preparation.state) && !(preparation.state === 'condition-wait' && preparation.waitState?.waitingFor) && (preparation.retryAt ?? 0) <= this.now() && preparation.dependencies.every(id => this.state.tasks.find(t => t.id === id)?.state === 'completed') && (!preparation.blockedByGoalId || terminalGoals.has(this.goal(preparation.blockedByGoalId).state)) && (goal.input.source !== 'autonomous' || this.state.rules.autonomyEnabled) && this.taskPriority(preparation) >= this.taskPriority(task) && this.potentialPreparationActor(preparation);
    });
  }
  private protectedPositions(task: Task): Position[] {
    const positions = new Map<string, Position>();
    for (const other of this.state.tasks) {
      const goal = this.goal(other.goalId);
      if (other.id === task.id || other.id === task.params.parentTaskId || !['build', 'farm'].includes(other.kind) || other.generation !== goal.generation || ['completed', 'cancelled'].includes(other.state) || terminalGoals.has(goal.state)) continue;
      for (const reservation of other.reservationKeys) {
        if (!reservation.startsWith(`block:${this.state.rules.world}:${this.state.rules.dimension}:`)) continue;
        const values = reservation.split(':').at(-1)!.split(',').map(Number);
        if (values.length === 3 && values.every(Number.isInteger)) positions.set(values.join(','), { x: values[0]!, y: values[1]!, z: values[2]! });
      }
    }
    return [...positions.values()];
  }
  private preferredElsewhere(task: Task, agent: Agent): boolean {
    const preferred = this.goal(task.goalId).input.preferredBotId;
    if (task.affinityBotId) return false;
    if (preferred) {
      if (preferred === agent.id) return false;
      const target = this.state.agents.find(a => a.id === preferred);
      if (target && this.candidateTasks(target).some(t => t.id === task.id)) return true;
    }
    return !roleFits(agent.config.role, task.kind) && this.state.agents.some(a => a.id !== agent.id && roleFits(a.config.role, task.kind) && this.candidateTasks(a).some(t => t.id === task.id));
  }
  private assign(agent: Agent, task: Task, decision: SchedulerDecision = { id: task.id, source: 'code', reason: '우선순위, 역할, 능력과 예약 조건을 확인했습니다.' }): void {
    if (!this.candidateTasks(agent).some(t => t.id === task.id) || this.preferredElsewhere(task, agent)) return;
    const protectedPositions = this.protectedPositions(task);
    if (protectedPositions.length > 10000) { task.reason = '보호할 건축·농장 좌표가 너무 많아 먼저 진행 중인 작업을 기다립니다.'; return; }
    task.params.protectedPositions = protectedPositions.map(jsonObject);
    if (isBuildSiteTask(task)) task.params.near = jsonObject(agent.session!.report!.position!);
    if (task.kind === 'collect' && task.completion.kind === 'inventory') task.params.quantity = Math.max(0, task.completion.minimum - itemCount(agent.session!.report!.inventory, task.completion.item));
    const goal = this.goal(task.goalId);
    if ((task.kind === 'craft' || task.kind === 'smelt') && task.completion.kind === 'inventory' && goal.input.quantityMode === 'additional') {
      if (goal.targetQuantity === undefined) { goal.targetQuantity = itemCount(agent.session!.report!.inventory, task.completion.item) + goal.input.quantity; task.params.additionalBaseline = goal.targetQuantity - goal.input.quantity; }
      task.completion.minimum = goal.targetQuantity; task.params.quantity = goal.targetQuantity; goal.progress.target = goal.targetQuantity;
    }
    const attempt: TaskAttempt = { id: randomUUID(), taskId: task.id, botId: agent.id, sessionId: agent.session!.id, controllerEpoch: this.controllerEpoch, reason: task.retryCount ? 'retry' : task.resumeCount ? 'resume' : 'initial', state: 'assigned', assignedAt: this.now() };
    this.state.attempts.push(attempt); task.attemptId = attempt.id; task.state = 'assigned'; task.updatedAt = this.now();
    agent.session!.activeAttemptId = attempt.id;
    for (const key of task.reservationKeys) this.state.reservations.push({ key, taskId: task.id, attemptId: attempt.id, botId: agent.id, sessionId: attempt.sessionId, acquiredAt: this.now() });
    this.goal(task.goalId).state = 'active'; this.goal(task.goalId).reason = undefined;
    this.changed('scheduler.decision', decision.reason, { taskId: task.id, botId: agent.id, attemptId: attempt.id, data: { source: decision.source, ...(decision.model ? { model: decision.model } : {}) } });
    this.send(agent, 'task.assign', { task: taskSpec(task), checkpoint: task.checkpoint, rulesVersion: this.state.rules.version }, { taskId: task.id, attemptId: attempt.id });
    this.changed('task.assigned', '작업을 배정하고 수락을 기다립니다.', { taskId: task.id, botId: agent.id, attemptId: attempt.id });
  }
  private schedule(agent: Agent): void {
    const all = this.candidateTasks(agent).filter(t => !this.preferredElsewhere(t, agent));
    if (!all.length) return;
    const pending = this.decisions.get(agent.id);
    if (pending) {
      if (this.now() - pending.requestedAt < 5000) return;
      pending.abort.abort(); this.decisions.delete(agent.id);
      this.assign(agent, all[0], { id: all[0].id, source: 'code', reason: '모델 응답 시간 초과: 검증된 배정 규칙을 사용합니다.' }); return;
    }
    const candidates = all.filter(t => this.taskPriority(t) === this.taskPriority(all[0]));
    if (!this.options.decide || candidates.length < 2) { this.assign(agent, all[0]); return; }
    const token = randomUUID(), sessionId = agent.session!.id, abort = new AbortController();
    this.decisions.set(agent.id, { token, sessionId, taskIds: candidates.map(t => t.id), requestedAt: this.now(), abort });
    const request = { state: JSON.stringify({ bot: agent.config.role, report: agent.session!.report, rulesVersion: this.state.rules.version }), candidates: candidates.map(t => ({ id: t.id, description: `${t.kind}: ${this.goal(t.goalId).title}` })), signal: abort.signal };
    Promise.resolve().then(() => this.options.decide!(request)).then(decision => {
      if (this.decisions.get(agent.id)?.token !== token) return;
      this.decisions.delete(agent.id);
      if (agent.session?.id !== sessionId) return;
      const eligible = this.candidateTasks(agent).filter(t => !this.preferredElsewhere(t, agent));
      const chosen = eligible.find(t => t.id === decision.id && candidates.some(c => c.id === t.id) && this.taskPriority(t) === this.taskPriority(eligible[0] ?? t));
      if (chosen && (decision.source === 'laya' || decision.source === 'code')) this.assign(agent, chosen, decision);
      else if (eligible.length) this.assign(agent, eligible[0], { id: eligible[0].id, source: 'code', reason: '모델 선택의 현재 실행 조건을 다시 확인하고 코드 배정으로 복구합니다.' });
    }).catch(() => {
      if (this.decisions.get(agent.id)?.token !== token) return;
      this.decisions.delete(agent.id);
      const eligible = this.candidateTasks(agent).filter(t => !this.preferredElsewhere(t, agent));
      if (eligible.length) this.assign(agent, eligible[0], { id: eligible[0].id, source: 'code', reason: '모델 오류: 검증된 배정 규칙을 사용합니다.' });
    });
  }
  private yieldAutonomy(): void {
    const userTasks = this.state.tasks.filter(t => {
      const goal = this.goal(t.goalId);
      return goal.input.source === 'user' && !terminalGoals.has(goal.state) && goal.state !== 'held' && goal.state !== 'cancelling' && t.generation === goal.generation && runnable.has(t.state) && !(t.state === 'condition-wait' && t.waitState?.waitingFor) && (t.retryAt ?? 0) <= this.now() && t.dependencies.every(id => this.state.tasks.find(d => d.id === id)?.state === 'completed');
    }).sort((a, b) => this.taskPriority(b) - this.taskPriority(a));
    for (const task of userTasks) {
      if (this.state.agents.some(a => this.candidateTasks(a).some(t => t.id === task.id))) continue;
      const agent = this.state.agents.find(a => {
        const active = this.state.tasks.find(t => t.attemptId === a.session?.activeAttemptId);
        return active && active.state !== 'cancelling' && this.goal(active.goalId).input.source === 'autonomous' && a.status === 'ready' && a.config.enabled && a.desiredConfig?.enabled !== false && a.session?.state === 'ready' && a.session.report && a.session.report.mode !== 'emergency' && a.session.report.health > this.state.rules.combat.retreatHealth && a.session.report.food > 6 && a.config.allowedActions.includes(task.kind) && a.session.report.capabilities.includes(task.kind) && (!task.affinityBotId || task.affinityBotId === a.id);
      });
      if (!agent) continue;
      const active = this.state.tasks.find(t => t.attemptId === agent.session?.activeAttemptId)!;
      active.blockedByGoalId = task.goalId;
      this.cancelTask(active, '사용자 목표를 우선하고 마을 발전 진행을 보존합니다.', true);
      this.changed('autonomy.yielded', '사용자 목표를 수행할 봇을 확보하기 위해 자율 작업을 안전하게 중단합니다.', { botId: agent.id, taskId: active.id, goalId: task.goalId });
    }
  }

  tick(): void {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      for (const agent of this.state.agents) {
        if (agent.session?.state === 'ready' && this.now() - agent.session.lastReportAt >= this.state.rules.statusTimeoutMs) { agent.session.state = 'abnormal'; if (agent.status !== 'removing') agent.status = 'abnormal'; this.changed('bot.abnormal', '10초 이상 상태 보고가 없어 접속 이상으로 표시합니다.', { botId: agent.id }); }
        this.applyAgentRules(agent);
      }
      if (this.state.rules.autonomyEnabled && this.state.rules.center && this.state.rules.warehouse && this.state.agents.some(a => a.session?.state === 'ready' && a.config.enabled)) {
        for (const stock of this.state.rules.developmentStock) if (!this.state.goals.some(g => g.input.source === 'autonomous' && g.input.kind === 'collect' && g.input.item === stock.item)) {
          const input = GoalInputSchema.parse({ kind: 'collect', item: stock.item, quantity: stock.quantity, mode: 'maintain', source: 'autonomous', priority: 10 });
          const goal: Goal = { id: randomUUID(), input, title: goalTitle(input), state: 'queued', targetQuantity: stock.quantity, taskIds: [], createdAt: this.now(), updatedAt: this.now(), progress: { current: 0, target: stock.quantity }, generation: 0 };
          this.state.goals.push(goal); this.changed('goal.autonomous-created', '여유 봇을 위한 마을 재고 유지 목표를 추가했습니다.', { goalId: goal.id, data: { source: 'code' } });
        }
        const center = this.state.rules.center;
        const development: GoalInput[] = [
          { kind: 'farm', source: 'autonomous', params: { developmentId: 'village-farm', id: 'village-farm', crop: 'wheat', mode: 'setup', plots: 8, origin: { x: Math.floor(center.x) - 12, y: Math.floor(center.y) - 1, z: Math.floor(center.z) } }, priority: 8 },
          { kind: 'build', source: 'autonomous', params: { developmentId: 'village-house', design: 'cabin', origin: { x: center.x + 12, y: center.y, z: center.z } }, priority: 5 },
          { kind: 'build', source: 'autonomous', params: { developmentId: 'village-warehouse', design: 'warehouse', origin: { x: center.x, y: center.y, z: center.z + 12 } }, priority: 4 },
          { kind: 'build', source: 'autonomous', params: { developmentId: 'village-watchtower', design: 'tower', origin: { x: center.x - 12, y: center.y, z: center.z - 12 } }, priority: 3 },
          { kind: 'guard', source: 'autonomous', mode: 'maintain', params: { developmentId: 'village-defense', position: { x: center.x, y: center.y, z: center.z } }, priority: 3 },
        ];
        for (const candidate of development) if (!this.state.goals.some(g => g.input.source === 'autonomous' && g.input.params.developmentId === candidate.params?.developmentId) && this.state.agents.some(a => a.config.allowedActions.includes(candidate.kind) && a.session?.report?.capabilities.includes(candidate.kind))) {
          const input = GoalInputSchema.parse(candidate), goal: Goal = { id: randomUUID(), input, title: goalTitle(input), state: 'queued', taskIds: [], createdAt: this.now(), updatedAt: this.now(), progress: { current: 0, target: input.quantity }, generation: 0 };
          this.state.goals.push(goal); this.changed('goal.autonomous-created', '관측과 범위 검증을 거쳐 마을 발전 작업을 준비합니다.', { goalId: goal.id, data: { source: 'code' } });
        }
      }
      this.expireSupport();
      for (const goal of [...this.state.goals]) this.reconcileAndPlan(goal);
      this.yieldSupport();
      this.yieldAutonomy();
      const agents = [...this.state.agents].sort((a, b) => Number(this.state.goals.some(g => g.input.preferredBotId === b.id && !terminalGoals.has(g.state))) - Number(this.state.goals.some(g => g.input.preferredBotId === a.id && !terminalGoals.has(g.state))) || a.createdAt - b.createdAt);
      for (const agent of agents) this.schedule(agent);
      this.compact();
    } finally { this.ticking = false; }
  }
  private compact(): void {
    const retention = this.now() - this.state.rules.logRetentionDays * 86400000;
    this.state.goals = this.state.goals.filter(g => !terminalGoals.has(g.state) || g.input.source === 'autonomous' || g.updatedAt >= retention);
    const goals = new Map(this.state.goals.map(g => [g.id, g]));
    this.state.tasks = this.state.tasks.filter(t => {
      const goal = goals.get(t.goalId);
      const approval = PreparationVerificationSchema.safeParse(goal?.input.params.preparationVerification);
      return !!goal && (t.generation >= goal.generation - 2 || (goal.input.params.siteSelection === 'preparing' && approval.success && t.attemptId === approval.data.attemptId) || this.taskHasActor(t) || this.state.reservations.some(r => r.taskId === t.id));
    });
    const taskIds = new Set(this.state.tasks.map(t => t.id));
    for (const goal of this.state.goals) goal.taskIds = goal.taskIds.filter(id => taskIds.has(id));
    const retain = new Set(this.state.reservations.map(r => r.attemptId));
    for (const task of this.state.tasks) {
      if (task.attemptId) retain.add(task.attemptId);
      for (const attempt of this.state.attempts.filter(a => a.taskId === task.id).slice(-10)) retain.add(attempt.id);
    }
    this.state.attempts = this.state.attempts.filter(a => retain.has(a.id) || activeAttempts.has(a.state) || (a.state === 'uncertain' && !a.finishedAt));
  }
}
export function createFleetController(options: FleetControllerOptions): FleetController { return new FleetController(options); }
