import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import type { Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, type ResultPayload, type TaskSpec, type WorkerMessage } from '../packages/contracts/src';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { MinecraftWorker } from '../packages/minecraft/src/worker';
import { ConditionWait, type ActionServices } from '../packages/minecraft/src/services';

test('idle worker observes exact blocked construction cells omitted by map sampling', { timeout: 12000 }, async () => {
  const emitter = new EventEmitter(), messages: WorkerMessage[] = [];
  const watched = new Vec3(1, 63, 1);
  let actual: string | null = 'air';
  let executions = 0;
  const launch = WorkerLaunchSchema.parse({ botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch',
    config: { name: 'BuildWatch' }, rules: { statusIntervalMs: 250 } });
  const bot = Object.assign(emitter, {
    health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {}, players: {},
    inventory: { items: () => [], slots: [] },
    pathfinder: { setGoal() {}, setMovements() {}, thinkTimeout: 0 },
    blockAt(p: Vec3) { return p.equals(watched) && actual ? { name: actual, position: p } : null; },
    clearControlStates() {}, deactivateItem() {}, stopDigging() {},
    quit(reason: string) { emitter.emit('end', reason); },
  }) as unknown as Bot;
  class WaitingExecutor extends MineflayerExecutor {
    override async execute(_task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
      executions++;
      throw new ConditionWait('기초 지지 블록이 필요합니다.', { ...s.checkpoint,
        waitingFor: { kind: 'blocks', causeCode: 'BUILD_SUPPORT', positions: [{ x: 1, y: 63, z: 1 }] } });
    }
  }
  const worker = new MinecraftWorker(launch, bot, message => messages.push(message), {
    movementsFactory: () => ({}) as Movements,
    executorFactory: (bot, options) => new WaitingExecutor(bot, options),
  });
  try {
    emitter.emit('spawn'); emitter.emit('health');
    const task: TaskSpec = { id: 'task', goalId: 'goal', kind: 'build', params: {}, dependencies: [], reservationKeys: [], completion: { kind: 'blocks', blocks: [{ position: { x: 1, y: 64, z: 1 }, name: 'oak_planks' }] } };
    await worker.receive({ protocolVersion: 1, messageId: randomUUID(), botId: 'bot', sessionId: 'session', controllerEpoch: 'epoch',
      sentAt: Date.now(), type: 'task.assign', taskId: task.id, attemptId: 'attempt', payload: { task, checkpoint: {}, rulesVersion: launch.rules.version } });
    assert.ok(messages.some(message => message.type === 'task.result' && message.payload.outcome === 'condition-wait'));
    actual = 'stone';
    const deadline = Date.now() + 7500;
    while (!messages.some(message => message.type === 'world.observed' && message.payload.observations.some(o => o.kind === 'blocks' && o.data.blocks.some(b => b.position.x === 1 && b.position.y === 63 && b.position.z === 1 && b.name === 'stone'))) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const observation = messages.find(message => message.type === 'world.observed' && message.payload.observations.some(o => o.kind === 'blocks' && o.data.blocks.some(b => b.name === 'stone')));
    assert.ok(observation, 'the real changed cell must be reported even though the map omits odd coordinates');
    assert.equal(executions, 1, 'observation alone must not run a new task locally');
    assert.equal(observation.sessionId, launch.sessionId);
    assert.equal(observation.controllerEpoch, launch.controllerEpoch);
  } finally { await worker.shutdown(); }
});
