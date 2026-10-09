import { itemCount, sameContainer, type CompletionCondition, type Evidence, type Observation, type Position } from '../../contracts/src';

export interface VerificationContext {
  observations: readonly Observation[];
  evidence?: readonly Evidence[];
  now: number;
  maxAgeMs: number;
  world: string;
  dimension: string;
  botId?: string;
  sessionId?: string;
  attemptId?: string;
  notBefore?: number;
}
export interface Verification { complete: boolean; current: number; target?: number; reason: string; }
export function distance(a: Position, b: Position): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
export function positionKey(p: Position): string { return `${p.x},${p.y},${p.z}`; }
export function freshObservations(context: VerificationContext): Observation[] {
  return context.observations.filter(o => o.world === context.world && o.dimension === context.dimension
    && context.now - o.receivedAt <= context.maxAgeMs && context.now - o.observedAt <= context.maxAgeMs
    && o.observedAt <= context.now + 1000 && o.receivedAt >= (context.notBefore ?? 0)
    && o.observedAt >= (context.notBefore ?? 0)
    && (!context.botId || o.botId === context.botId)
    && (!context.sessionId || o.sessionId === context.sessionId)
    && (!context.attemptId || o.attemptId === context.attemptId));
}
export function verifyCompletion(condition: CompletionCondition, context: VerificationContext): Verification {
  const observations = freshObservations(context);
  const result = (current: number, target: number, reason: string): Verification => ({ complete: current >= target, current, target, reason });
  switch (condition.kind) {
    case 'inventory': {
      const observed = observations.filter(o => o.kind === 'inventory').reverse().sort((a, b) => b.observedAt - a.observedAt)[0];
      const count = observed?.kind === 'inventory' ? itemCount(observed.data.items, condition.item) : 0;
      return result(count, condition.minimum, observed ? 'Actual inventory quantity checked' : 'Awaiting current inventory observation');
    }
    case 'container': {
      const observed = observations.filter(o => o.kind === 'container' && sameContainer(o.data.container, condition.container)).reverse().sort((a, b) => b.observedAt - a.observedAt)[0];
      const count = observed?.kind === 'container' ? itemCount(observed.data.items, condition.item) : 0;
      return result(count, condition.minimum, observed ? 'Shared warehouse quantity checked' : 'Awaiting warehouse observation');
    }
    case 'transfer': {
      let confirmed = 0;
      const seen = new Set<string>();
      for (const evidence of context.evidence ?? []) {
        if (evidence.kind !== 'transfer' || evidence.item !== condition.item || evidence.direction !== condition.direction || !sameContainer(evidence.container, condition.container)) continue;
        const inventoryDelta = evidence.afterInventory - evidence.beforeInventory;
        const containerDelta = evidence.afterContainer - evidence.beforeContainer;
        const fingerprint = JSON.stringify(evidence);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        if (condition.direction === 'store' ? inventoryDelta !== -evidence.quantity || containerDelta !== evidence.quantity : inventoryDelta !== evidence.quantity || containerDelta !== -evidence.quantity) continue;
        const inventory = observations.some(o => o.kind === 'inventory' && itemCount(o.data.items, condition.item) === evidence.afterInventory);
        const container = observations.some(o => o.kind === 'container' && sameContainer(o.data.container, condition.container) && itemCount(o.data.items, condition.item) === evidence.afterContainer);
        if (inventory && container) confirmed += evidence.quantity;
      }
      return result(confirmed, condition.quantity, confirmed ? 'Paired inventory and warehouse changes confirmed' : 'Transfer needs matching before/after evidence and current observations');
    }
    case 'blocks': {
      const blocks = new Map<string, { name: string; time: number }>();
      for (const observation of observations) if (observation.kind === 'blocks') for (const block of observation.data.blocks) {
        const key = positionKey(block.position), previous = blocks.get(key);
        if (!previous || observation.observedAt >= previous.time) blocks.set(key, { name: block.name, time: observation.observedAt });
      }
      const count = condition.blocks.filter(b => blocks.get(positionKey(b.position))?.name === b.name).length;
      return result(count, condition.blocks.length, 'Each required block must be observed at its planned position');
    }
    case 'entity-death': {
      const ids = new Set(observations.filter(o => o.kind === 'entity-death' && (!condition.targetName || o.data.entityName === condition.targetName)).map(o => o.kind === 'entity-death' ? o.data.entityId : ''));
      return result(ids.size, condition.minimum, 'Only observed entity-death events count as kills');
    }
    case 'position': {
      const observed = observations.filter(o => o.kind === 'position').reverse().sort((a, b) => b.observedAt - a.observedAt)[0];
      const arrived = observed?.kind === 'position' && distance(observed.data.position, condition.position) <= condition.radius;
      return result(arrived ? 1 : 0, 1, 'Actual position must be within the destination radius');
    }
    case 'farm': {
      const farms = observations.filter(o => o.kind === 'farm' && (!condition.crop || o.data.crop === condition.crop)).reverse().sort((a, b) => b.observedAt - a.observedAt);
      const farm = farms[0];
      if (farm?.kind !== 'farm') return result(0, condition.mode === 'setup' ? condition.plots : condition.quantity ?? 1, 'Awaiting observed farm conditions');
      if (condition.mode === 'setup') return result(Math.min(farm.data.planted, farm.data.watered, farm.data.plots), condition.plots, 'Planted and watered planned plots checked');
      return result(Math.max(0, farm.data.harvested - (condition.baseline ?? 0)), condition.quantity ?? 1, 'Observed harvested quantity checked');
    }
    case 'exploration': {
      const explored = observations.filter(o => o.kind === 'exploration');
      if (condition.resourceNames.length) {
        const found = explored.some(o => o.kind === 'exploration' && o.data.resources.some(b => condition.resourceNames.includes(b.name)));
        return result(found ? 1 : 0, 1, 'Requested resources must be observed at actual coordinates');
      }
      const visits = new Set(explored.map(o => o.kind === 'exploration' ? positionKey(o.data.position) : ''));
      return result(visits.size, condition.minVisits, 'Observed exploration visits checked');
    }
    case 'breeding': {
      const ids = new Set(observations.filter(o => o.kind === 'breeding' && (!condition.animal || o.data.animal === condition.animal)).map(o => o.kind === 'breeding' ? o.data.entityId : ''));
      return result(ids.size, condition.minimum, 'New offspring observations checked');
    }
    case 'sleep': return result(observations.some(o => o.kind === 'sleep' && o.data.isSleeping) ? 1 : 0, 1, 'Actual sleeping state checked');
    case 'continuous': return { complete: false, current: 0, reason: 'This activity remains a continuous goal' };
    case 'manual': return { complete: false, current: 0, reason: condition.reason };
  }
}

export function footprintInside(center: Position, radius: number, blocks: readonly { position: Position }[]): boolean {
  return blocks.length > 0 && blocks.every(b => Math.hypot(b.position.x - center.x, b.position.z - center.z) <= radius);
}
