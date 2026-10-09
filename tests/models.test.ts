import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoalInterpreter, LayaClient } from '../packages/models/src';
import { DEFAULT_RULES } from '../packages/contracts/src';

test('quantity goals distinguish total, explicitly additional and maintained stock', async () => {
  const interpret = createGoalInterpreter({ fetchImpl: async () => { throw new Error('known command should not call model'); } });
  const once = await interpret('원목 32개 모아', DEFAULT_RULES);
  assert.equal(once.goal.kind, 'collect'); assert.equal(once.goal.quantity, 32); assert.equal(once.goal.quantityMode, 'total'); assert.equal(once.goal.mode, 'once');
  assert.equal((await interpret('원목 추가로 32개 모아', DEFAULT_RULES)).goal.quantityMode, 'additional');
  assert.equal((await interpret('원목 32개 유지', DEFAULT_RULES)).goal.mode, 'maintain');
  assert.equal((await interpret('상자 2개 만들어', DEFAULT_RULES)).goal.kind, 'craft');
  assert.equal((await interpret('창고 건물 지어', DEFAULT_RULES)).goal.kind, 'build');
});

test('Qwen output must pass runtime goal and registry validation', async () => {
  const interpret = createGoalInterpreter({ fetchImpl: async () => new Response(JSON.stringify({ message: { content: '{"kind":"collect","item":"imaginary_ore","quantity":32}' } }), { status: 200 }) });
  await assert.rejects(interpret('알 수 없는 새 광물을 준비해', DEFAULT_RULES), /Minecraft 아이템/);
});

test('Laya accepts only current candidates and falls back truthfully on invalid output', async () => {
  const candidates = [{ id: 'collect_1', description: 'Collect the needed logs.' }];
  const good = new LayaClient({ fetchImpl: async () => new Response(JSON.stringify({ model: 'test', answers: { village_action: { choice: 'collect_1', confidence: 0.8 } } })) });
  assert.equal((await good.choose({ state: 'Need logs', candidates })).source, 'laya');
  for (const answer of [ { choice: 'delete_world' }, { choice: 'collect_1', state_truncated: true } ]) {
    const bad = new LayaClient({ fetchImpl: async () => new Response(JSON.stringify({ state_truncated: 'state_truncated' in answer, answers: { village_action: answer } })) });
    const result = await bad.choose({ state: 'Need logs', candidates });
    assert.equal(result.id, 'collect_1'); assert.equal(result.source, 'code');
  }
});
