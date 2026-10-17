import { BuildWaitingForSchema, type Agent, type BuildWaitingFor, type FleetSnapshot, type JsonObject, type Observation, type RecoveryState, type SurvivalRecovery, type Task } from '../../contracts/src';

function pick(value: JsonObject | undefined, keys: readonly string[]): JsonObject {
  if (!value) return {};
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]!])) as JsonObject;
}
const object = (value: unknown): JsonObject | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
function waitingFor(value: BuildWaitingFor): BuildWaitingFor {
  if (value.kind === 'blocks') return { ...value, positions: value.positions.slice(0, 16) };
  const { resourcePositions: _positions, ...condition } = value;
  return condition;
}
function taskView(task: Task): Task {
  const { waitState, checkpoint, params, reservationKeys: _keys, ...rest } = task;
  const display: JsonObject = {};
  const fields: Record<string, string[]> = {
    build: ['placed'], buildRemaining: ['count'],
    preparationProgress: ['stage', 'completedEdits', 'totalEdits', 'excavated', 'filled', 'pathIndex', 'pathLength'],
    accessPreparationProgress: ['stage', 'completedEdits', 'totalEdits', 'excavated', 'filled', 'pathIndex', 'pathLength'],
    buildMaterial: ['item', 'minimum', 'current', 'remaining'],
    buildPreflight: ['status', 'total', 'slots', 'materials'],
  };
  for (const [key, keys] of Object.entries(fields)) if (object(checkpoint[key])) display[key] = pick(object(checkpoint[key]), keys);
  const condition = waitState?.waitingFor ?? checkpoint.waitingFor;
  const parsedCondition = BuildWaitingForSchema.safeParse(condition);
  if (parsedCondition.success) display.waitingFor = waitingFor(parsedCondition.data) as unknown as JsonObject;
  return { ...rest, params: pick(params, ['mode', 'design', 'blueprint', 'blueprintDefinition', 'item', 'quantity', 'origin', 'position', 'destination', 'container', 'crop', 'targetName', 'requesterBotId', 'supportRequestId', 'expiresAt']), checkpoint: display, reservationKeys: [] };
}
function recovery(value: RecoveryState | undefined): RecoveryState | undefined {
  return value ? { ...value, checkpoint: {} } : undefined;
}
function survival(value: SurvivalRecovery | undefined): SurvivalRecovery | undefined {
  return value ? { startedAt: value.startedAt, targetHealth: value.targetHealth, checkpoint: {} } : undefined;
}
function agentView(agent: Agent): Agent {
  return { ...agent, ...(agent.recovery ? { recovery: recovery(agent.recovery) } : {}), ...(agent.survivalRecovery ? { survivalRecovery: survival(agent.survivalRecovery) } : {}),
    ...(agent.session ? { session: { ...agent.session, ...(agent.session.report ? { report: { ...agent.session.report,
      ...(agent.session.report.recovery ? { recovery: recovery(agent.session.report.recovery) } : {}),
      ...(agent.session.report.survivalRecovery ? { survivalRecovery: survival(agent.session.report.survivalRecovery) } : {}),
    } } : {}) } } : {}) };
}
function mapObservations(snapshot: FleetSnapshot, now: number): Observation[] {
  const fresh = snapshot.observations.filter(o => o.world === snapshot.rules.world && o.dimension === snapshot.rules.dimension && now - o.observedAt <= snapshot.rules.observationMaxAgeMs && o.observedAt <= now + 1000)
    .sort((a, b) => b.observedAt - a.observedAt || b.receivedAt - a.receivedAt);
  const cells = new Set<string>(), other = new Set<string>(), result: Observation[] = [];
  for (const observation of fresh) {
    if (observation.kind === 'blocks' || observation.kind === 'exploration') {
      const values = observation.kind === 'blocks' ? observation.data.blocks : observation.data.resources;
      const selected = values.slice().reverse().filter(block => {
        const p = block.position, key = `${observation.world}:${observation.dimension}:${p.x},${p.y},${p.z}`;
        if (cells.size >= 1200 || cells.has(key)) return false;
        cells.add(key); return true;
      }).reverse();
      if (observation.kind === 'blocks') { if (selected.length) result.push({ ...observation, data: { blocks: selected } }); }
      else result.push({ ...observation, data: { ...observation.data, resources: selected } });
    } else {
      const suffix = observation.kind === 'container' ? `${observation.data.container.id}:${JSON.stringify(observation.data.container.position)}` : observation.botId;
      const key = `${observation.world}:${observation.dimension}:${observation.kind}:${suffix}`;
      if (other.has(key) || other.size >= 100) continue;
      other.add(key); result.push(observation);
    }
    if (result.length >= 300) break;
  }
  return result.reverse();
}

/** A read-only display projection. Durable evidence and the full API stay intact. */
export function dashboardSnapshot(snapshot: FleetSnapshot, now = Date.now()): FleetSnapshot {
  return { ...snapshot, agents: snapshot.agents.map(agentView), tasks: snapshot.tasks.map(taskView),
    attempts: snapshot.attempts.map(({ result: _result, ...attempt }) => attempt), reservations: [],
    observations: mapObservations(snapshot, now), events: snapshot.events.slice(-200).map(({ data: _data, ...event }) => event) };
}
