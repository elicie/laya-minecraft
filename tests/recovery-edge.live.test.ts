import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/server/src/main';
import { CommandReceiptSchema, FleetSnapshotSchema, type FleetSnapshot } from '../packages/contracts/src';

if ((process.env.MC_HOST ?? '127.0.0.1') !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });

test('actual empty-inventory death at a stable cliff edge moves onto safe ground and resumes the same queued home goal', { timeout: 90000 }, async () => {
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const dir = mkdtempSync(join(tmpdir(), 'laya-recovery-edge-')), botId = randomUUID();
  const runtime = await startRuntime({ runtimeDir: dir, host: '127.0.0.1', port: 0, workerExecArgv: ['--import', 'tsx'], tickIntervalMs: 100 });
  const url = `http://127.0.0.1:${runtime.address.port}/api/v1`;
  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', 'x-laya-control': '1', 'idempotency-key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const value: unknown = await response.json(); assert.equal(response.status, method === 'GET' ? 200 : 202, JSON.stringify(value)); return value;
  }
  async function command(method: string, path: string, body: unknown = {}) {
    let receipt = CommandReceiptSchema.parse(await request(method, path, body)); const end = Date.now() + 20000;
    while (!['applied','failed'].includes(receipt.state) && Date.now() < end) { await sleep(100); receipt = CommandReceiptSchema.parse(await request('GET', `/commands/${receipt.id}`)); }
    assert.equal(receipt.state, 'applied', JSON.stringify(receipt)); return receipt;
  }
  async function until(check: (s: FleetSnapshot) => boolean, reason: string) {
    const end = Date.now() + 30000;
    while (true) {
      const s = FleetSnapshotSchema.parse(await request('GET', '/snapshot'));
      if (check(s)) return s;
      if (Date.now() >= end) throw new Error(reason + ': ' + JSON.stringify(s.agents.map(a => ({ status: a.status, report: a.session?.report, recovery: a.recovery }))));
      await sleep(100);
    }
  }
  try {
    rcon('forceload add 4728 4728 4760 4752');
    rcon('fill 4728 74 4728 4760 84 4752 air');
    rcon('fill 4736 77 4728 4760 78 4752 dirt'); rcon('fill 4736 79 4728 4760 79 4752 grass_block');
    rcon('kill @e[type=!player,x=4728,y=74,z=4728,dx=32,dy=12,dz=24]');
    await command('PATCH', '/rules', { patch: { world: '127.0.0.1:25566', autonomyEnabled: false } });
    await command('POST', '/bots', { id: botId, name: 'LayaRecoveryEdge', connection: { host: '127.0.0.1', port: 25566, version: '1.21.1' } });
    await until(s => !!s.agents.find(a => a.id === botId)?.session?.report?.ready, 'actual worker not ready');
    await command('POST', `/bots/${botId}/pause`);
    rcon('spawnpoint LayaRecoveryEdge 4736 80 4736'); rcon('tp LayaRecoveryEdge 4736.5 80 4736.5'); rcon('clear LayaRecoveryEdge');
    await until(s => s.agents.find(a => a.id === botId)?.session?.report?.position?.x === 4736.5, 'actual edge position missing');
    const receipt = await command('POST', '/goals', { kind: 'home', title: '안전한 발판 확인 후 기존 작업 재개', preferredBotId: botId, params: { position: { x: 4744.5, y: 80, z: 4736.5 }, radius: 1 } });
    const goalId = String((receipt.result as { goalId: string }).goalId);
    rcon('kill LayaRecoveryEdge');
    const blocked = await until(s => { const a = s.agents.find(a => a.id === botId); return !!a?.session?.report?.ready && a.recovery?.phase === 'resolved' && !a.recovery.safe && a.session.report.health === 20; }, 'actual empty death did not retain unsafe edge gate');
    const death = blocked.agents.find(a => a.id === botId)!.recovery!;
    assert.deepEqual(death.priorInventory, []); assert.equal(blocked.attempts.length, 0);
    await command('POST', `/bots/${botId}/resume`);
    const completed = await until(s => s.goals.some(g => g.id === goalId && g.state === 'completed'), 'edge exit did not resume queued work');
    const a = completed.agents.find(a => a.id === botId)!;
    assert.equal(a.recovery!.deathId, death.deathId); assert.equal(a.recovery!.phase, 'resolved'); assert.equal(a.recovery!.safe, true);
    assert.equal(a.recovery!.attemptCount, 0); assert.deepEqual(a.recovery!.progress, { recoveredCount: 0, remainingCount: 0, lostCount: 0 });
    assert.ok(completed.attempts.every(attempt => attempt.state === 'completed'));
    assert.ok(completed.tasks.every(task => task.retryCount === 0));
    assert.match(rcon('execute if block 4735 79 4736 air'), /Test passed/); assert.match(rcon('execute if block 4736 79 4736 grass_block'), /Test passed/);
    const safety = a.recovery!.checkpoint.recoverySafety as { attempts: number; elapsedMs: number };
    console.log('Verified actual recovery edge exit', JSON.stringify({ initialEdge: death.position, finalPosition: a.session!.report!.position, safe: a.recovery!.safe, recoveredItems: 0, safetyAttempts: safety.attempts, safetyElapsedMs: safety.elapsedMs, goalState: completed.goals.find(g => g.id === goalId)!.state }));
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); rcon('forceload remove 4728 4728 4760 4752'); }
});
