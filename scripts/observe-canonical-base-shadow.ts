import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { BASE_DECISION_QUESTION, renderQwenBaseState } from '../packages/models/src';

async function main() {
  const output = process.argv[2]; if (!output || existsSync(output)) throw Error('Fresh output path required');
  const s = await fetch('http://127.0.0.1:3001/api/v1/snapshot').then(r => r.json()) as any;
  const a = s.agents.find((a: any) => a.id === s.rules.baseAutonomy.botId), r = a.session.report;
  const night = a.survivalRecovery?.checkpoint?.nightBase ?? r.survivalRecovery?.checkpoint?.nightBase;
  if (a.session.state !== 'ready' || Date.now() - a.session.lastReportAt > 5000 || r.world !== 'infra:25565'
    || r.timeOfDay < 9000 || night?.phase !== 'closed' || r.action !== '창고 야간 대피') throw Error('No actual verified closed shelter scene');
  const observation = { observedAt: Date.now(), world: r.world, dimension: r.dimension, position: r.position,
    health: r.health, food: r.food, timeOfDay: r.timeOfDay, worldAge: r.worldAge, role: a.config.role,
    inventory: r.inventory, nearbyThreatsClear: r.nearbyThreatsClear,
    targets: { seeds: s.rules.baseAutonomy.positions.length, wood: s.rules.baseAutonomy.woodTarget, bread: s.rules.baseAutonomy.breadTarget },
    candidates: [{ id: randomUUID(), action: 'shelter', kind: 'sleep', priority: 100 }] };
  const state = renderQwenBaseState({ state: JSON.stringify(observation), candidates: observation.candidates.map(c => ({ ...c, description: c.action })) });
  const row = { id: randomUUID(), task: 'base_action', source: 'production', world: r.world, state,
    state_sha256: createHash('sha256').update(state).digest('hex'), episode_id: `shadow:${a.session.id}:closed-shelter`,
    question_sha256: createHash('sha256').update(readFileSync('packages/contracts/src/base-decisions.json')).digest('hex'),
    recorded_at: Date.now(), world_age: r.worldAge, run_day: Math.floor((r.worldAge - 10226444) / 24000) + 1,
    expected: null, allowed: [], reviewed: false,
    evidence: { observation, actualNightBase: night, actualReport: r, controllerEpoch: s.controllerEpoch,
      shadowOnly: true, modelActionExecuted: false, administrativeFixture: false,
      explanation: 'Read-only shadow decision for the mandatory code shelter scene; not an actual scheduler selection.' } };
  writeFileSync(output, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ output, records: 1, shadowOnly: true, reviewed: false, timeOfDay: r.timeOfDay }));
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
