import { PositionSchema, resourceNamesFor, type JsonObject } from '../../contracts/src';
import { ConditionWait, type ActionServices } from './services';

/** Keep acquisition evidence and bounded search budgets across executor wrappers. */
export function preserveMaterialWait(s: ActionServices, item: string, error: ConditionWait): ConditionWait {
  const source = error.checkpoint;
  const recovery = s.checkpoint.resourceRecovery && typeof s.checkpoint.resourceRecovery === 'object' && !Array.isArray(s.checkpoint.resourceRecovery) ? s.checkpoint.resourceRecovery : {};
  Object.assign(s.checkpoint, source);
  if (source.resourceRecovery && typeof source.resourceRecovery === 'object' && !Array.isArray(source.resourceRecovery)) s.checkpoint.resourceRecovery = { ...recovery, ...source.resourceRecovery };
  const missing = typeof source.missingResource === 'string' ? source.missingResource : typeof source.missingItem === 'string' ? source.missingItem : item;
  const minimum = typeof source.minimum === 'number' && Number.isInteger(source.minimum) && source.minimum > 0 ? source.minimum : 1;
  const resourceNames = resourceNamesFor(missing, Array.isArray(source.resourceNames) ? source.resourceNames.filter((name): name is string => typeof name === 'string') : []);
  const resourcePositions = Array.isArray(source.resourcePositions) ? [...new Map(source.resourcePositions.flatMap(value => {
    const parsed = PositionSchema.safeParse(value);
    if (!parsed.success || !Object.values(parsed.data).every(Number.isInteger)) return [];
    return [[`${parsed.data.x},${parsed.data.y},${parsed.data.z}`, parsed.data] as const];
  })).values()].slice(0, 64) : undefined;
  const failedCause = typeof source.failedCause === 'string' && source.failedCause ? source.failedCause.slice(0, 500) : undefined;
  s.checkpoint.missingResource = missing; s.checkpoint.minimum = minimum; s.checkpoint.resourceNames = resourceNames;
  if (resourcePositions) s.checkpoint.resourcePositions = resourcePositions; else delete s.checkpoint.resourcePositions;
  if (failedCause) s.checkpoint.failedCause = failedCause; else delete s.checkpoint.failedCause;
  const details: JsonObject = { ...(resourcePositions ? { resourcePositions } : {}), ...(failedCause ? { failedCause } : {}) };
  s.checkpoint.waitingFor = { kind: 'inventory', causeCode: 'BUILD_MATERIAL', item: missing, minimum, watchPosition: true, resourceNames, ...details };
  s.checkpoint.buildCause = { stage: 'materials', item, missingItem: missing, ...details };
  return new ConditionWait(error.message, s.checkpoint);
}
