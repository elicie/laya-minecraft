import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { WorkerLaunchSchema, WorkerMessageSchema, type TaskSpec } from '../packages/contracts/src';
import { assessCombat, combatEquipment, rangedThreat } from '../packages/minecraft/src/combat-policy';
import { retreatFingerprint, safeCombatRoute, safeCombatStand } from '../packages/minecraft/src/combat-retreat';
import { MineflayerExecutor } from '../packages/minecraft/src/actions';
import { ActionFailure, ConditionWait } from '../packages/minecraft/src/services';

const launch = WorkerLaunchSchema.parse({ botId: 'b', sessionId: 's', controllerEpoch: 'e', config: { name: 'CombatCheck' }, rules: {} });
function fixture(targetName = 'zombie') {
  const emitter = new EventEmitter(), changes = new Map<string, string>(), slots = Array.from({ length: 46 }, () => null) as ({ name: string; count: number } | null)[];
  let heights = (x: number, _z: number) => 64, forcePath: Vec3[] | undefined, interrupted = false;
  let attacks = 0, moves = 0, pending: (() => void) | undefined, delayMove = false;
  const target = { id: 2, uuid: 'threat-2', name: targetName, type: 'mob', position: new Vec3(2, 64, 0), height: 1.8 } as unknown as Entity;
  const bot = Object.assign(emitter, {
    health: 20, food: 20, entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, game: { dimension: 'overworld' },
    entities: { 2: target } as Record<number, Entity>, players: {}, inventory: { slots, items: () => slots.filter(item => !!item) },
    blockAt(p: Vec3) { const name = changes.get(p.floored().toString()) ?? (p.y < heights(p.x, p.z) ? 'stone' : 'air'); if (name === 'unknown') return null; return { name, stateId: name === 'air' ? 0 : 1, position: p.floored(), boundingBox: ['air', 'water', 'lava', 'fire'].includes(name) ? 'empty' : 'block' }; },
    world: { raycast: (_start: Vec3, _direction: Vec3, _length: number) => null as unknown },
    async equip() {}, async lookAt() {}, activateItem() {}, deactivateItem() {}, clearControlStates() {},
    attack(e: Entity) { attacks++; delete bot.entities[e.id]; emitter.emit('entityDead', e); },
    pathfinder: {
      movements: { canDig: false, allow1by1towers: false },
      getPathTo(_movements: unknown, goal: { x: number; y: number; z: number }) {
        if (forcePath) return { status: 'success', path: forcePath.map(p => ({ ...p, toBreak: [], toPlace: [], parkour: false })) };
        const start = bot.entity.position.floored(), destination = new Vec3(goal.x, goal.y, goal.z), path: Vec3[] = [];
        let p = start;
        for (let count = 0; !p.equals(destination) && count < 100; count++) { const dx = Math.sign(destination.x - p.x), dz = dx ? 0 : Math.sign(destination.z - p.z); const x = p.x + dx, z = p.z + dz; p = new Vec3(x, heights(x, z), z); path.push(p); }
        return { status: p.equals(destination) ? 'success' : 'noPath', path: path.map(p => ({ ...p, toBreak: [], toPlace: [], parkour: false })) };
      },
      async goto(goal: { x: number; y: number; z: number }) { moves++; if (delayMove) await new Promise<void>((_resolve, reject) => { pending = () => reject(new Error('GoalChanged')); }); else bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); },
      setGoal(_goal: unknown) { interrupted = true; pending?.(); },
    },
  });
  const executor = new MineflayerExecutor(bot as unknown as Bot, { config: launch.config, rules: launch.rules, world: launch.rules.world, dimension: () => 'overworld' });
  const services = executor.services(new AbortController().signal); services.pause = async () => {}; services.near = async p => { moves++; bot.entity.position = new Vec3(p.x, p.y, p.z); };
  return { bot: bot as unknown as Bot, raw: bot, executor, services, slots, changes, target, get attacks() { return attacks; }, get moves() { return moves; }, get interrupted() { return interrupted; }, set heights(value: typeof heights) { heights = value; }, set forcePath(value: Vec3[]) { forcePath = value; }, set delayMove(value: boolean) { delayMove = value; } };
}
const assessment = { role: 'builder', health: 20, food: 20, weapon: false, shield: false, enemies: 1, allies: 0, attacked: true, threateningVillage: false, targetName: 'zombie', distance: 2 };

test('ranged combat uses actual worn armor and offhand shield while a healthy single melee attacker can be countered', () => {
  const f = fixture(); f.slots[9] = { name: 'iron_chestplate', count: 1 }; f.slots[10] = { name: 'shield', count: 1 };
  assert.deepEqual(combatEquipment(f.bot), { weapon: false, shield: false, armorPoints: 0 });
  assert.equal(assessCombat(assessment, launch.rules).response, 'attack');
  assert.equal(assessCombat({ ...assessment, targetName: 'skeleton' }, launch.rules).response, 'retreat');
  f.slots[36] = { name: 'iron_sword', count: 1 }; f.slots[45] = { name: 'shield', count: 1 };
  assert.equal(assessCombat({ ...assessment, targetName: 'skeleton', ...combatEquipment(f.bot) }, launch.rules).response, 'attack');
  f.slots[45] = null; f.slots[5] = { name: 'iron_helmet', count: 1 }; f.slots[6] = { name: 'iron_chestplate', count: 1 }; f.slots[7] = { name: 'iron_leggings', count: 1 };
  assert.equal(combatEquipment(f.bot).armorPoints, 13); assert.equal(rangedThreat('pillager'), true);
  assert.equal(assessCombat({ ...assessment, targetName: 'skeleton', ...combatEquipment(f.bot), health: 8 }, launch.rules).response, 'retreat');
  assert.equal(assessCombat({ ...assessment, attacked: false, targetName: 'skeleton' }, launch.rules).response, 'ignore');
});

test('a safe endpoint does not authorize routes over lava, unknown cells, gaps or protected construction cells', () => {
  const f = fixture(), destination = new Vec3(6, 64, 0);
  assert.equal(safeCombatRoute(f.bot, destination).safe, true);
  for (const name of ['lava', 'unknown', 'air']) {
    f.changes.set(new Vec3(3, 63, 0).toString(), name);
    assert.equal(safeCombatStand(f.bot, destination), true); assert.equal(safeCombatRoute(f.bot, destination).safe, false);
  }
  f.changes.clear(); assert.equal(safeCombatRoute(f.bot, destination, { protectedPosition: p => p.x === 3 && p.y === 64 }).safe, false);
  assert.equal(safeCombatRoute(f.bot, destination, { protectedPosition: p => p.y === 63 }).safe, true, 'walking over an existing floor never changes it');
});

test('public route verification accepts known one-block elevation changes and rejects unverified jumps', () => {
  const f = fixture(); f.heights = x => x >= 3 ? 65 : 64;
  assert.equal(safeCombatRoute(f.bot, { x: 6, y: 65, z: 0 }).safe, true);
  f.forcePath = [new Vec3(6, 65, 0)]; assert.equal(safeCombatRoute(f.bot, { x: 6, y: 65, z: 0 }).safe, false);
});

test('retreat prioritizes real ranged cover and confirms the actual arrived position', async () => {
  const f = fixture('skeleton');
  f.changes.set(new Vec3(-3, 65, -2).toString(), 'stone');
  f.raw.world.raycast = (_start, direction) => direction.z < -0.1 ? { position: new Vec3(-3, 65, -2) } : null;
  await f.executor.retreat(f.target, f.services);
  assert.ok(f.bot.entity.position.z < -2); assert.ok(f.bot.entity.position.distanceTo(f.target.position) >= 8);
  assert.equal((f.services.checkpoint.retreatRecovery as { status: string }).status, 'safe');
  const untouched = fixture(); untouched.services.near = async () => {};
  await assert.rejects(untouched.executor.retreat(untouched.target, untouched.services), ConditionWait);
  assert.equal((untouched.services.checkpoint.retreatRecovery as { attempts: number }).attempts, 6);
});

test('retreat reaches verified higher ground rather than repeatedly trying same-height endpoints', async () => {
  const f = fixture(); f.heights = x => x < -3 ? 65 : 64;
  await f.executor.retreat(f.target, f.services);
  assert.equal(f.bot.entity.position.y, 65); assert.ok(f.moves > 1);
  assert.equal((f.services.checkpoint.retreatRecovery as { status: string }).status, 'safe');
});

test('failed retreat preserves bounded probes; clock and own movement do not reopen an exhausted decision', async () => {
  const f = fixture(); f.services.near = async () => { throw new ConditionWait('blocked'); };
  await assert.rejects(f.executor.retreat(f.target, f.services), ConditionWait);
  const state = f.services.checkpoint.retreatRecovery as unknown as { attempts: number; elapsedMs: number; probes: { position: Vec3 }[] };
  assert.equal(state.attempts, 6); assert.ok(state.probes.length <= 64);
  const fingerprint = retreatFingerprint(f.bot, f.services.checkpoint); f.raw.entity.position = new Vec3(1.5, 64, 0.5); state.elapsedMs += 5000;
  assert.equal(retreatFingerprint(f.bot, f.services.checkpoint), fingerprint);
  const before = f.moves; await assert.rejects(f.executor.retreat(f.target, f.services), ConditionWait); assert.equal(f.moves, before);
  const p = state.probes.at(-1)!.position; f.changes.set(new Vec3(p.x, p.y, p.z).toString(), 'water');
  assert.notEqual(retreatFingerprint(f.bot, f.services.checkpoint), fingerprint);
  const message = { protocolVersion: 1, messageId: 'message', sentAt: Date.now(), type: 'task.result', botId: 'b', sessionId: 's', controllerEpoch: 'e', taskId: 't', attemptId: 'a', payload: { outcome: 'condition-wait', observations: [], evidence: [], checkpoint: f.services.checkpoint } };
  // Checkpoint remains plain JSON, including finite budgets and actual probes.
  assert.equal(WorkerMessageSchema.safeParse(message).success, true);
});

test('urgent health changes cancel an in-progress approach before attacking and parent abort remains cancellation', async () => {
  const f = fixture(); f.slots[36] = { name: 'iron_sword', count: 1 }; f.target.position = new Vec3(12, 64, 0); f.delayMove = true;
  const fight = f.executor.fightEntity(f.target, f.services);
  await new Promise(resolve => setImmediate(resolve)); f.bot.health = 5; f.raw.emit('health');
  await assert.rejects(fight, ConditionWait); assert.equal(f.interrupted, true); assert.equal(f.attacks, 0);
  assert.equal(f.bot.listenerCount('health'), 0); assert.equal(f.bot.listenerCount('entityMoved'), 0);
  const aborted = fixture(); aborted.slots[36] = { name: 'iron_sword', count: 1 }; aborted.target.position = new Vec3(12, 64, 0); aborted.delayMove = true;
  const controller = new AbortController(), services = aborted.executor.services(controller.signal), promise = aborted.executor.fightEntity(aborted.target, services);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(promise, e => e instanceof ActionFailure && e.code === 'CANCELLED'); assert.equal(aborted.attacks, 0);
});

test('unknown retreat failures propagate instead of being converted into successful safety or retryable waits', async () => {
  const f = fixture(); f.services.near = async () => { throw new ActionFailure('effects unknown', 'UNCERTAIN', false, false); };
  await assert.rejects(f.executor.retreat(f.target, f.services), e => e instanceof ActionFailure && !e.effectsKnown);
});

test('support fights match exact observed entity and expiry, never another hostile of the same species', async () => {
  const f = fixture(); f.slots[36] = { name: 'iron_sword', count: 1 };
  const params = { supportRequestId: 'support', requesterBotId: 'other', requesterSessionId: 'other-session', targetEntityId: 'different-zombie', targetName: 'zombie', position: { x: 2, y: 64, z: 0 }, world: launch.rules.world, dimension: 'overworld', expiresAt: Date.now() + 10000 };
  const task = { kind: 'fight', params, completion: { kind: 'entity-death', minimum: 1, targetId: 'different-zombie' } } as unknown as TaskSpec;
  await assert.rejects(f.executor.execute(task, f.services), ConditionWait); assert.equal(f.attacks, 0);
  params.targetEntityId = f.target.uuid!; params.expiresAt = Date.now() - 1;
  await assert.rejects(f.executor.execute(task, f.services), ConditionWait); assert.equal(f.attacks, 0);
  params.expiresAt = Date.now() + 10000;
  await f.executor.execute(task, f.services); assert.equal(f.attacks, 1);
  assert.equal(f.services.observations.filter(o => o.kind === 'entity-death').length, 1);
});

test('reused numeric entity IDs cannot redirect a fight or confirm another entity death', async () => {
  const f = fixture(); f.slots[36] = { name: 'iron_sword', count: 1 };
  f.raw.lookAt = async () => { f.raw.entities[2] = { ...f.target, uuid: 'replacement-zombie' } as Entity; f.raw.emit('entityDead', f.raw.entities[2]); };
  await assert.rejects(f.executor.fightEntity(f.target, f.services), ConditionWait);
  assert.equal(f.attacks, 0); assert.equal(f.services.observations.some(o => o.kind === 'entity-death'), false);
});
