import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoalInterpreter, LayaClient } from '../packages/models/src';
import { DEFAULT_RULES, BlueprintDefinitionSchema, blueprintPreset } from '../packages/contracts/src';

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

test('saved blueprint names resolve to current catalog IDs before builtin guesses', async () => {
  const small = BlueprintDefinitionSchema.parse({ ...blueprintPreset('warehouse'), id: 'fc3c5625-ea6e-4b32-93b4-f7487bc433d1', title: '창고', version: 1, createdAt: 1, updatedAt: 1 });
  const large = BlueprintDefinitionSchema.parse({ ...small, id: '87492909-c497-4c6c-9faa-1e1a927664a3', title: '큰 창고 2', width: 9 });
  const interpret = createGoalInterpreter({ fetchImpl: async () => { throw new Error('named catalog goal should not call model'); } });
  const result = await interpret('큰 창고 2 지어줘', DEFAULT_RULES, [small, large]);
  assert.equal(result.source, 'code'); assert.equal(result.goal.kind, 'build'); assert.equal(result.goal.params.design, large.id);
  assert.equal(result.goal.params.blueprint, large.id); assert.equal(result.goal.quantity, 1); assert.equal(result.goal.params.blueprintDefinition, undefined);
  const workshop = BlueprintDefinitionSchema.parse({ ...small, title: '돌 작업장' });
  assert.equal((await interpret('돌 작업장을 건설해 줘', DEFAULT_RULES, [workshop])).goal.params.blueprint, workshop.id);
  assert.equal((await interpret('원목 32개 모아', DEFAULT_RULES, [workshop])).goal.kind, 'collect');
});

test('Qwen sees registered blueprint IDs but cannot attach its own version or invent a design', async () => {
  const definition = BlueprintDefinitionSchema.parse({ ...blueprintPreset('cabin'), id: '07f226c7-f1c6-4ce8-a03e-5366c3d50a61', title: '돌 작업장', version: 2, createdAt: 1, updatedAt: 2 });
  let prompted = false;
  const interpret = createGoalInterpreter({ fetchImpl: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.ok(request.messages[0].content.includes(definition.id)); assert.ok(request.messages[0].content.includes(definition.title)); prompted = true;
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ kind: 'build', params: { blueprint: definition.id, blueprintDefinition: { version: 99, materials: { wall: 'tnt' } }, requiredBlocks: [{ position: { x: 0, y: 0, z: 0 }, name: 'tnt' }] } }) } }));
  } });
  const result = await interpret('등록해 둔 작업 공간을 세워 줘', DEFAULT_RULES, [definition]);
  assert.ok(prompted); assert.equal(result.goal.params.design, definition.id); assert.equal(result.goal.params.blueprintDefinition, undefined); assert.equal(result.goal.params.requiredBlocks, undefined);
  const stale = createGoalInterpreter({ fetchImpl: async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ kind: 'build', params: { design: definition.id } }) } })) });
  await assert.rejects(stale('없는 설계를 실행해 줘', DEFAULT_RULES), /등록된 건축 설계도/);
  for (const design of ['constructor', '__proto__', 'imaginary_castle']) {
    const invalid = createGoalInterpreter({ fetchImpl: async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ kind: 'build', params: { design } }) } })) });
    await assert.rejects(invalid('특별한 설계를 실행해 줘', DEFAULT_RULES, [definition]), /등록된 건축 설계도/);
  }
});

test('ambiguous saved blueprint names require choosing a specific catalog entry', async () => {
  const first = BlueprintDefinitionSchema.parse({ ...blueprintPreset('cabin'), id: '94f97ea2-9153-40c9-a2da-118adab08d8b', title: '돌 작업장', version: 1, createdAt: 1, updatedAt: 1 });
  const second = { ...first, id: 'baad53a7-4d58-49d7-b2dd-ae50b8fa357a' };
  const interpret = createGoalInterpreter({ fetchImpl: async () => { throw new Error('ambiguous titles should not call model'); } });
  await assert.rejects(interpret('돌 작업장 지어 줘', DEFAULT_RULES, [first, second]), /목록에서 설계도/);
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
