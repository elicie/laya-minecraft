import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { startRuntime } from '../apps/server/src/main';
import { BotInputSchema, RulesSchema, RecoveryStateSchema, CommandReceiptSchema, FleetSnapshotSchema, type FleetSnapshot } from '../packages/contracts/src';
import { blueprint, materialRequirements } from '../packages/contracts/src/blueprints';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ResourceRecovery, reconcileResourceJourneys } from '../packages/minecraft/src/resource-recovery';

if (process.env.MC_HOST !== '127.0.0.1' || process.env.MC_PORT !== '25566') throw new Error('Disposable minecraft-laya-validation:25566 only.');
const rcon = (command: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', command], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function validationOnly() { assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566'); }
async function until(check: () => boolean, reason: string, timeout = 15000) { const end = Date.now() + timeout; while (!check() && Date.now() < end) await sleep(100); assert.ok(check(), reason); }

test('actual empty-inventory respawn resumes a distant saved wood expedition and physically acquires a natural log', { timeout: 90000 }, async () => {
  validationOnly(); const origin = new Vec3(5206.5,80,5206.5);
  rcon('forceload add 5198 5198 5230 5222'); rcon('fill 5198 80 5198 5230 86 5222 air');
  rcon('fill 5198 76 5198 5230 78 5222 dirt'); rcon('fill 5198 79 5198 5230 79 5222 grass_block');
  rcon('fill 5220 80 5206 5220 82 5206 oak_log'); rcon('fill 5219 83 5205 5221 83 5207 oak_leaves[persistent=true]');
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'LayaRebornWood', auth: 'offline' }); bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn'); rcon('tp LayaRebornWood 5206.5 80 5206.5'); rcon('spawnpoint LayaRebornWood 5206 80 5206'); rcon('clear LayaRebornWood');
    await until(() => bot.entity.position.distanceTo(origin) < 1 && !!bot.blockAt(origin.floored().offset(0,-1,0)), 'initial live floor');
    const movements = new Movements(bot); movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.maxDropDown = 2; movements.infiniteLiquidDropdownDistance = false; movements.scafoldingBlocks = []; bot.pathfinder.setMovements(movements);
    const rules = RulesSchema.parse({ world: '127.0.0.1:25566', autonomyEnabled: false });
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaRebornWood' });
    const executor = new MineflayerExecutor(bot, { config, rules, world: rules.world, dimension: () => 'overworld' }), services = executor.services(AbortSignal.timeout(60000));
    services.checkpoint.resourceExpedition = true;
    const old = new ResourceRecovery(bot, services, 'oak_log', ['oak_log'], true, () => false);
    old.state.origin = { x: 5600, y: 80, z: 5600 }; old.state.destinationsUsed = 5; old.state.elapsedMs = 60000; old.beginResourceJourney();
    old.state.resourceJourney!.center = { x: 5600, y: 80, z: 5600 }; old.state.resourceJourney!.moves = 160; old.state.resourceJourney!.elapsedMs = 700000;
    Object.assign(services.checkpoint, old.wait('old-life disconnected route', 1).checkpoint);
    const died = once(bot, 'death'), spawned = once(bot, 'spawn'); rcon('kill LayaRebornWood'); await died; await spawned;
    await until(() => bot.health === 20 && bot.entity.position.distanceTo(origin) < 1 && bot.inventory.items().length === 0, 'actual empty respawn');
    const recovery = RecoveryStateSchema.parse({ deathId: randomUUID(), occurredAt: Date.now(), world: rules.world, dimension: 'overworld', priorInventory: [], phase: 'resolved', safe: true, attemptCount: 0, progress: { recoveredCount: 0, remainingCount: 0 }, reason: 'actual empty respawn observed', updatedAt: Date.now(), checkpoint: {} });
    reconcileResourceJourneys(bot, services.checkpoint, recovery);
    const rebased = new ResourceRecovery(bot, services, 'oak_log', ['oak_log'], true, () => false);
    assert.deepEqual(rebased.state.resourceJourney!.center, { x: 5206, y: 80, z: 5206 });
    assert.equal(rebased.state.destinationsUsed, 5); assert.equal(rebased.state.elapsedMs, 60000); assert.equal(rebased.state.resourceJourney!.moves, 160);
    const result = await executor.execute({ id: 'original-collect', goalId: 'original-wood-goal', kind: 'collect', source: 'user', params: { item: 'oak_log', quantity: 1 }, completion: { kind: 'inventory', item: 'oak_log', minimum: 1 }, dependencies: [], reservationKeys: [] }, services);
    assert.equal(result.outcome, 'completed'); assert.ok(executor.count('oak_log') >= 1);
    assert.equal(bot.blockAt(new Vec3(5220,80,5206))?.name, 'air');
    console.log('Verified real new-life collection', JSON.stringify({ savedOrigin: rebased.state.origin, respawn: origin, actual: bot.entity.position, oakLogs: executor.count('oak_log'), relocationCount: rebased.state.resourceJourney!.relocations!.length }));
  } finally { bot.quit('new-life wood validation finished'); await sleep(250); rcon('forceload remove 5198 5198 5230 5222'); }
});

test('a real fixed warehouse goal repairs a shallow changed foundation, builds, and registers the actual chest', { timeout: 330000 }, async () => {
  validationOnly(); const dir = mkdtempSync(join(tmpdir(),'laya-fixed-warehouse-')), botId = randomUUID(), origin = { x: 5316, y: 80, z: 5316 };
  const runtime = await startRuntime({ runtimeDir: dir, host: '127.0.0.1', port: 0, workerExecArgv: ['--import','tsx'], tickIntervalMs: 100 });
  const url = `http://127.0.0.1:${runtime.address.port}/api/v1`;
  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${url}${path}`, { method, headers: { 'content-type':'application/json', 'x-laya-control':'1', 'idempotency-key':randomUUID() }, ...(body === undefined ? {} : { body:JSON.stringify(body) }), signal:AbortSignal.timeout(10000) });
    const value: unknown = await response.json(); assert.equal(response.status, method === 'GET' ? 200 : 202, JSON.stringify(value)); return value;
  }
  async function command(method: string, path: string, body: unknown = {}) {
    let receipt = CommandReceiptSchema.parse(await request(method,path,body)); const end = Date.now()+20000;
    while (!['applied','failed'].includes(receipt.state) && Date.now()<end) { await sleep(100); receipt = CommandReceiptSchema.parse(await request('GET',`/commands/${receipt.id}`)); }
    assert.equal(receipt.state,'applied',JSON.stringify(receipt)); return receipt;
  }
  async function snapshotUntil(check: (s: FleetSnapshot) => boolean, reason: string, timeout=20000) {
    const end=Date.now()+timeout;
    while (true) { const s=FleetSnapshotSchema.parse(await request('GET','/snapshot')); if(check(s))return s; if(Date.now()>end)throw new Error(reason+': '+JSON.stringify({ agents:s.agents.map(a=>({ report:{ action:a.session?.report?.action,reason:a.session?.report?.reason,position:a.session?.report?.position,food:a.session?.report?.food,health:a.session?.report?.health } })), goals:s.goals.map(g=>({state:g.state,reason:g.reason})),tasks:s.tasks.map(t=>({kind:t.kind,state:t.state,reason:t.reason,mode:t.params.mode})) })); await sleep(250); }
  }
  try {
    rcon('forceload add 5304 5304 5340 5340'); rcon('fill 5304 80 5304 5340 87 5340 air'); rcon('fill 5304 75 5304 5340 78 5340 dirt'); rcon('fill 5304 79 5304 5340 79 5340 grass_block');
    await command('PATCH','/rules',{ patch:{ world:'127.0.0.1:25566',autonomyEnabled:false } });
    await command('POST','/bots',{ id:botId,name:'LayaFixedRepair',connection:{host:'127.0.0.1',port:25566,version:'1.21.1'} });
    await snapshotUntil(s=>!!s.agents.find(a=>a.id===botId)?.session?.report?.ready,'worker ready');
    await command('POST',`/bots/${botId}/pause`); rcon('tp LayaFixedRepair 5314.5 80 5314.5'); rcon('clear LayaFixedRepair');
    const blocks=blueprint('warehouse',origin); for(const [item,count]of Object.entries(materialRequirements(blocks)))rcon(`give LayaFixedRepair ${item} ${count}`);
    rcon('give LayaFixedRepair dirt 1'); // Materials are supplied to isolate actual terrain repair and construction.
    const receipt=await command('POST','/goals',{kind:'build',title:'원래 좌표 창고 지반 복구',preferredBotId:botId,params:{design:'warehouse',origin,siteSelection:'fixed'}});
    const goalId=String((receipt.result as {goalId:string}).goalId);
    rcon('setblock 5315 79 5315 air');
    await snapshotUntil(s=>s.agents.find(a=>a.id===botId)?.session?.report?.position?.x===5314.5,'actual site position');
    await command('POST',`/bots/${botId}/resume`);
    const finished=await snapshotUntil(s=>s.goals.some(g=>g.id===goalId&&g.state==='completed'),'fixed warehouse did not finish',290000);
    const goal=finished.goals.find(g=>g.id===goalId)!;
    assert.deepEqual(goal.input.params.origin,origin); assert.ok(finished.tasks.some(t=>t.params.fixedOrigin));
    assert.ok(finished.tasks.some(t=>t.params.mode==='prepare-site'&&t.state==='completed'));
    assert.ok(finished.rules.warehouse); assert.deepEqual(finished.rules.warehouse.position,{x:5317,y:81,z:5317});
    const repaired = rcon('execute if block 5315 79 5315 dirt') + rcon('execute if block 5315 79 5315 grass_block');
    assert.match(repaired,/Test passed/, 'filled dirt may naturally regrow into grass during construction');
    assert.match(rcon('execute if block 5317 81 5317 chest'),/Test passed/);
    console.log('Verified real fixed-site repair and warehouse',JSON.stringify({origin,goalState:goal.state,warehouse:finished.rules.warehouse.position,materialsProvided:true,tasks:finished.tasks.map(t=>({kind:t.kind,mode:t.params.mode,state:t.state,retries:t.retryCount}))}));
  } finally { await runtime.close();rmSync(dir,{recursive:true,force:true});rcon('forceload remove 5304 5304 5340 5340'); }
});
