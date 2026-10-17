import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { FleetSnapshotSchema, GoalSchema, TaskSchema, BotInputSchema, DEFAULT_RULES, type FleetSnapshot, type FleetCheckpoint, type Observation } from '../packages/contracts/src';
import { dashboardSnapshot } from '../apps/server/src/dashboard-snapshot';
import { createControlServer, type FleetControlPort } from '../apps/server/src/control-server';
import { ControlStore } from '../apps/server/src/store';
import { FleetController } from '../packages/core/src';

function fixture(): FleetSnapshot {
  const now = Date.now(), secret = 'private-execution-proof'.repeat(100000);
  const goal = GoalSchema.parse({ id: 'goal', title: '창고', input: { kind: 'build', params: { blueprint: 'warehouse' } }, state: 'active', taskIds: ['prior', 'task'], generation: 2, createdAt: now, updatedAt: now, progress: { current: 1 } });
  const task = TaskSchema.parse({ id: 'task', goalId: goal.id, kind: 'build', generation: 2, params: { mode: 'prepare-site', design: 'warehouse', protectedPositions: [{ x: 10, y: 64, z: 0 }], preparation: { private: secret } }, completion: { kind: 'blocks', blocks: [{ position: { x: 1, y: 64, z: 0 }, name: 'chest' }] }, dependencies: ['prior'], reservationKeys: ['protected-coord'], checkpoint: { private: secret, build: { placed: 17, private: secret }, buildRemaining: { count: 4, cells: [{ x: 4, y: 64, z: 0 }] }, preparationProgress: { stage: 'fill', completedEdits: 4, totalEdits: 8, pathIndex: 1, pathLength: 2 }, resourceRecovery: { private: secret } }, waitState: { botId: 'bot', sessionId: 'session', fingerprint: secret, repeatCount: 0, waitingFor: { kind: 'inventory', causeCode: 'BUILD_MATERIAL', item: 'dirt', minimum: 4, resourcePositions: [{ x: 1, y: 64, z: 0 }] } }, state: 'condition-wait', retryCount: 0, resumeCount: 0, progress: 0.5, createdAt: now, updatedAt: now, attemptId: 'attempt' });
  const recovery = { deathId: 'death', occurredAt: now - 1000, world: DEFAULT_RULES.world, dimension: DEFAULT_RULES.dimension, priorInventory: [], phase: 'held' as const, reason: '아이템 회수 대기', attemptCount: 1, progress: { recoveredCount: 1, remainingCount: 2 }, safe: false, updatedAt: now, checkpoint: { private: secret } };
  const survivalRecovery = { startedAt: now - 1000, targetHealth: 20 as const, checkpoint: { private: secret }, wait: { fingerprint: secret.slice(0, 10000), reason: '식량 대기' }, knowledge: { blocks: [] } };
  const config = BotInputSchema.parse({ name: 'DashboardUnit' });
  return { schemaVersion: 1, controllerEpoch: 'epoch', revision: 20, updatedAt: now, rules: structuredClone(DEFAULT_RULES), blueprints: [], goals: [goal], tasks: [{ ...task, id: 'prior', state: 'completed', params: { mode: 'prepare-access', design: 'warehouse' }, generation: 1, dependencies: [], attemptId: undefined }, task],
    attempts: [{ id: 'attempt', taskId: 'task', botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch', reason: 'resume', state: 'interrupted', assignedAt: now, result: { outcome: 'condition-wait', checkpoint: { private: secret }, observations: [], evidence: [] } }],
    agents: [{ id: 'bot', config, pendingCommandIds: [], status: 'ready', viewer: { state: 'stopped' }, createdAt: now, updatedAt: now, recovery, survivalRecovery, session: { id: 'session', state: 'ready', lastReportAt: now, rulesVersion: 1, activeAttemptId: 'attempt', report: { ready: true, world: DEFAULT_RULES.world, dimension: DEFAULT_RULES.dimension, health: 7, food: 17, inventory: [{ name: 'dirt', count: 14 }], mode: 'survival', action: '식량 대기', reason: '새 식량을 기다립니다.', capabilities: ['build'], rulesVersion: 1, recovery, survivalRecovery } } }],
    observations: [], reservations: [], events: Array.from({ length: 250 }, (_, i) => ({ id: `event-${i}`, type: 'task.progress', time: now, revision: i, message: `사실 ${i}`, data: { private: secret.slice(0, 100) } })) };
}
function observation(s: FleetSnapshot, id: string, observedAt: number, blocks: { position: { x: number; y: number; z: number }; name: string; stateId?: number }[]): Observation {
  return { id, observedAt, receivedAt: observedAt, world: s.rules.world, dimension: s.rules.dimension, botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch', kind: 'blocks', data: { blocks } };
}

test('dashboard projection preserves strict UI identities, progress and recovery while leaving full state untouched', () => {
  const full = fixture(), before = JSON.stringify(full), projected = dashboardSnapshot(full, full.updatedAt);
  FleetSnapshotSchema.parse(projected); assert.equal(JSON.stringify(full), before);
  assert.ok(JSON.stringify(projected).length < before.length / 20);
  assert.deepEqual(projected.goals, full.goals); assert.deepEqual(projected.rules, full.rules); assert.deepEqual(projected.blueprints, full.blueprints);
  assert.deepEqual(projected.tasks.map(t => [t.id, t.goalId, t.generation, t.dependencies, t.completion, t.attemptId]), full.tasks.map(t => [t.id, t.goalId, t.generation, t.dependencies, t.completion, t.attemptId]));
  assert.equal(projected.tasks[0]!.params.mode, 'prepare-access'); assert.equal(projected.tasks[1]!.params.mode, 'prepare-site');
  assert.deepEqual(projected.tasks[1]!.checkpoint.build, { placed: 17 }); assert.deepEqual(projected.tasks[1]!.checkpoint.buildRemaining, { count: 4 });
  assert.equal((projected.tasks[1]!.checkpoint.waitingFor as { minimum: number }).minimum, 4);
  assert.equal(projected.tasks[1]!.waitState, undefined); assert.equal(projected.tasks[1]!.params.preparation, undefined); assert.equal(projected.attempts[0]!.result, undefined);
  assert.deepEqual(projected.agents[0]!.recovery!.checkpoint, {}); assert.equal(projected.agents[0]!.recovery!.progress.remainingCount, 2);
  assert.equal(projected.agents[0]!.session!.report!.survivalRecovery!.targetHealth, 20); assert.equal(projected.agents[0]!.survivalRecovery!.knowledge, undefined);
  assert.equal(projected.events.length, 200); assert.equal(projected.events[0]!.id, 'event-50'); assert.equal(projected.events[0]!.data, undefined);
  assert.equal(JSON.stringify(projected).includes('private-execution-proof'), false);
});

test('map view keeps only fresh latest actual cells with a global 1200-cell bound', () => {
  const s = fixture(), p = { x: 2, y: 64, z: 0 };
  s.observations = [observation(s, 'new', s.updatedAt, [{ position: p, name: 'wheat', stateId: 124 }]), observation(s, 'old', s.updatedAt - 1, [{ position: p, name: 'wheat', stateId: 123 }]), observation(s, 'stale', s.updatedAt - s.rules.observationMaxAgeMs - 1, [{ position: { ...p, x: 9999 }, name: 'lava' }]), observation(s, 'many', s.updatedAt - 2, Array.from({ length: 1300 }, (_, i) => ({ position: { x: i + 20, y: 64, z: 0 }, name: 'grass_block' })))];
  const projected = dashboardSnapshot(s, s.updatedAt), cells = projected.observations.flatMap(o => o.kind === 'blocks' ? o.data.blocks : []);
  FleetSnapshotSchema.parse(projected); assert.equal(cells.length, 1200); assert.equal(cells.filter(b => b.position.x === 2).length, 1); assert.equal(cells.find(b => b.position.x === 2)!.stateId, 124);
  assert.equal(cells.some(b => b.name === 'lava'), false); assert.equal(new Set(cells.map(b => JSON.stringify(b.position))).size, 1200);
});

test('fresh observations from other worlds or dimensions cannot displace the village map cell budget', () => {
  const state = fixture(), village = observation(state, 'village', state.updatedAt - 10, [{ position: { x: 1, y: 64, z: 0 }, name: 'chest' }]);
  const foreignCells = Array.from({ length: 1200 }, (_, x) => ({ position: { x, y: 64, z: 0 }, name: 'lava' }));
  const foreignWorld = { ...observation(state, 'other-world', state.updatedAt, foreignCells), world: 'another-server:25566' };
  const foreignDimension = { ...observation(state, 'other-dimension', state.updatedAt, foreignCells), dimension: 'the_nether' };
  state.observations = [foreignWorld, foreignDimension, village];
  const projected = dashboardSnapshot(state, state.updatedAt); FleetSnapshotSchema.parse(projected);
  assert.equal(projected.observations.length, 1); assert.equal(projected.observations[0]!.id, 'village');
  assert.deepEqual(projected.observations[0], village); assert.equal(state.observations.length, 3, 'full observations remain untouched');
});

async function serverFixture(fast = false) {
  const state = fixture(), store = new ControlStore(':memory:');
  let fullReads = 0, dashboardReads = 0;
  const checkpoint = (): FleetCheckpoint => ({ ...structuredClone(state), processedMessageIds: [], pendingRuleCommands: [], pendingCommands: [], stoppedSessionIds: [] });
  const core = { getSnapshot: () => { fullReads++; return structuredClone(state); }, getRules: () => structuredClone(state.rules), checkpoint,
    ...(fast ? { getDashboardSnapshot: (now = state.updatedAt) => { dashboardReads++; return structuredClone(dashboardSnapshot(state, now)); } } : {}) } as FleetControlPort;
  const api = createControlServer({ core, store, port: 0, now: () => state.updatedAt });
  const address = await api.listen(); return { state, store, api, base: `http://127.0.0.1:${address.port}`, get fullReads() { return fullReads; }, get dashboardReads() { return dashboardReads; } };
}
test('dashboard HTTP is opt-in and gzip negotiable while full API, checkpoint and event journal retain their original evidence', async () => {
  const f = await serverFixture();
  try {
    const full = await (await fetch(`${f.base}/api/v1/snapshot`)).json(); assert.deepEqual(full, JSON.parse(JSON.stringify(f.state)));
    const response = await fetch(`${f.base}/api/v1/snapshot?view=dashboard`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(response.headers.get('content-encoding'), 'gzip'); FleetSnapshotSchema.parse(await response.json());
    const identity = await fetch(`${f.base}/api/v1/snapshot?view=dashboard`, { headers: { 'accept-encoding': 'gzip;q=0, *;q=1' } }); assert.equal(identity.headers.get('content-encoding'), null);
    const projected = await identity.json() as FleetSnapshot; assert.equal(projected.attempts[0]!.result, undefined);
    const event = { id: 'durable', type: 'test.critical', revision: 21, time: Date.now(), message: 'full journal', data: { checkpoint: { protectedPositions: [{ x: 1, y: 2, z: 3 }] } } };
    f.api.observeEvent(event); assert.deepEqual(f.store.loadCheckpoint<FleetCheckpoint>()!.attempts[0]!.result, f.state.attempts[0]!.result);
    assert.deepEqual((await (await fetch(`${f.base}/api/v1/events`)).json() as typeof event[]).find(e => e.id === event.id)!.data, event.data);
  } finally { await f.api.close(); f.store.close(); }
});

test('gzip SSE flushes complete strict snapshots and later actual revisions without closing a legal frame', async () => {
  const f = await serverFixture();
  const abort = new AbortController();
  try {
    const response = await fetch(`${f.base}/api/v1/stream?view=dashboard`, { signal: abort.signal, headers: { 'accept-encoding': 'gzip' } });
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
    const nextSnapshot = async () => {
      for (;;) {
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2); if (frame.includes('event: snapshot')) return FleetSnapshotSchema.parse(JSON.parse(frame.split('\ndata: ')[1]!)); }
        const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    const first = await nextSnapshot(); assert.equal(first.revision, 20); assert.equal(first.tasks[1]!.checkpoint.private, undefined);
    f.state.revision = 21; f.state.updatedAt += 1000; f.api.observeEvent({ id: 'change', revision: 21, time: Date.now(), type: 'bot.status', message: 'actual report' });
    const next = await nextSnapshot(); assert.equal(next.revision, 21); assert.equal(next.updatedAt, f.state.updatedAt);
  } finally { abort.abort(); await f.api.close(); f.store.close(); }
});

test('an uncompressed large full SSE snapshot finishes before a queued event even when HTTP reading pauses', async () => {
  const f = await serverFixture();
  let request: ReturnType<typeof get> | undefined;
  try {
    const received = new Promise<void>((resolve, reject) => {
      request = get(`${f.base}/api/v1/stream`, response => {
        response.setEncoding('utf8'); response.pause(); let buffer = '', sawSnapshot = false;
        setTimeout(() => { f.api.observeEvent({ id: 'queued', type: 'world.observed', revision: 21, time: Date.now(), message: 'queued behind legal frame' }); response.resume(); }, 50);
        response.on('data', chunk => { buffer += chunk; let at: number; while ((at = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2); if (frame.includes('event: snapshot')) { const parsed = FleetSnapshotSchema.parse(JSON.parse(frame.split('\ndata: ')[1]!)); assert.ok(parsed.attempts[0]!.result); sawSnapshot = true; } if (frame.includes('id: queued')) { assert.ok(sawSnapshot); resolve(); request!.destroy(); } } });
        response.on('error', error => { if (!sawSnapshot) reject(error); });
      }); request.on('error', reject);
    });
    await received;
  } finally { request?.destroy(); await f.api.close(); f.store.close(); }
});

test('a command broadcast is serialized once across full and dashboard clients', async () => {
  const core = new FleetController({ send() {}, rules: { autonomyEnabled: false } }), store = new ControlStore(':memory:');
  const api = createControlServer({ core, store, port: 0 }), address = await api.listen(), abort = new AbortController();
  try {
    const streams = await Promise.all(['', '?view=dashboard'].map(view => fetch(`http://127.0.0.1:${address.port}/api/v1/stream${view}`, { signal: abort.signal })));
    let serializations = 0;
    const receipt = { id: 'shared-command', type: 'goal.create', state: 'applied' as const, createdAt: 1, updatedAt: 1 };
    api.broadcastCommand({ ...receipt, toJSON() { serializations++; return receipt; } } as typeof receipt);
    assert.equal(serializations, 1);
    for (const response of streams) {
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let body = '';
      while (!body.includes('"id":"shared-command"')) { const chunk = await reader.read(); assert.equal(chunk.done, false); body += decoder.decode(chunk.value); }
      assert.match(body, /event: command/); assert.match(body, /"state":"applied"/);
    }
  } finally { abort.abort(); await api.close(); store.close(); }
});

test('a malformed legacy opaque waitingFor value cannot make the strict dashboard response invalid', () => {
  const state = fixture(); delete state.tasks[1]!.waitState;
  state.tasks[1]!.checkpoint.waitingFor = { kind: 'inventory', private: 'legacy-value-without-required-fields' };
  const projected = dashboardSnapshot(state, state.updatedAt); FleetSnapshotSchema.parse(projected);
  assert.equal(projected.tasks[1]!.checkpoint.waitingFor, undefined);
});

test('dashboard HTTP and dashboard-only stream revisions use the fast projection read while full subscribers keep complete evidence', async () => {
  const f = await serverFixture(true), abort = new AbortController();
  try {
    const http = FleetSnapshotSchema.parse(await (await fetch(`${f.base}/api/v1/snapshot?view=dashboard`)).json());
    assert.equal(http.attempts[0]!.result, undefined); assert.equal(f.fullReads, 0); assert.equal(f.dashboardReads, 1);
    const response = await fetch(`${f.base}/api/v1/stream?view=dashboard`, { signal: abort.signal, headers: { 'accept-encoding': 'identity' } });
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let body = '';
    const nextSnapshot = async () => { for (;;) { const at = body.indexOf('\n\n'); if (at >= 0) { const frame = body.slice(0, at); body = body.slice(at + 2); if (frame.includes('event: snapshot')) return FleetSnapshotSchema.parse(JSON.parse(frame.split('\ndata: ')[1]!)); continue; } const chunk = await reader.read(); assert.equal(chunk.done, false); body += decoder.decode(chunk.value, { stream: true }); } };
    await nextSnapshot(); assert.equal(f.fullReads, 0); assert.equal(f.dashboardReads, 2);
    f.state.revision++; f.state.updatedAt++; f.api.observeEvent({ id: 'fast-change', revision: f.state.revision, time: f.state.updatedAt, type: 'bot.status', message: 'actual state change' });
    assert.equal((await nextSnapshot()).revision, f.state.revision); assert.equal(f.fullReads, 0); assert.equal(f.dashboardReads, 3);
    const fullResponse = await fetch(`${f.base}/api/v1/stream`, { signal: abort.signal, headers: { 'accept-encoding': 'identity' } });
    assert.equal(f.fullReads, 1); const fastBefore = f.dashboardReads;
    f.state.revision++; f.state.updatedAt++; f.api.observeEvent({ id: 'mixed-change', revision: f.state.revision, time: f.state.updatedAt, type: 'bot.status', message: 'actual mixed state change' });
    assert.equal((await nextSnapshot()).revision, f.state.revision); assert.equal(f.fullReads, 2); assert.equal(f.dashboardReads, fastBefore, 'mixed clients share the already-required complete read');
    await fullResponse.body!.cancel();
    const full = FleetSnapshotSchema.parse(await (await fetch(`${f.base}/api/v1/snapshot`)).json()); assert.ok(full.attempts[0]!.result); assert.equal(f.fullReads, 3);
  } finally { abort.abort(); await f.api.close(); f.store.close(); }
});
