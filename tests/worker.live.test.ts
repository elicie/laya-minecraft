import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathfinder } from 'mineflayer-pathfinder';
import { BotInputSchema, RulesSchema, type CentralMessage, type WorkerMessage } from '../packages/contracts/src';
import { MinecraftWorker } from '../packages/minecraft/src/worker';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable validation server only');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, seconds = 20, evidence?: () => string) { const end = Date.now() + seconds * 1000; while (!predicate() && Date.now() < end) await delay(100); assert.ok(predicate(), evidence?.() ?? 'Timed out waiting for real worker evidence'); }

test('real worker reports actual readiness, safely cancels and counterattacks when a gatherer is hurt', { timeout: 90000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  assert.equal(rcon('list').includes('LayaDefense'), false, 'The dedicated fixture bot must not already be connected.');
  rcon('forceload add 1248 1184 1280 1216'); rcon('fill 1248 80 1184 1280 88 1216 air'); rcon('fill 1248 77 1184 1280 79 1216 grass_block');
  rcon('kill @e[type=!player,x=1248,y=79,z=1184,dx=32,dy=12,dz=32]');
  const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaDefense', role: 'gatherer', connection: { host: '127.0.0.1', port: 25566, version: '1.21.1' } });
  const launch = { botId: 'live-defense', sessionId: randomUUID(), controllerEpoch: randomUUID(), config,
    rules: RulesSchema.parse({ center: { x: 1260, y: 80, z: 1200 }, radius: 32, autonomyEnabled: false }) };
  const bot = await createCompatibleBot({ ...config.connection, username: config.name }); bot.loadPlugin(pathfinder);
  let disconnected = false; bot.once('end', () => { disconnected = true; });
  const reports: WorkerMessage[] = [];
  const worker = new MinecraftWorker(launch, bot, report => reports.push(report));
  const message = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({ protocolVersion: 1, messageId: randomUUID(), botId: launch.botId, sessionId: launch.sessionId, controllerEpoch: launch.controllerEpoch, sentAt: Date.now(), type, payload, ...extra }) as CentralMessage;
  try {
    await waitFor(() => reports.some(report => report.type === 'bot.ready'));
    const ready = reports.find(report => report.type === 'bot.ready'); assert.ok(ready?.type === 'bot.ready'); assert.ok(ready.payload.health > 0); assert.ok(ready.payload.food > 0);
    rcon('tp LayaDefense 1260.5 80 1200.5'); rcon('clear LayaDefense'); rcon('give LayaDefense iron_sword'); rcon('give LayaDefense bread 16');
    // Player health and hunger persist between runs. This cancellation case
    // checks a stable survival wait; cancellation while consuming has unknown
    // effects and must remain safeStopped=false until its outcome is confirmed.
    const preparedAt = Date.now();
    rcon('effect give LayaDefense minecraft:instant_health 1 10 true');
    rcon('effect give LayaDefense minecraft:saturation 1 10 true');
    await waitFor(() => reports.some(report => report.type === 'bot.status' && report.sentAt >= preparedAt &&
      report.payload.health === 20 && report.payload.food === 20 && report.payload.mode === 'idle' &&
      report.payload.inventory.some(item => item.name === 'iron_sword') &&
      report.payload.position?.x === 1260.5 && report.payload.position.z === 1200.5));
    // Vanilla briefly rejects damage after joining. Wait in our empty fixture
    // before summoning the enemy so the explicit hit is an actual server event.
    await delay(3500);
    assert.equal(bot.health, 20); assert.equal(bot.food, 20);
    const attemptId = randomUUID(), taskId = randomUUID();
    await worker.receive(message('task.assign', { rulesVersion: launch.rules.version, checkpoint: {}, task: { id: taskId, goalId: 'live-survival', kind: 'survive', source: 'user', params: {}, dependencies: [], reservationKeys: [], completion: { kind: 'continuous', action: 'survive' } } }, { taskId, attemptId }));
    await waitFor(() => reports.some(report => report.type === 'task.started' && report.attemptId === attemptId));
    await worker.receive(message('task.cancel', { reason: 'live safe cancellation', preserveProgress: true }, { taskId, attemptId }));
    const cancelled = reports.find(report => report.type === 'task.cancelled' && report.attemptId === attemptId);
    const cancellationEvidence = JSON.stringify({ cancelled, attemptReports: reports.filter(report => 'attemptId' in report && report.attemptId === attemptId), health: bot.health, food: bot.food });
    assert.ok(cancelled?.type === 'task.cancelled', cancellationEvidence);
    assert.equal(cancelled.payload.safeStopped, true, cancellationEvidence); assert.equal(bot.pathfinder.isMoving(), false);
    rcon('summon husk 1263 80 1200 {PersistenceRequired:1b}'); await delay(300);
    const enemy = Object.values(bot.entities).find(entity => entity.name === 'husk'); assert.ok(enemy);
    let confirmedDeath = false; bot.on('entityDead', entity => { if (entity.id === enemy.id) confirmedDeath = true; });
    let observedThirteenHealth = false;
    const damageHealthReports: number[] = [];
    bot.on('health', () => { damageHealthReports.push(bot.health); if (bot.health === 13) observedThirteenHealth = true; });
    const appliedDamage = rcon('damage LayaDefense 7 minecraft:mob_attack by @e[type=husk,x=1260,y=80,z=1200,distance=..8,limit=1]');
    assert.doesNotMatch(appliedDamage, /invulnerable|No entity was found/, appliedDamage);
    await waitFor(() => observedThirteenHealth, 5, () => JSON.stringify({ appliedDamage, damageHealthReports, health: bot.health, food: bot.food }));
    await waitFor(() => reports.some(report => report.type === 'safety.alert' && report.payload.response === 'attack'), 10);
    await waitFor(() => confirmedDeath, 35);
    assert.ok(reports.some(report => report.type === 'bot.status' && report.payload.mode === 'emergency'));
  } finally {
    await worker.shutdown('validation complete');
    await waitFor(() => disconnected, 5);
    rcon('kill @e[type=husk,x=1248,y=79,z=1184,dx=32,dy=12,dz=32]');
  }
});
