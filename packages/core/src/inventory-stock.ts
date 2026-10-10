import { itemCount, type Agent, type FleetSnapshot, type ItemStack, type Observation } from '../../contracts/src';

export interface InventoryStock { botId: string; sessionId: string; count: number; observedAt: number; items: ItemStack[]; }
/** Only live enabled sessions with fresh, actual inventory observations contribute. */
export function inventoryStocks(state: FleetSnapshot, item: string, now: number): InventoryStock[] {
  const latest = new Map<string, Extract<Observation, { kind: 'inventory' }>>();
  for (const observation of state.observations) {
    if (observation.kind !== 'inventory' || observation.controllerEpoch !== state.controllerEpoch || observation.world !== state.rules.world || observation.dimension !== state.rules.dimension || observation.observedAt > now + 1000 || now - observation.observedAt >= state.rules.statusTimeoutMs || now - observation.receivedAt >= state.rules.statusTimeoutMs) continue;
    const key = JSON.stringify([observation.botId, observation.sessionId]), previous = latest.get(key);
    if (!previous || observation.observedAt > previous.observedAt || observation.observedAt === previous.observedAt && observation.receivedAt >= previous.receivedAt) latest.set(key, observation);
  }
  return state.agents.flatMap(agent => {
    const session = agent.session, report = session?.report;
    if (!agent.config.enabled || agent.desiredConfig?.enabled === false || ['removed', 'removing', 'paused'].includes(agent.status) || session?.state !== 'ready' || !report?.ready || report.health <= 0 || report.world !== state.rules.world || report.dimension !== state.rules.dimension || now - session.lastReportAt >= state.rules.statusTimeoutMs) return [];
    const observation = latest.get(JSON.stringify([agent.id, session.id]));
    return observation ? [{ botId: agent.id, sessionId: session.id, count: itemCount(observation.data.items, item), observedAt: observation.observedAt, items: observation.data.items }] : [];
  });
}

/** Missing slot view is unknown; keep batches bounded and let the public executor check it. */
export function inventoryCapacity(agent: Agent, item: string): number {
  const slots = agent.session?.report?.inventoryView?.slots;
  if (!slots) return 64;
  let room = 0;
  for (const slot of slots.slice(9, 45)) room += slot === null ? 64 : slot.name === item ? Math.max(0, (slot.maxStackSize ?? 64) - slot.count) : 0;
  return Math.min(64, room);
}
