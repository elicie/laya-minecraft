import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_RULES, BotInputSchema, GoalInputSchema,
  type Agent, type CoreEvent, type FleetCheckpoint, type FleetSnapshot, type Goal,
} from '../packages/contracts/src';
import { createControlServer, type FleetControlPort } from '../apps/server/src/control-server';
import type { ControlServerOptions } from '../apps/server/src/control-server';
import { ControlStore } from '../apps/server/src/store';
import { reconcileCommandReceipts } from '../apps/server/src/reconciliation';

function fixture(options: Partial<ControlServerOptions> = {}) {
  const store = new ControlStore(':memory:');
  const snapshot: FleetSnapshot = { schemaVersion: 1, controllerEpoch: 'epoch', revision: 0, updatedAt: 0,
    rules: structuredClone(DEFAULT_RULES), agents: [], goals: [], tasks: [], attempts: [], reservations: [], observations: [], events: [] };
  let observe: (snapshot: FleetSnapshot, event: CoreEvent) => void = () => {};
  let creations = 0;
  const pendingViewers = new Map<string, string>();
  function emit(type: string, commandId?: string) {
    snapshot.revision += 1;
    snapshot.updatedAt = Date.now();
    const event: CoreEvent = { id: randomUUID(), time: Date.now(), revision: snapshot.revision, type, commandId, message: type };
    snapshot.events.push(event);
    observe(snapshot, event);
  }
  const core: FleetControlPort = {
    getSnapshot: () => structuredClone(snapshot),
    checkpoint: () => ({ ...structuredClone(snapshot), processedMessageIds: [], pendingRuleCommands: [], pendingCommands: [], stoppedSessionIds: [] }),
    addAgent(input, commandId) {
      const parsed = BotInputSchema.parse(input);
      const { id = randomUUID(), ...config } = parsed;
      const agent: Agent = { id, config, pendingCommandIds: [], status: 'registered', viewer: { state: 'stopped' }, createdAt: Date.now(), updatedAt: Date.now() };
      snapshot.agents.push(agent); emit('command.applied', commandId); return agent;
    },
    createGoal(input, commandId) {
      creations += 1;
      const parsed = GoalInputSchema.parse(input);
      const goal: Goal = { id: randomUUID(), input: parsed, title: parsed.title ?? parsed.kind, state: 'queued', taskIds: [], createdAt: Date.now(), updatedAt: Date.now(), progress: { current: 0 }, generation: 0 };
      snapshot.goals.push(goal); emit('command.applied', commandId); return goal;
    },
    updateGoal() {}, cancelGoal() {},
    updateRules(patch, _mode, commandId) { Object.assign(snapshot.rules, patch); emit('rules.requested', commandId); },
    updateAgent(id) { return snapshot.agents.find(agent => agent.id === id)!; },
    removeAgent(id, commandId) {
      const agent = snapshot.agents.find(agent => agent.id === id);
      assert.ok(agent); agent.status = 'removed'; emit('command.applied', commandId);
    },
    pauseAgent() {}, resumeAgent(id) { return snapshot.agents.find(agent => agent.id === id)!; },
    requestViewer(botId, enabled, port, commandId) {
      const agent = snapshot.agents.find(agent => agent.id === botId)!;
      agent.viewer = { state: enabled ? 'starting' : 'stopping', port, prefix: `/viewer/${botId}` };
      if (commandId) pendingViewers.set(botId, commandId);
      emit('viewer.requested', commandId);
    },
  };
  const api = createControlServer({ core, store, port: 0, ...options });
  observe = api.observe;
  return { store, core, api, snapshot, emit, pendingViewers, get creations() { return creations; } };
}
function headers(key: string = randomUUID()): Record<string, string> {
  return { 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': key };
}

test('HTTP validates commands, defaults to disposable port, and deduplicates goal creation', async () => {
  const f = fixture();
  const address = await f.api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const denied = await fetch(`${base}/api/v1/goals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { error: { code: string } }).error.code, 'CONTROL_HEADER_REQUIRED');
    const invalid = await fetch(`${base}/api/v1/goals`, { method: 'POST', headers: headers(), body: JSON.stringify({ kind: 'collect' }) });
    assert.equal(invalid.status, 400);
    const added = await fetch(`${base}/api/v1/bots`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'TestBot' }) });
    assert.equal(added.status, 202);
    assert.equal(f.snapshot.agents[0]?.config.connection.port, 25566);
    const input = { kind: 'collect', item: 'oak_log', quantity: 32 };
    const first = await fetch(`${base}/api/v1/goals`, { method: 'POST', headers: headers('same'), body: JSON.stringify(input) });
    const receipt = await first.json() as { id: string; state: string };
    assert.equal(receipt.state, 'applied');
    const duplicate = await fetch(`${base}/api/v1/goals`, { method: 'POST', headers: headers('same'), body: JSON.stringify(input) });
    assert.equal((await duplicate.json() as { id: string }).id, receipt.id);
    assert.equal(f.creations, 1);
    const conflict = await fetch(`${base}/api/v1/goals`, { method: 'POST', headers: headers('same'), body: JSON.stringify({ ...input, quantity: 33 }) });
    assert.equal(conflict.status, 409);
  } finally { await f.api.close(); f.store.close(); }
});

test('command stays applying until actual acknowledgement and removal duplicates retain receipt', async () => {
  const f = fixture();
  const address = await f.api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const pending = await fetch(`${base}/api/v1/rules`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ patch: { radius: 80 } }) });
    const receipt = await pending.json() as { id: string; state: string };
    assert.equal(receipt.state, 'applying');
    f.emit('command.applied', receipt.id);
    const status = await fetch(`${base}/api/v1/commands/${receipt.id}`);
    assert.equal((await status.json() as { state: string }).state, 'applied');
    const agent = f.core.addAgent({ name: 'RemovedBot' });
    const remove = await fetch(`${base}/api/v1/bots/${agent.id}/remove`, { method: 'POST', headers: headers('remove-key'), body: '{}' });
    const removed = await remove.json() as { id: string; state: string };
    const duplicate = await fetch(`${base}/api/v1/bots/${agent.id}/remove`, { method: 'POST', headers: headers('remove-key'), body: '{}' });
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json() as { id: string }).id, removed.id);
  } finally { await f.api.close(); f.store.close(); }
});

test('SSE sends a complete initial state and on-demand viewer waits for actual ready', async () => {
  const f = fixture();
  const address = await f.api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  try {
    const stream = await fetch(`${base}/api/v1/stream`, { signal: abort.signal });
    const reader = stream.body!.getReader();
    const first = await reader.read();
    const payload = new TextDecoder().decode(first.value);
    assert.match(payload, /event: snapshot/);
    assert.match(payload, /"controllerEpoch":"epoch"/);
    const agent = f.core.addAgent({ name: 'ViewerBot' });
    agent.session = { id: 'session', state: 'ready', lastReportAt: Date.now(), rulesVersion: 1 };
    const started = await fetch(`${base}/api/v1/bots/${agent.id}/viewer`, { method: 'POST', headers: headers(), body: '{}' });
    assert.equal((await started.json() as { state: string }).state, 'applying');
    const early = await fetch(`${base}/viewer/${agent.id}/`);
    assert.equal(early.status, 503);
    // A forged/nonallocated viewer target cannot be proxied even if marked ready.
    agent.viewer = { state: 'ready', port: 9, prefix: `/viewer/${agent.id}` };
    const forged = await fetch(`${base}/viewer/${agent.id}/`);
    assert.equal(forged.status, 503);
    abort.abort();
    await reader.cancel().catch(() => {});
  } finally { abort.abort(); await f.api.close(); f.store.close(); }
});

test('restart receipts use durable application evidence without replaying an action', () => {
  const store = new ControlStore(':memory:');
  try {
    store.acceptCommand('applied', 'applied', 'goal.create', {});
    store.appendEvent({ id: 'applied-event', time: 1, type: 'command.applied', commandId: 'applied' });
    store.acceptCommand('pending', 'pending', 'rules.update', {});
    store.acceptCommand('unknown', 'unknown', 'bot.update', {});
    const checkpoint = { agents: [], pendingRuleCommands: [{ commandId: 'pending', version: 2, awaitingBotIds: ['bot'] }] } as unknown as FleetCheckpoint;
    const updated = reconcileCommandReceipts(store, checkpoint);
    assert.deepEqual(updated.map(receipt => [receipt.id, receipt.state]), [['applied', 'applied'], ['pending', 'applying'], ['unknown', 'failed']]);
  } finally { store.close(); }
});

test('built React assets and SPA routes are served without exposing files outside web root', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'laya-web-'));
  const root = join(directory, 'web');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root">Laya</div>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("Laya");');
  writeFileSync(join(directory, 'outside.txt'), 'not public');
  symlinkSync(join(directory, 'outside.txt'), join(root, 'outside.txt'));
  const f = fixture({ webRoot: root });
  const address = await f.api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.match(await (await fetch(`${base}/`)).text(), /id="root"/);
    assert.equal(await (await fetch(`${base}/assets/app.js`)).text(), 'console.log("Laya");');
    assert.match(await (await fetch(`${base}/goals/selected`)).text(), /id="root"/);
    assert.equal((await fetch(`${base}/api/v1/nonexistent`)).status, 404);
    assert.equal((await fetch(`${base}/assets/nonexistent.js`)).status, 404);
    assert.equal((await fetch(`${base}/outside.txt`)).status, 403);
  } finally { await f.api.close(); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unsupported natural-language goal returns a specific 422 message', async () => {
  const f = fixture({ interpret: async () => { throw Object.assign(new Error('지원하는 설계도를 선택해 주세요.'), { code: 'GOAL_UNSUPPORTED' }); } });
  const address = await f.api.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/goals/interpret`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ text: '대성당을 지어' }),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: { code: 'GOAL_UNSUPPORTED', message: '지원하는 설계도를 선택해 주세요.' } });
  } finally { await f.api.close(); f.store.close(); }
});
