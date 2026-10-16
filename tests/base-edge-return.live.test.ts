import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Vec3 } from 'vec3';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { BotInputSchema, RulesSchema } from '../packages/contracts/src';
import { createCompatibleBot } from '../packages/minecraft/src/compatibility';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ResourceRecovery } from '../packages/minecraft/src/resource-recovery';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('a real overlapping support is settled before a warehouse return is planned', { skip: !process.env.MC_EDGE_SNAPSHOT, timeout: 90000 }, async () => {
  assert.equal(process.env.MC_HOST, '127.0.0.1'); assert.equal(process.env.MC_PORT, '25566');
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "25565/tcp") 0).HostPort}}', 'minecraft-laya-validation'], { encoding: 'utf8' }).trim(), '25566');
  const rcon = (cmd: string) => execFileSync('docker', ['exec', 'minecraft-laya-validation', 'rcon-cli', cmd], { encoding: 'utf8' });
  const scene = JSON.parse(readFileSync(process.env.MC_EDGE_SNAPSHOT!, 'utf8'))[0];
  const pit = process.env.MC_PIT_START === '1';
  if (pit) scene.position = { x: 59.60514556736367, y: 65, z: 2.3 };
  const shift = 16000, commands = ['forceload add 16054 16000 16069 16016', 'fill 16054 64 16000 16069 78 16016 air', 'fill 16054 63 16000 16069 63 16016 stone'];
  for (const b of scene.blocks) if (b.name && b.name !== 'air') commands.push(`setblock ${b.x + shift} ${b.y} ${b.z + shift} ${b.name}`);
  execFileSync('docker', ['exec', '-i', 'minecraft-laya-validation', 'rcon-cli'], { input: commands.join('\n') + '\nexit\n', encoding: 'utf8', maxBuffer: 2 ** 22 });
  const bot = await createCompatibleBot({ host: '127.0.0.1', port: 25566, version: process.env.MC_VERSION ?? '1.21.1', username: 'LayaEdgeReturn', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  try {
    await once(bot, 'spawn'); rcon('clear LayaEdgeReturn');
    rcon(`tp LayaEdgeReturn ${scene.position.x + shift} ${scene.position.y} ${scene.position.z + shift}`); await sleep(1800);
    const movement = new Movements(bot); movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; movement.maxDropDown = 2; movement.infiniteLiquidDropdownDistance = false; movement.scafoldingBlocks = []; bot.pathfinder.setMovements(movement);
    const { id: _id, ...config } = BotInputSchema.parse({ name: 'LayaEdgeReturn' });
    const ex = new MineflayerExecutor(bot, { config, rules: RulesSchema.parse({ autonomyEnabled: false }), world: '127.0.0.1:25566', dimension: () => 'overworld' });
    const s = ex.services(AbortSignal.timeout(45000), { safeDetourRequired: true, materialExpedition: true, resourceRecovery: { oak_log: { elapsedMs: 1234, destinationsUsed: 3 } } });
    assert.equal(bot.entity.onGround, true); if (!pit) assert.equal(bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))?.name, 'air');
    const target = new Vec3(16059.5, 68, 16004.5);
    if (pit) {
      s.checkpoint.resourceRecovery = { oak_log: { origin: { x: 16059, y: 69, z: 16005 }, visited: [], failed: [], probes: [], sourceSnapshot: [], sourceFingerprint: '', destinationsUsed: 3, approachesUsed: 0, elapsedMs: 1234, status: 'searching', reason: '' } };
      const protectedPositions = JSON.parse(readFileSync(process.env.MC_WOOD_TASK_SNAPSHOT!, 'utf8')).params.protectedPositions;
      const protectedKeys = new Set(protectedPositions.map((p: any) => `${p.x + shift},${p.y},${p.z + shift}`));
      const recovery = new ResourceRecovery(bot, s, 'oak_log', ['oak_log'], true, p => protectedKeys.has(`${p.x},${p.y},${p.z}`));
      assert.equal(protectedKeys.has('16059,67,16004'), true);
      assert.equal(recovery.route(target.floored()), process.env.MC_EXPECT_PIT_FAILURE !== '1');
      if (process.env.MC_EXPECT_PIT_FAILURE === '1') return;
    }
    if (process.env.MC_EXPECT_EDGE_FAILURE === '1') await assert.rejects(s.near(target, 0), /전체 실제 발판/);
    else {
      await s.near(target, 0); assert.ok(bot.entity.position.distanceTo(target) < .6);
      if (!pit) assert.equal((s.checkpoint.footprintSettle as any).phase, 'complete');
      assert.equal((s.checkpoint.resourceRecovery as any).oak_log.elapsedMs, 1234);
      console.log('Real edge return', JSON.stringify({ version: process.env.MC_VERSION ?? '1.21.1', settledSupportingCell: true, arrived: true, budgetsPreserved: true, terrainEditsByBot: false, productionWorld: false }));
    }
  } finally { bot.quit('edge return fixture finished'); await sleep(200); rcon('forceload remove 16054 16000 16069 16016'); }
});
