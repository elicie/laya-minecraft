import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Agent, CentralMessage, CommandReceipt } from '../packages/contracts/src';
import { FleetController } from '../packages/core/src';
import { createControlServer } from '../apps/server/src/control-server';
import { ControlStore } from '../apps/server/src/store';

function headers(key: string = randomUUID()) { return { 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': key }; }

test('real core integration starts an enabled or resumed worker once and preserves paused registrations', async () => {
  const store = new ControlStore(':memory:');
  let api: ReturnType<typeof createControlServer> | undefined;
  const started: string[] = [];
  const core = new FleetController({ send() {}, onChange(snapshot, event) { api?.observe(snapshot, event); } });
  api = createControlServer({ core, store, port: 0, startBot(agent: Agent) {
    started.push(agent.id); core.startSession(agent.id, randomUUID());
  } });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const add = await fetch(`${base}/api/v1/bots`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'PausedBot', enabled: false }) });
    assert.equal((await add.json() as CommandReceipt).state, 'applied');
    assert.deepEqual(started, []);
    const paused = core.getSnapshot().agents[0]!;
    assert.equal(paused.status, 'paused');
    const resume = await fetch(`${base}/api/v1/bots/${paused.id}/resume`, { method: 'POST', headers: headers('resume'), body: '{}' });
    assert.equal(resume.status, 202);
    assert.deepEqual(started, [paused.id]);
    assert.equal(core.getSnapshot().agents[0]!.session?.state, 'starting');
    const duplicate = await fetch(`${base}/api/v1/bots/${paused.id}/resume`, { method: 'POST', headers: headers('resume'), body: '{}' });
    assert.equal(duplicate.status, 202); assert.equal(started.length, 1);
    const another = core.addAgent({ name: 'EnabledLater', enabled: false });
    const enable = await fetch(`${base}/api/v1/bots/${another.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ patch: { enabled: true } }) });
    assert.equal(enable.status, 202);
    assert.deepEqual(started, [paused.id, another.id]);
  } finally { await api.close(); store.close(); }
});

test('real core acknowledgements fence stale rules and removal waits for actual process exit', async () => {
  const store = new ControlStore(':memory:');
  let api: ReturnType<typeof createControlServer> | undefined;
  const messages: CentralMessage[] = [];
  const core = new FleetController({ controllerEpoch: 'test-epoch', send(_id, message) { messages.push(message); }, onChange(snapshot, event) { api?.observe(snapshot, event); } });
  api = createControlServer({ core, store, port: 0 });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const agent = core.addAgent({ name: 'AckBot' });
  core.startSession(agent.id, 'session');
  const envelope = (type: string, payload: unknown) => ({ protocolVersion: 1, messageId: randomUUID(), botId: agent.id, sessionId: 'session', controllerEpoch: 'test-epoch', sentAt: Date.now(), type, payload });
  const rules = core.getSnapshot().rules;
  core.onWorkerMessage(envelope('bot.ready', { ready: true, world: rules.world, dimension: rules.dimension, health: 20, food: 20, inventory: [], action: 'idle', reason: 'test', mode: 'idle', capabilities: ['collect'], rulesVersion: 0 }));
  core.onWorkerMessage(envelope('rules.applied', { version: rules.version }));
  try {
    const update = await fetch(`${base}/api/v1/rules`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ patch: { radius: 90 } }) });
    const pending = await update.json() as CommandReceipt;
    assert.equal(pending.state, 'applying');
    assert.ok(messages.some(message => message.type === 'rules.update' && message.payload.rules.radius === 90));
    core.onWorkerMessage(envelope('rules.applied', { version: rules.version }));
    assert.equal(store.getCommand(pending.id)?.state, 'applying');
    core.onWorkerMessage(envelope('rules.applied', { version: core.getSnapshot().rules.version }));
    assert.equal(store.getCommand(pending.id)?.state, 'applied');
    const removal = await fetch(`${base}/api/v1/bots/${agent.id}/remove`, { method: 'POST', headers: headers(), body: '{}' });
    const receipt = await removal.json() as CommandReceipt;
    assert.equal(receipt.state, 'applying');
    assert.equal(core.getSnapshot().agents[0]?.status, 'removing');
    assert.ok(messages.some(message => message.type === 'bot.shutdown'));
    core.onWorkerMessage(envelope('bot.stopped', { reason: 'Minecraft connection closed' }));
    assert.equal(store.getCommand(receipt.id)?.state, 'applying');
    core.confirmWorkerStopped(agent.id, 'session');
    assert.equal(store.getCommand(receipt.id)?.state, 'applied');
    assert.equal(core.getSnapshot().agents[0]?.status, 'removed');
  } finally { await api.close(); store.close(); }
});
