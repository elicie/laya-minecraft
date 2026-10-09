import { randomUUID } from 'node:crypto';
import {
  BotInputSchema, BotPatchSchema, DEFAULT_RULES, GoalInputSchema, GoalPatchSchema, PROTOCOL_VERSION, RulesPatchSchema, RulesSchema, WorkerMessageSchema,
  itemCount, sameContainer,
  type Agent, type BotInput, type BotPatch, type CentralMessage, type CoreEvent, type ExecutionMode, type FleetCheckpoint, type FleetSnapshot,
  type Goal, type GoalInput, type GoalPatch, type JsonObject, type Observation, type ObservationInput, type ResultPayload,
  type Rules, type RulesPatch, type Task, type TaskAttempt, type WorkerMessage,
} from '../../contracts/src';
import { containerKey, goalTitle, jsonObject, planGoal, roleFits } from './planning';
import { footprintInside, freshObservations, verifyCompletion } from './verification';

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
const clone = <T>(value: T): T => structuredClone(value);
const taskSpec = (task: Task) => ({ id: task.id, goalId: task.goalId, kind: task.kind, params: task.params, dependencies: task.dependencies, completion: task.completion, reservationKeys: task.reservationKeys, ...(task.affinityBotId ? { affinityBotId: task.affinityBotId } : {}) });

export class FleetController {
  readonly controllerEpoch: string;
  private readonly now: () => number;
  private readonly options: FleetControllerOptions;
  private state: FleetCheckpoint;
  private messageIds: Set<string>;
  private ticking = false;
  private decisions = new Map<string, { token: string; sessionId: string; taskIds: string[]; requestedAt: number; abort: AbortController }>();

  constructor(options: FleetControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.controllerEpoch = options.controllerEpoch ?? randomUUID();
    this.state = options.checkpoint ? clone(options.checkpoint) : {
      schemaVersion: 1, controllerEpoch: this.controllerEpoch, revision: 0, updatedAt: this.now(), rules: RulesSchema.parse(options.rules ?? DEFAULT_RULES),
      agents: [], goals: [], tasks: [], attempts: [], reservations: [], observations: [], events: [], processedMessageIds: [], pendingRuleCommands: [], pendingCommands: [], stoppedSessionIds: [],
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
  private pending(commandId: string | undefined, type: FleetCheckpoint['pendingCommands'][number]['type'], targetId: string): void {
    if (commandId) this.state.pendingCommands.push({ commandId, type, targetId });
  }
  private finishCommands(targetId: string, types: FleetCheckpoint['pendingCommands'][number]['type'][]): void {
    for (const command of [...this.state.pendingCommands]) if (command.targetId === targetId && types.includes(command.type)) this.applied(command.commandId, { targetId });
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
    this.changed('bot.process-stopped', '실제 봇 프로세스 종료를 확인했습니다.', { botId, data: { sessionId } });
    this.tick();
  }
  updateAgent(botId: string, patch: BotPatch, mode: ExecutionMode = 'queued', commandId?: string): Agent {
    const agent = this.agent(botId), parsed = BotPatchSchema.parse(patch);
    const desired = BotInputSchema.omit({ id: true }).parse({ ...(agent.desiredConfig ?? agent.config), ...parsed });
    if (desired.name !== agent.config.name || JSON.stringify(desired.connection) !== JSON.stringify(agent.config.connection)) {
      if (agent.session && agent.session.state !== 'stopped') throw new Error('Name and connection changes require a stopped bot');
    }
    if (this.state.agents.some(a => a.id !== botId && a.status !== 'removed' && a.config.name === desired.name)) throw new Error('Minecraft name is already registered');
    agent.desiredConfig = desired;
    if (agent.session && agent.session.state !== 'stopped') this.state.rules = { ...this.state.rules, version: this.state.rules.version + 1 };
    agent.updatedAt = this.now();
    this.pending(commandId, 'agent-update', botId);
    if (mode === 'immediate' || !desired.enabled) this.cancelAgentAttempt(agent, '봇 설정 변경', true);
    this.changed('bot.config-requested', '봇 설정 변경을 예약했습니다.', { botId, commandId });
    this.applyAgentRules(agent, mode);
    return clone(agent);
  }
  pauseAgent(botId: string, commandId?: string): Agent { this.pending(commandId, 'pause', botId); return this.updateAgent(botId, { enabled: false }, 'immediate'); }
  resumeAgent(botId: string, commandId?: string): Agent { this.pending(commandId, 'resume', botId); return this.updateAgent(botId, { enabled: true }, 'queued'); }
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
    const parsed = RulesPatchSchema.parse(patch), rules = RulesSchema.parse({ ...this.state.rules, ...parsed, version: this.state.rules.version + 1 });
    if (rules.statusTimeoutMs <= rules.statusIntervalMs) throw new Error('Status timeout must exceed report interval');
    this.state.rules = rules;
    const awaiting = this.state.agents.filter(a => a.session && a.session.state !== 'stopped' && a.status !== 'removed').map(a => a.id);
    if (commandId && awaiting.length) this.state.pendingRuleCommands.push({ commandId, version: rules.version, awaitingBotIds: awaiting });
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
    if (['guard', 'follow', 'survive'].includes(definition.kind)) definition.mode = 'maintain';
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
    goal.input = GoalInputSchema.parse({ ...goal.input, ...parsed, preferredBotId: parsed.preferredBotId === null ? undefined : parsed.preferredBotId ?? goal.input.preferredBotId });
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
      if (!attempt || !task || task.attemptId !== attempt.id || attempt.botId !== agent.id || attempt.sessionId !== message.sessionId || attempt.controllerEpoch !== this.controllerEpoch || !activeAttempts.has(attempt.state)) return false;
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
      this.state.observations.push({ ...clone(input), botId: agent.id, sessionId: agent.session!.id, controllerEpoch: this.controllerEpoch, receivedAt: this.now(), ...(attemptId ? { attemptId } : {}) });
    }
    this.state.observations = this.state.observations.filter(o => this.now() - o.receivedAt <= Math.max(300000, this.state.rules.observationMaxAgeMs)).slice(-5000);
  }
  private handleMessage(agent: Agent, message: WorkerMessage): void {
    const session = agent.session!;
    switch (message.type) {
      case 'bot.ready': case 'bot.status': {
        session.lastReportAt = this.now(); session.report = clone(message.payload);
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
          if (!command.awaitingBotIds.length) { this.state.pendingRuleCommands = this.state.pendingRuleCommands.filter(c => c !== command); this.applied(command.commandId, { version: session.rulesVersion }); }
        }
        this.changed('rules.applied', '봇이 규칙을 실제 적용했습니다.', { botId: agent.id, data: { version: session.rulesVersion } });
        return;
      }
      case 'world.observed': this.observe(agent, message.payload.observations); this.changed('world.observed', '실제 월드 관측을 반영했습니다.', { botId: agent.id }, false); return;
      case 'viewer.ready':
        if (agent.viewer.state !== 'starting' || agent.viewer.port !== message.payload.port || agent.viewer.prefix !== message.payload.prefix) return;
        agent.viewer = { state: 'ready', ...message.payload }; this.finishCommands(agent.id, ['viewer-start']); this.changed('viewer.ready', '3D 화면 연결을 확인했습니다.', { botId: agent.id }); return;
      case 'viewer.stopped': agent.viewer = { state: 'stopped' }; this.finishCommands(agent.id, ['viewer-stop']); this.changed('viewer.stopped', '3D 화면 종료를 확인했습니다.', { botId: agent.id }); return;
      case 'safety.alert': session.report && (session.report.mode = 'emergency'); this.changed('safety.alert', message.payload.reason, { botId: agent.id, data: jsonObject(message.payload) }); return;
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
    const agent = this.state.agents.find(a => a.id === attempt.botId);
    return verifyCompletion(task.completion, { observations: this.state.observations, evidence, now: this.now(), maxAgeMs: this.state.rules.observationMaxAgeMs, world: agent?.session?.report?.world ?? this.state.rules.world, dimension: agent?.session?.report?.dimension ?? this.state.rules.dimension, botId: attempt.botId, sessionId: attempt.sessionId, attemptId: attempt.id, notBefore: attempt.assignedAt });
  }
  private finishResult(agent: Agent, task: Task, attempt: TaskAttempt, result: ResultPayload): void {
    this.observe(agent, result.observations, attempt.id);
    task.state = 'verifying'; task.checkpoint = clone(result.checkpoint); attempt.result = clone(result);
    const verification = this.verify(task, attempt, result.evidence);
    attempt.finishedAt = this.now(); agent.session!.activeAttemptId = undefined;
    if (verification.complete) { this.release(attempt.id); this.completeTask(task, attempt); }
    else if (this.goal(task.goalId).state === 'cancelling') { task.state = 'cancelled'; attempt.state = 'cancelled'; this.release(attempt.id); }
    else if (result.outcome === 'uncertain' || (result.outcome === 'completed' && task.completion.kind !== 'continuous') || (result.outcome === 'failed' && !result.error?.effectsKnown)) {
      task.state = 'held'; attempt.state = 'uncertain'; task.reason = result.reason ?? result.error?.message ?? verification.reason;
    } else if (result.outcome === 'failed') {
      attempt.state = 'failed'; this.release(attempt.id);
      if (result.error?.retryable && task.retryCount < this.state.rules.maxRetries) { task.retryCount++; task.state = 'retry-wait'; task.retryAt = this.now() + Math.min(30000, 1000 * 2 ** (task.retryCount - 1)); task.reason = result.error.message; }
      else { task.state = 'held'; task.reason = result.error?.message ?? '허용된 재시도 횟수를 모두 사용했습니다.'; }
    } else {
      attempt.state = 'interrupted'; this.release(attempt.id); this.reducePartialTransfer(task, attempt, result.evidence);
      task.state = 'condition-wait'; task.retryAt = this.now() + 5000; task.resumeCount++; task.reason = result.reason ?? verification.reason;
    }
    task.updatedAt = this.now();
    this.changed(verification.complete ? 'task.completed' : `task.${task.state}`, task.reason ?? '실제 결과를 검증했습니다.', { taskId: task.id, attemptId: attempt.id, botId: agent.id });
    if (agent.status === 'removing') this.send(agent, 'bot.shutdown', { reason: '작업 종료 후 봇 제거' }); else this.applyAgentRules(agent);
    this.finishGoalCancellation(this.goal(task.goalId));
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
    let tasks = this.currentTasks(goal), stock = this.warehouseCount(goal);
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
      this.invalidatePlan(goal, '실제 월드를 확인하고 남은 작업을 자동 재개합니다.'); tasks = [];
    }
    const goalEdit = this.state.pendingCommands.some(c => c.targetId === goal.id && c.type === 'goal-update');
    if (goalEdit && !tasks.some(t => this.taskHasActor(t))) { this.invalidatePlan(goal, '수정한 목표를 재계획합니다.'); tasks = []; this.finishCommands(goal.id, ['goal-update']); }
    if (tasks.some(t => t.state === 'held')) { goal.state = 'held'; goal.reason = tasks.find(t => t.state === 'held')?.reason; return; }
    if (tasks.length && tasks.every(t => t.state === 'completed' || t.state === 'cancelled')) {
      if (isStockGoal(goal) && stock === undefined) { goal.state = 'condition-wait'; goal.reason = '최종 창고 재고 관측이 필요합니다.'; return; }
      const ongoing = goal.input.mode === 'maintain' || ['guard', 'follow', 'survive'].includes(goal.input.kind);
      if (!isStockGoal(goal) && !ongoing) {
        goal.state = 'completed'; goal.progress.current = goal.input.quantity; goal.updatedAt = this.now();
        this.changed('goal.completed', '목표의 실제 결과를 확인했습니다.', { goalId: goal.id }); return;
      }
      this.invalidatePlan(goal, '다음 실행 주기를 준비합니다.'); tasks = [];
    }
    if (!tasks.length) {
      const plan = planGoal(goal, this.state.rules, randomUUID, stock);
      if (plan.waiting) { goal.state = 'condition-wait'; goal.reason = plan.waiting; return; }
      for (const spec of plan.tasks) {
        const task: Task = { ...spec, generation: goal.generation, state: 'waiting', retryCount: 0, resumeCount: 0, checkpoint: {}, progress: 0, createdAt: this.now(), updatedAt: this.now() };
        this.state.tasks.push(task); goal.taskIds.push(task.id);
      }
      if (plan.tasks.length) { goal.state = 'queued'; this.changed('goal.planned', '실행 단계와 선행 조건을 계획했습니다.', { goalId: goal.id, data: { tasks: plan.tasks.length } }); }
    }
  }
  private candidateTasks(agent: Agent): Task[] {
    if (!agent.config.enabled || agent.desiredConfig?.enabled === false || agent.status === 'removing' || agent.status === 'removed' || agent.session?.state !== 'ready' || !agent.session.report?.ready || agent.session.activeAttemptId || agent.session.rulesVersion !== this.state.rules.version || this.now() - agent.session.lastReportAt >= this.state.rules.statusTimeoutMs || ['emergency', 'survival', 'paused', 'stopping'].includes(agent.session.report.mode) || agent.session.report.health <= 0) return [];
    const pinned = this.state.tasks.some(t => t.affinityBotId === agent.id && t.state !== 'completed' && t.state !== 'cancelled' && t.generation === this.goal(t.goalId).generation && !terminalGoals.has(this.goal(t.goalId).state) && (!t.blockedByGoalId || terminalGoals.has(this.goal(t.blockedByGoalId).state)));
    return this.state.tasks.filter(task => {
      const goal = this.goal(task.goalId);
      if (!runnable.has(task.state) || task.generation !== goal.generation || terminalGoals.has(goal.state) || goal.state === 'cancelling' || goal.state === 'held' || (task.retryAt ?? 0) > this.now()) return false;
      if (task.blockedByGoalId && !terminalGoals.has(this.goal(task.blockedByGoalId).state)) return false;
      if (task.affinityBotId && task.affinityBotId !== agent.id) return false;
      if (pinned && task.affinityBotId !== agent.id) return false;
      if (!task.dependencies.every(id => this.state.tasks.find(t => t.id === id)?.state === 'completed')) return false;
      if (!agent.config.allowedActions.includes(task.kind) || !agent.session!.report!.capabilities.includes(task.kind)) return false;
      if (task.reservationKeys.some(key => this.state.reservations.some(r => r.key === key && r.attemptId !== task.attemptId))) return false;
      if (agent.session!.report!.world !== this.state.rules.world || agent.session!.report!.dimension !== this.state.rules.dimension) return false;
      if (goal.input.source === 'autonomous' && task.completion.kind === 'blocks' && (!this.state.rules.center || !footprintInside(this.state.rules.center, this.state.rules.radius, task.completion.blocks))) return false;
      return true;
    }).sort((a, b) => this.taskPriority(b) - this.taskPriority(a) || Number(roleFits(agent.config.role, b.kind)) - Number(roleFits(agent.config.role, a.kind)) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  private taskPriority(task: Task): number {
    const goal = this.goal(task.goalId);
    return (goal.input.source === 'user' ? 1000 : 0) + goal.input.priority + (goal.input.executionMode === 'immediate' ? 200 : 0);
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
    if (task.kind === 'collect' && task.completion.kind === 'inventory') task.params.quantity = Math.max(0, task.completion.minimum - itemCount(agent.session!.report!.inventory, task.completion.item));
    const attempt: TaskAttempt = { id: randomUUID(), taskId: task.id, botId: agent.id, sessionId: agent.session!.id, controllerEpoch: this.controllerEpoch, reason: task.retryCount ? 'retry' : task.resumeCount ? 'resume' : 'initial', state: 'assigned', assignedAt: this.now() };
    this.state.attempts.push(attempt); task.attemptId = attempt.id; task.state = 'assigned'; task.updatedAt = this.now();
    agent.session!.activeAttemptId = attempt.id;
    for (const key of task.reservationKeys) this.state.reservations.push({ key, taskId: task.id, attemptId: attempt.id, botId: agent.id, sessionId: attempt.sessionId, acquiredAt: this.now() });
    this.goal(task.goalId).state = 'active';
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

  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const agent of this.state.agents) {
        if (agent.session?.state === 'ready' && this.now() - agent.session.lastReportAt >= this.state.rules.statusTimeoutMs) { agent.session.state = 'abnormal'; if (agent.status !== 'removing') agent.status = 'abnormal'; this.changed('bot.abnormal', '10초 이상 상태 보고가 없어 접속 이상으로 표시합니다.', { botId: agent.id }); }
        this.applyAgentRules(agent);
      }
      if (this.state.rules.autonomyEnabled && this.state.rules.center && this.state.rules.warehouse && this.state.agents.some(a => a.session?.state === 'ready' && a.config.enabled)) {
        for (const stock of this.state.rules.developmentStock) if (!this.state.goals.some(g => g.input.source === 'autonomous' && g.input.kind === 'collect' && g.input.item === stock.item && !terminalGoals.has(g.state))) {
          const input = GoalInputSchema.parse({ kind: 'collect', item: stock.item, quantity: stock.quantity, mode: 'maintain', source: 'autonomous', priority: 10 });
          const goal: Goal = { id: randomUUID(), input, title: goalTitle(input), state: 'queued', targetQuantity: stock.quantity, taskIds: [], createdAt: this.now(), updatedAt: this.now(), progress: { current: 0, target: stock.quantity }, generation: 0 };
          this.state.goals.push(goal); this.changed('goal.autonomous-created', '여유 봇을 위한 마을 재고 유지 목표를 추가했습니다.', { goalId: goal.id });
        }
      }
      for (const goal of [...this.state.goals]) this.reconcileAndPlan(goal);
      const agents = [...this.state.agents].sort((a, b) => Number(this.state.goals.some(g => g.input.preferredBotId === b.id && !terminalGoals.has(g.state))) - Number(this.state.goals.some(g => g.input.preferredBotId === a.id && !terminalGoals.has(g.state))) || a.createdAt - b.createdAt);
      for (const agent of agents) this.schedule(agent);
    } finally { this.ticking = false; }
  }
}
export function createFleetController(options: FleetControllerOptions): FleetController { return new FleetController(options); }
