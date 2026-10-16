import test from 'node:test';
import assert from 'node:assert/strict';
import { BotReportSchema, SurvivalRecoverySchema, WorkerLaunchSchema, survivalRecoveryNeeded } from '../packages/contracts/src';

test('survival recovery validates its full target and finite, bounded restoration evidence without requiring it on legacy reports', () => {
  const episode = { startedAt: 100000, targetHealth: 20, checkpoint: { resourceRecovery: { $food: { destinationsUsed: 5, status: 'exhausted' } } }, wait: { fingerprint: 'actual inputs', reason: '식량 대기' }, knowledge: { blocks: [{ position: { x: 1, y: 64, z: 1 }, name: 'wheat', state: 'age:0' }] } };
  assert.deepEqual(SurvivalRecoverySchema.parse(episode), episode);
  for (const invalid of [{ ...episode, targetHealth: 10 }, { ...episode, checkpoint: { unknown: undefined } }, { ...episode, startedAt: -1 }, { ...episode, surprise: true }, { ...episode, knowledge: { blocks: Array.from({ length: 257 }, () => episode.knowledge.blocks[0]) } }, { ...episode, knowledge: { blocks: [{ ...episode.knowledge.blocks[0], position: { x: Infinity, y: 64, z: 0 } }] } }]) assert.equal(SurvivalRecoverySchema.safeParse(invalid).success, false);
  const launch = WorkerLaunchSchema.parse({ botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch', config: { name: 'RecoveryBot' }, rules: {}, restoreSurvivalRecovery: episode });
  assert.deepEqual(launch.restoreSurvivalRecovery, episode);
  assert.equal(WorkerLaunchSchema.parse({ botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch', config: { name: 'RecoveryBot' }, rules: {} }).restoreSurvivalRecovery, undefined);
  assert.equal(BotReportSchema.parse({ ready: true, world: 'world', dimension: 'overworld', health: 20, food: 20, inventory: [], action: 'idle', reason: 'ready', mode: 'idle', capabilities: [], rulesVersion: 1 }).survivalRecovery, undefined);
});

test('the shared recovery admission threshold includes moderate health, critical hunger and the exact configured retreat boundary', () => {
  const combat = { supportHealth: 10, retreatHealth: 6 };
  assert.equal(survivalRecoveryNeeded(6.333, 17, combat), true);
  assert.equal(survivalRecoveryNeeded(9.999, 20, combat), true);
  assert.equal(survivalRecoveryNeeded(10, 17, combat), false);
  assert.equal(survivalRecoveryNeeded(20, 17, combat), false);
  assert.equal(survivalRecoveryNeeded(20, 6, combat), true);
  assert.equal(survivalRecoveryNeeded(6, 20, { supportHealth: 5, retreatHealth: 6 }), true);
});
