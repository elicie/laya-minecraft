import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
]));
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export const IdSchema = z.string().min(1).max(160);
const time = z.number().int().nonnegative();
export const PositionSchema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
export type Position = z.infer<typeof PositionSchema>;
export const ItemStackSchema = z.object({ name: z.string().min(1).max(100), count: z.number().int().nonnegative() }).strict();
export type ItemStack = z.infer<typeof ItemStackSchema>;
export const ContainerRefSchema = z.object({ id: IdSchema, position: PositionSchema, world: z.string().min(1), dimension: z.string().min(1) }).strict();
export type ContainerRef = z.infer<typeof ContainerRefSchema>;

export const ActionKindSchema = z.enum(['collect', 'store', 'take', 'craft', 'smelt', 'build', 'farm', 'hunt', 'fight', 'guard', 'explore', 'follow', 'home', 'sleep', 'recover', 'survive', 'breed']);
export type ActionKind = z.infer<typeof ActionKindSchema>;
export const ACTION_KINDS = ActionKindSchema.options;
export const ExecutionModeSchema = z.enum(['queued', 'immediate']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export const ConnectionSchema = z.object({ host: z.string().min(1).max(255).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(25566), version: z.string().min(1).optional(), auth: z.enum(['offline', 'microsoft']).default('offline') }).strict();
export type Connection = z.infer<typeof ConnectionSchema>;
export const BotInputSchema = z.object({ id: IdSchema.optional(), name: z.string().regex(/^[A-Za-z0-9_]{3,16}$/, 'Minecraft name must be 3–16 letters, digits or underscores'), role: z.string().min(1).max(40).default('general'), enabled: z.boolean().default(true), allowedActions: z.array(ActionKindSchema).max(32).default([...ACTION_KINDS]), connection: ConnectionSchema.default({ host: '127.0.0.1', port: 25566, auth: 'offline' }) }).strict();
export type BotInput = z.input<typeof BotInputSchema>;
export type BotConfig = Omit<z.output<typeof BotInputSchema>, 'id'>;
export const ConnectionPatchSchema = z.object({ host: ConnectionSchema.shape.host.removeDefault().optional(), port: ConnectionSchema.shape.port.removeDefault().optional(), version: ConnectionSchema.shape.version, auth: ConnectionSchema.shape.auth.removeDefault().optional() }).strict();
export const BotPatchSchema = z.object({ name: BotInputSchema.shape.name.optional(), role: z.string().min(1).max(40).optional(), enabled: z.boolean().optional(), allowedActions: z.array(ActionKindSchema).max(32).optional(), connection: ConnectionPatchSchema.optional() }).strict();
export type BotPatch = z.infer<typeof BotPatchSchema>;

export const RulesSchema = z.object({
  version: z.number().int().positive().default(1),
  world: z.string().min(1).default('127.0.0.1:25566'), dimension: z.string().min(1).default('overworld'),
  center: PositionSchema.nullable().default(null), radius: z.number().min(1).max(10000).default(64),
  warehouse: ContainerRefSchema.nullable().default(null),
  maxRetries: z.number().int().min(0).max(5).default(5),
  statusIntervalMs: z.number().int().min(250).max(10000).default(1000),
  statusTimeoutMs: z.number().int().min(1000).max(60000).default(10000),
  observationMaxAgeMs: z.number().int().min(1000).max(300000).default(30000),
  logRetentionDays: z.number().int().min(1).max(365).default(30),
  autonomyEnabled: z.boolean().default(true),
  developmentStock: z.array(z.object({ item: z.string().min(1), quantity: z.number().int().min(1).max(1000000) }).strict()).default([{ item: 'bread', quantity: 16 }, { item: 'oak_log', quantity: 32 }]),
  combat: z.object({ proactiveRoles: z.array(z.string()).default(['guard', 'hunter']), counterattackWhenAttacked: z.boolean().default(true), retreatHealth: z.number().min(1).max(20).default(6), supportHealth: z.number().min(1).max(20).default(10), enemyRatioLimit: z.number().min(1).max(10).default(2), protectPlayers: z.boolean().default(true) }).strict().default({ proactiveRoles: ['guard', 'hunter'], counterattackWhenAttacked: true, retreatHealth: 6, supportHealth: 10, enemyRatioLimit: 2, protectPlayers: true }),
}).strict();
export type Rules = z.infer<typeof RulesSchema>;
export type RulesPatch = Omit<Partial<Omit<Rules, 'version'>>, 'combat'> & { combat?: Partial<Rules['combat']> };
const combatPatchShape = Object.fromEntries(Object.entries(RulesSchema.shape.combat.removeDefault().shape).map(([key, schema]) => [key, schema.removeDefault().optional()]));
const rulesPatchShape = Object.fromEntries(Object.entries(RulesSchema.omit({ version: true }).shape).map(([key, schema]) => [key, key === 'combat' ? z.object(combatPatchShape).strict().optional() : schema.removeDefault().optional()]));
export const RulesPatchSchema = z.object(rulesPatchShape).strict() as z.ZodType<RulesPatch>;
export const DEFAULT_RULES: Rules = RulesSchema.parse({});

export const GoalInputSchema = z.object({
  kind: ActionKindSchema, item: z.string().min(1).max(100).optional(), quantity: z.number().int().min(1).max(1000000).default(1),
  quantityMode: z.enum(['total', 'additional']).default('total'), mode: z.enum(['once', 'maintain']).default('once'),
  destination: ContainerRefSchema.optional(), preferredBotId: IdSchema.optional(), executionMode: ExecutionModeSchema.default('queued'),
  params: JsonObjectSchema.default({}), source: z.enum(['user', 'autonomous']).default('user'),
  title: z.string().min(1).max(500).optional(), priority: z.number().int().min(0).max(100).default(50),
}).strict().superRefine((g, ctx) => {
  if (['collect', 'store', 'take', 'craft', 'smelt'].includes(g.kind) && !g.item) ctx.addIssue({ code: 'custom', path: ['item'], message: 'An item is required for quantity tasks' });
  if (g.mode === 'maintain' && g.quantityMode === 'additional') ctx.addIssue({ code: 'custom', path: ['quantityMode'], message: 'Maintain goals require a fixed total quantity' });
});
export type GoalInput = z.input<typeof GoalInputSchema>;
export type GoalDefinition = z.output<typeof GoalInputSchema>;
// A supplied params object replaces the previous object; omission preserves it.
// This allows changing a fixed build origin back to nearby site selection.
export const GoalPatchSchema = z.object({ title: z.string().min(1).max(500).optional(), quantity: z.number().int().min(1).max(1000000).optional(), priority: z.number().int().min(0).max(100).optional(), preferredBotId: IdSchema.nullable().optional(), mode: z.enum(['once', 'maintain']).optional(), params: JsonObjectSchema.optional() }).strict();
export type GoalPatch = z.infer<typeof GoalPatchSchema>;
export interface GoalPreview { request: string; goals: GoalDefinition[]; warnings: string[]; source: 'code' | 'laya' | 'qwen'; }
export interface Interpretation { goal: GoalDefinition; source: 'qwen' | 'code'; warnings: string[]; }

export const ExpectedBlockSchema = z.object({ position: PositionSchema, name: z.string().min(1) }).strict();
export type ExpectedBlock = z.infer<typeof ExpectedBlockSchema>;
const BlockPositionSchema = PositionSchema.refine(p => Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z), 'Integer block coordinates are required');
export const BuildSiteSchema = z.object({ origin: BlockPositionSchema, design: z.string().min(1), entrance: BlockPositionSchema, observedAt: time }).strict();
export type BuildSite = z.infer<typeof BuildSiteSchema>;
export const BuildWaitingForSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('blocks'), causeCode: z.enum(['BUILD_SUPPORT', 'BUILD_SITE', 'BUILD_ACCESS', 'BUILD_OBSERVATION']), positions: z.array(BlockPositionSchema).min(1).max(10000), watchPosition: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('inventory'), causeCode: z.literal('BUILD_MATERIAL'), item: z.string().min(1), minimum: z.number().int().positive(), watchPosition: z.boolean().optional(), resourceNames: z.array(z.string().min(1)).max(100).optional() }).strict(),
]);
export type BuildWaitingFor = z.infer<typeof BuildWaitingForSchema>;
export const BuildWaitStateSchema = z.object({ waitingFor: BuildWaitingForSchema.optional(), botId: IdSchema, sessionId: IdSchema, fingerprint: z.string(), repeatCount: z.number().int().nonnegative() }).strict();
export type BuildWaitState = z.infer<typeof BuildWaitStateSchema>;
export function isBuildSiteAir(name: string): boolean { return ['air', 'cave_air', 'void_air'].includes(name); }
// Deliberately conservative: movable sand/gravel, leaves, liquids, hazards and
// existing constructed facilities are not suitable proof of a safe vacant site.
export function isBuildSiteGround(name: string): boolean {
  return ['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'sandstone', 'red_sandstone', 'clay', 'terracotta', 'snow_block', 'end_stone', 'netherrack'].includes(name) || /^[a-z]+_terracotta$/.test(name);
}
export interface BuildSiteCell { position: Position; requirement: 'air' | 'ground'; }
export function buildSiteCells(origin: Position, width: number, depth: number, height: number): BuildSiteCell[] {
  if (![origin.x, origin.y, origin.z, width, depth, height].every(Number.isInteger) || width < 1 || depth < 1 || height < 0 || width > 32 || depth > 32 || height > 32) throw new Error('Invalid build site bounds');
  const cells: BuildSiteCell[] = [];
  for (let x = -1; x <= width; x++) for (let z = -1; z <= depth; z++) {
    cells.push({ position: { x: origin.x + x, y: origin.y - 1, z: origin.z + z }, requirement: 'ground' });
    const inside = x >= 0 && x < width && z >= 0 && z < depth;
    for (let y = 0; y <= (inside ? height : 1); y++) cells.push({ position: { x: origin.x + x, y: origin.y + y, z: origin.z + z }, requirement: 'air' });
  }
  return cells;
}
export const CompletionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inventory'), item: z.string().min(1), minimum: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('container'), container: ContainerRefSchema, item: z.string().min(1), minimum: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('transfer'), container: ContainerRefSchema, item: z.string().min(1), quantity: z.number().int().positive(), direction: z.enum(['store', 'take']) }).strict(),
  z.object({ kind: z.literal('blocks'), blocks: z.array(ExpectedBlockSchema).min(1).max(10000) }).strict(),
  z.object({ kind: z.literal('entity-death'), targetName: z.string().optional(), minimum: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('position'), position: PositionSchema, radius: z.number().min(0).max(128) }).strict(),
  z.object({ kind: z.literal('farm'), crop: z.string().optional(), plots: z.number().int().positive(), mode: z.enum(['setup', 'harvest']), quantity: z.number().int().nonnegative().optional(), baseline: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal('exploration'), resourceNames: z.array(z.string()).default([]), minVisits: z.number().int().positive().default(1) }).strict(),
  z.object({ kind: z.literal('breeding'), animal: z.string().optional(), minimum: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('sleep') }).strict(),
  z.object({ kind: z.literal('continuous'), action: ActionKindSchema }).strict(),
  z.object({ kind: z.literal('manual'), reason: z.string().min(1) }).strict(),
]);
export type CompletionCondition = z.infer<typeof CompletionSchema>;
export interface TaskSpec { id: string; goalId: string; kind: ActionKind; source?: 'user' | 'autonomous'; params: JsonObject; dependencies: string[]; completion: CompletionCondition; reservationKeys: string[]; affinityBotId?: string; }
export const TaskSpecSchema = z.object({ id: IdSchema, goalId: IdSchema, kind: ActionKindSchema, source: z.enum(['user', 'autonomous']).optional(), params: JsonObjectSchema, dependencies: z.array(IdSchema), completion: CompletionSchema, reservationKeys: z.array(z.string()), affinityBotId: IdSchema.optional() }).strict();

const observationBase = { id: IdSchema, observedAt: time, world: z.string().min(1), dimension: z.string().min(1) };
export const ObservationInputSchema = z.discriminatedUnion('kind', [
  z.object({ ...observationBase, kind: z.literal('inventory'), data: z.object({ items: z.array(ItemStackSchema), position: PositionSchema.optional() }).strict() }).strict(),
  z.object({ ...observationBase, kind: z.literal('container'), data: z.object({ container: ContainerRefSchema, items: z.array(ItemStackSchema) }).strict() }).strict(),
  z.object({ ...observationBase, kind: z.literal('blocks'), data: z.object({ blocks: z.array(ExpectedBlockSchema).max(10000) }).strict() }).strict(),
  z.object({ ...observationBase, kind: z.literal('entity-death'), data: z.object({ entityId: IdSchema, entityName: z.string().min(1), position: PositionSchema.optional() }).strict() }).strict(),
  z.object({ ...observationBase, kind: z.literal('position'), data: z.object({ position: PositionSchema }).strict() }).strict(),
  z.object({ ...observationBase, kind: z.literal('farm'), data: z.object({ id: IdSchema, crop: z.string().min(1), plots: z.number().int().nonnegative(), planted: z.number().int().nonnegative(), watered: z.number().int().nonnegative(), ripe: z.number().int().nonnegative(), harvested: z.number().int().nonnegative().default(0) }).strict() }).strict(),
  z.object({ ...observationBase, kind: z.literal('breeding'), data: z.object({ animal: z.string().min(1), entityId: IdSchema, position: PositionSchema.optional() }).strict() }).strict(),
  z.object({ ...observationBase, kind: z.literal('exploration'), data: z.object({ position: PositionSchema, resources: z.array(ExpectedBlockSchema) }).strict() }).strict(),
  z.object({ ...observationBase, kind: z.literal('sleep'), data: z.object({ isSleeping: z.boolean() }).strict() }).strict(),
]);
export type ObservationInput = z.infer<typeof ObservationInputSchema>;
export type Observation = ObservationInput & { botId: string; sessionId: string; receivedAt: number; attemptId?: string; controllerEpoch: string };
export const TransferEvidenceSchema = z.object({ kind: z.literal('transfer'), container: ContainerRefSchema, item: z.string().min(1), quantity: z.number().int().positive(), direction: z.enum(['store', 'take']), beforeInventory: z.number().int().nonnegative(), afterInventory: z.number().int().nonnegative(), beforeContainer: z.number().int().nonnegative(), afterContainer: z.number().int().nonnegative() }).strict();
export type TransferEvidence = z.infer<typeof TransferEvidenceSchema>;
export const EvidenceSchema = TransferEvidenceSchema;
export type Evidence = z.infer<typeof EvidenceSchema>;
export const OutcomeSchema = z.enum(['completed', 'partial', 'condition-wait', 'failed', 'uncertain']);
export type Outcome = z.infer<typeof OutcomeSchema>;
export const ErrorInfoSchema = z.object({ code: z.string().min(1), message: z.string().min(1), retryable: z.boolean(), effectsKnown: z.boolean().default(false) }).strict();
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;
export const ResultPayloadSchema = z.object({ outcome: OutcomeSchema, observations: z.array(ObservationInputSchema).default([]), evidence: z.array(EvidenceSchema).default([]), checkpoint: JsonObjectSchema.default({}), error: ErrorInfoSchema.optional(), reason: z.string().optional() }).strict();
export type ResultPayload = z.infer<typeof ResultPayloadSchema>;
export const BotReportSchema = z.object({ ready: z.boolean(), position: PositionSchema.optional(), world: z.string().min(1), dimension: z.string().min(1), health: z.number().min(0).max(20), food: z.number().min(0).max(20), inventory: z.array(ItemStackSchema), action: z.string(), reason: z.string(), mode: z.enum(['idle', 'working', 'emergency', 'survival', 'paused', 'stopping']), capabilities: z.array(ActionKindSchema), currentAttemptId: IdSchema.optional(), rulesVersion: z.number().int().nonnegative(), viewerReady: z.boolean().optional() }).strict();
export type BotReport = z.infer<typeof BotReportSchema>;

const envelopeBase = { protocolVersion: z.literal(PROTOCOL_VERSION), messageId: IdSchema, controllerEpoch: IdSchema, botId: IdSchema, sessionId: IdSchema, sentAt: time, commandId: IdSchema.optional() };
const taskEnvelope = { ...envelopeBase, taskId: IdSchema, attemptId: IdSchema };
const empty = z.object({}).strict();
export const CentralMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...taskEnvelope, type: z.literal('task.assign'), payload: z.object({ task: TaskSpecSchema, checkpoint: JsonObjectSchema, rulesVersion: z.number().int().positive() }).strict() }).strict(),
  z.object({ ...taskEnvelope, type: z.literal('task.cancel'), payload: z.object({ reason: z.string(), preserveProgress: z.boolean() }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('rules.update'), payload: z.object({ rules: RulesSchema, config: BotInputSchema.omit({ id: true }), mode: ExecutionModeSchema }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('bot.shutdown'), payload: z.object({ reason: z.string() }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('viewer.start'), payload: z.object({ port: z.number().int().min(1024).max(65535), prefix: z.string().startsWith('/') }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('viewer.stop'), payload: empty }).strict(),
]);
export type CentralMessage = z.infer<typeof CentralMessageSchema>;
export const WorkerLaunchSchema = z.object({ botId: IdSchema, sessionId: IdSchema, controllerEpoch: IdSchema, config: BotInputSchema.omit({ id: true }), rules: RulesSchema }).strict();
export type WorkerLaunch = z.infer<typeof WorkerLaunchSchema>;
const stoppedPayload = z.object({ safeStopped: z.boolean(), observations: z.array(ObservationInputSchema).default([]), evidence: z.array(EvidenceSchema).default([]), checkpoint: JsonObjectSchema.default({}), reason: z.string().optional() }).strict();
export const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...envelopeBase, type: z.literal('bot.ready'), payload: BotReportSchema }).strict(),
  z.object({ ...envelopeBase, type: z.literal('bot.status'), payload: BotReportSchema }).strict(),
  z.object({ ...taskEnvelope, type: z.literal('task.accepted'), payload: empty }).strict(),
  z.object({ ...taskEnvelope, type: z.literal('task.started'), payload: empty }).strict(),
  z.object({ ...taskEnvelope, type: z.literal('task.rejected'), payload: z.object({ reason: z.string(), retryable: z.boolean().default(false) }).strict() }).strict(),
  z.object({ ...taskEnvelope, type: z.literal('task.progress'), payload: z.object({ progress: z.number().min(0).max(1).optional(), action: z.string(), reason: z.string(), checkpoint: JsonObjectSchema.default({}), observations: z.array(ObservationInputSchema).default([]) }).strict() }).strict(),
  z.object({ ...taskEnvelope, type: z.literal('task.result'), payload: ResultPayloadSchema }).strict(),
  z.object({ ...taskEnvelope, type: z.literal('task.cancelled'), payload: stoppedPayload }).strict(),
  z.object({ ...taskEnvelope, type: z.literal('task.interrupted'), payload: stoppedPayload.extend({ reason: z.string().min(1) }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('world.observed'), payload: z.object({ observations: z.array(ObservationInputSchema).max(1000) }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('safety.alert'), payload: z.object({ response: z.enum(['attack', 'defend', 'support', 'retreat']), reason: z.string(), supportRequired: z.boolean(), threats: z.array(JsonObjectSchema).default([]) }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('rules.applied'), payload: z.object({ version: z.number().int().positive() }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('bot.stopped'), payload: z.object({ reason: z.string() }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('bot.error'), payload: ErrorInfoSchema }).strict(),
  z.object({ ...envelopeBase, type: z.literal('viewer.ready'), payload: z.object({ port: z.number().int().min(1024).max(65535), prefix: z.string().startsWith('/') }).strict() }).strict(),
  z.object({ ...envelopeBase, type: z.literal('viewer.stopped'), payload: empty }).strict(),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

export type GoalState = 'queued' | 'active' | 'condition-wait' | 'maintaining' | 'completed' | 'cancelling' | 'cancelled' | 'held';
export interface Goal { id: string; input: GoalDefinition; title: string; state: GoalState; targetQuantity?: number; taskIds: string[]; createdAt: number; updatedAt: number; reason?: string; progress: { current: number; target?: number }; generation: number; nextRunAt?: number; replanRequested?: boolean; }
export type TaskState = 'waiting' | 'assigned' | 'accepted' | 'running' | 'verifying' | 'completed' | 'condition-wait' | 'interrupted' | 'retry-wait' | 'cancelling' | 'cancelled' | 'held';
export interface Task extends TaskSpec { generation: number; state: TaskState; attemptId?: string; retryCount: number; resumeCount: number; checkpoint: JsonObject; progress: number; reason?: string; createdAt: number; updatedAt: number; retryAt?: number; blockedByGoalId?: string; waitState?: BuildWaitState; }
export interface TaskAttempt { id: string; taskId: string; botId: string; sessionId: string; controllerEpoch: string; reason: 'initial' | 'retry' | 'resume'; state: 'assigned' | 'accepted' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'interrupted' | 'failed' | 'uncertain'; startedAt?: number; assignedAt: number; finishedAt?: number; result?: ResultPayload; }
export interface Reservation { key: string; taskId: string; attemptId: string; botId: string; sessionId: string; acquiredAt: number; }
export interface AgentSession { id: string; state: 'starting' | 'ready' | 'abnormal' | 'stopped'; lastReportAt: number; report?: BotReport; activeAttemptId?: string; rulesVersion: number; pendingRulesVersion?: number; }
export interface Agent { id: string; config: BotConfig; desiredConfig?: BotConfig; pendingCommandIds: string[]; session?: AgentSession; status: 'registered' | 'connecting' | 'ready' | 'paused' | 'removing' | 'removed' | 'abnormal'; viewer: { state: 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed'; port?: number; prefix?: string }; createdAt: number; updatedAt: number; }
export interface CoreEvent { id: string; time: number; revision: number; type: string; commandId?: string; botId?: string; goalId?: string; taskId?: string; attemptId?: string; message: string; data?: JsonObject; }
export interface FleetSnapshot { schemaVersion: 1; controllerEpoch: string; revision: number; updatedAt: number; rules: Rules; agents: Agent[]; goals: Goal[]; tasks: Task[]; attempts: TaskAttempt[]; reservations: Reservation[]; observations: Observation[]; events: CoreEvent[]; }
export interface PendingRuleCommand { commandId: string; version: number; awaitingBotIds: string[]; expected?: JsonObject; }
export interface PendingCoreCommand { commandId: string; type: 'agent-update' | 'pause' | 'resume' | 'remove' | 'viewer-start' | 'viewer-stop' | 'goal-cancel' | 'goal-update'; targetId: string; expected?: JsonObject; }
export interface FleetCheckpoint extends FleetSnapshot { processedMessageIds: string[]; pendingRuleCommands: PendingRuleCommand[]; pendingCommands: PendingCoreCommand[]; stoppedSessionIds: string[]; }
export const CommandReceiptSchema = z.object({ id: IdSchema, type: z.string(), state: z.enum(['accepted', 'applying', 'applied', 'failed']), createdAt: time, updatedAt: time, result: JsonValueSchema.optional(), error: z.string().optional() }).strict();
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
export interface ApiError { error: { code: string; message: string; details?: JsonValue }; }

export const GoalSchema = z.object({ id: IdSchema, input: GoalInputSchema, title: z.string(), state: z.enum(['queued', 'active', 'condition-wait', 'maintaining', 'completed', 'cancelling', 'cancelled', 'held']), targetQuantity: z.number().int().nonnegative().optional(), taskIds: z.array(IdSchema), createdAt: time, updatedAt: time, reason: z.string().optional(), progress: z.object({ current: z.number().nonnegative(), target: z.number().nonnegative().optional() }).strict(), generation: z.number().int().nonnegative(), nextRunAt: time.optional(), replanRequested: z.boolean().optional() }).strict();
export const TaskSchema = TaskSpecSchema.extend({ generation: z.number().int().nonnegative(), state: z.enum(['waiting', 'assigned', 'accepted', 'running', 'verifying', 'completed', 'condition-wait', 'interrupted', 'retry-wait', 'cancelling', 'cancelled', 'held']), attemptId: IdSchema.optional(), retryCount: z.number().int().nonnegative(), resumeCount: z.number().int().nonnegative(), checkpoint: JsonObjectSchema, progress: z.number().min(0).max(1), reason: z.string().optional(), createdAt: time, updatedAt: time, retryAt: time.optional(), blockedByGoalId: IdSchema.optional(), waitState: BuildWaitStateSchema.optional() }).strict();
export const TaskAttemptSchema = z.object({ id: IdSchema, taskId: IdSchema, botId: IdSchema, sessionId: IdSchema, controllerEpoch: IdSchema, reason: z.enum(['initial', 'retry', 'resume']), state: z.enum(['assigned', 'accepted', 'running', 'cancelling', 'completed', 'cancelled', 'interrupted', 'failed', 'uncertain']), assignedAt: time, startedAt: time.optional(), finishedAt: time.optional(), result: ResultPayloadSchema.optional() }).strict();
export const ReservationSchema = z.object({ key: z.string(), taskId: IdSchema, attemptId: IdSchema, botId: IdSchema, sessionId: IdSchema, acquiredAt: time }).strict();
export const AgentSessionSchema = z.object({ id: IdSchema, state: z.enum(['starting', 'ready', 'abnormal', 'stopped']), lastReportAt: time, report: BotReportSchema.optional(), activeAttemptId: IdSchema.optional(), rulesVersion: z.number().int().nonnegative(), pendingRulesVersion: z.number().int().positive().optional() }).strict();
export const AgentSchema = z.object({ id: IdSchema, config: BotInputSchema.omit({ id: true }), desiredConfig: BotInputSchema.omit({ id: true }).optional(), pendingCommandIds: z.array(IdSchema), session: AgentSessionSchema.optional(), status: z.enum(['registered', 'connecting', 'ready', 'paused', 'removing', 'removed', 'abnormal']), viewer: z.object({ state: z.enum(['stopped', 'starting', 'ready', 'stopping', 'failed']), port: z.number().int().min(1024).max(65535).optional(), prefix: z.string().startsWith('/').optional() }).strict(), createdAt: time, updatedAt: time }).strict();
export const CoreEventSchema = z.object({ id: IdSchema, time, revision: z.number().int().nonnegative(), type: z.string(), commandId: IdSchema.optional(), botId: IdSchema.optional(), goalId: IdSchema.optional(), taskId: IdSchema.optional(), attemptId: IdSchema.optional(), message: z.string(), data: JsonObjectSchema.optional() }).strict();
// ObservationInput is strict at the wire boundary; the persisted form adds trusted envelope fields.
export const ObservationSchema = z.union(ObservationInputSchema.options.map(option => option.extend({ botId: IdSchema, sessionId: IdSchema, receivedAt: time, attemptId: IdSchema.optional(), controllerEpoch: IdSchema }))) as z.ZodType<Observation>;
export const FleetSnapshotSchema = z.object({ schemaVersion: z.literal(1), controllerEpoch: IdSchema, revision: z.number().int().nonnegative(), updatedAt: time, rules: RulesSchema, agents: z.array(AgentSchema), goals: z.array(GoalSchema), tasks: z.array(TaskSchema), attempts: z.array(TaskAttemptSchema), reservations: z.array(ReservationSchema), observations: z.array(ObservationSchema), events: z.array(CoreEventSchema) }).strict();
export const FleetCheckpointSchema = FleetSnapshotSchema.extend({ processedMessageIds: z.array(IdSchema), pendingRuleCommands: z.array(z.object({ commandId: IdSchema, version: z.number().int().positive(), awaitingBotIds: z.array(IdSchema), expected: JsonObjectSchema.optional() }).strict()), pendingCommands: z.array(z.object({ commandId: IdSchema, type: z.enum(['agent-update', 'pause', 'resume', 'remove', 'viewer-start', 'viewer-stop', 'goal-cancel', 'goal-update']), targetId: IdSchema, expected: JsonObjectSchema.optional() }).strict()).default([]), stoppedSessionIds: z.array(IdSchema).default([]) }).strict();

export function itemCount(items: readonly ItemStack[], item: string): number { return items.reduce((total, stack) => total + (stack.name === item ? stack.count : 0), 0); }
export function sameContainer(a: ContainerRef, b: ContainerRef): boolean { return a.id === b.id && a.world === b.world && a.dimension === b.dimension && a.position.x === b.position.x && a.position.y === b.position.y && a.position.z === b.position.z; }
export function parseWorkerMessage(value: unknown): WorkerMessage { return WorkerMessageSchema.parse(value); }
export function parseCentralMessage(value: unknown): CentralMessage { return CentralMessageSchema.parse(value); }
