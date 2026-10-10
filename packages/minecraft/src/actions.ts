import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Block } from 'prismarine-block';
import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { ContainerRefSchema, PositionSchema, itemCount, type ActionKind, type BotConfig, type ContainerRef, type ObservationInput, type Position, type ResultPayload, type Rules, type TaskSpec } from '../../contracts/src';
import { ActionFailure, ConditionWait, checkAbort, pause, type ActionServices } from './services';
import { inventory, inventoryObservation, observationBase, position, vector } from './observations';
import { assessCombat, combatEquipment, rangedThreat, HUNTABLE, HOSTILES } from './combat-policy';
import { retreatToSafety, safeCombatRoute } from './combat-retreat';
import { exploreBuildSite } from './village-actions';
import { ResourceRecovery, safeResourceStand } from './resource-recovery';

export const EXECUTABLE_ACTIONS: ActionKind[] = ['collect', 'store', 'take', 'craft', 'smelt', 'build', 'farm', 'hunt', 'fight', 'guard', 'explore', 'follow', 'home', 'sleep', 'survive', 'breed'];
const unsafeBlocks = new Set(['lava', 'magma_block', 'fire', 'soul_fire', 'cactus', 'campfire', 'soul_campfire']);
const foodNames = new Set(['carrot', 'potato', 'beetroot', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'baked_potato', 'apple', 'melon_slice', 'sweet_berries', 'beef', 'porkchop', 'mutton', 'rabbit']);
const smeltInputs: Record<string, string> = { iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone', smooth_stone: 'stone', charcoal: 'oak_log', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken', cooked_mutton: 'mutton', cooked_rabbit: 'rabbit', baked_potato: 'potato' };
const dropBlocks: Record<string, string[]> = { cobblestone: ['stone', 'cobblestone'], raw_iron: ['iron_ore', 'deepslate_iron_ore'], raw_gold: ['gold_ore', 'deepslate_gold_ore'], raw_copper: ['copper_ore', 'deepslate_copper_ore'], coal: ['coal_ore', 'deepslate_coal_ore'], diamond: ['diamond_ore', 'deepslate_diamond_ore'], wheat_seeds: ['short_grass', 'tall_grass'], dirt: ['dirt', 'grass_block'], wheat: ['wheat'], carrot: ['carrots'], potato: ['potatoes'], beetroot: ['beetroots'] };
const huntDrops: Record<string, string> = { beef: 'cow', leather: 'cow', porkchop: 'pig', chicken: 'chicken', mutton: 'sheep', white_wool: 'sheep', rabbit: 'rabbit' };
type CraftRecipe = ReturnType<Bot['recipesAll']>[number];
interface RecipeEvaluation {
  remaining: number;
  table: Block | null;
  recipes: Map<string, CraftRecipe[]>;
  sources: Map<string, Block | null>;
  costs: Map<string, number>;
  resourceNames: Set<string>;
}
const recipeKey = (recipe: CraftRecipe) => recipe.delta.map(i => `${i.id}:${i.metadata}:${i.count}`).sort().join('|');

function rayPosition(hit: unknown): Vec3 | undefined {
  const value = hit as { position?: { x: number; y: number; z: number }; x?: number; y?: number; z?: number };
  const p = value.position ?? value;
  return [p.x, p.y, p.z].every(n => typeof n === 'number' && Number.isFinite(n)) ? new Vec3(p.x!, p.y!, p.z!) : undefined;
}

export interface ExecutorOptions {
  world: string;
  dimension(): string;
  config: BotConfig;
  rules: Rules;
  onProgress?(action: string, reason: string): void;
  villageTask?(task: TaskSpec, services: ActionServices): Promise<ResultPayload>;
}

export class MineflayerExecutor {
  fighting = false;
  private readonly ownedUtilities = new Map<string, Vec3>();
  constructor(readonly bot: Bot, readonly options: ExecutorOptions) {}
  setRules(rules: Rules, config = this.options.config): void { this.options.rules = rules; this.options.config = config; }
  count(item: string): number { return itemCount(inventory(this.bot), item); }
  stopControls(): void { this.bot.pathfinder.setGoal(null); this.bot.clearControlStates(); this.bot.deactivateItem(); if (this.bot.targetDigBlock) this.bot.stopDigging(); }

  services(signal: AbortSignal, checkpoint: ActionServices['checkpoint'] = {}): ActionServices {
    const s: ActionServices = {
      bot: this.bot, rules: this.options.rules, signal, checkpoint, observations: [], evidence: [],
      check: () => checkAbort(signal), pause: (ms) => pause(ms, signal), near: (p, radius) => this.near(p, signal, radius),
      ensureItem: (item, quantity) => this.ensureItem(item, quantity, s), place: (p, item, expected, face) => this.place(p, item, expected, s, face),
      recoverDrops: (p, item, minimum, avoidSupports) => this.pickup(p, s, item, minimum, avoidSupports),
      observeInventory: () => inventoryObservation(this.bot, this.options.world, this.options.dimension()),
      progress: (action, reason) => this.options.onProgress?.(action, reason),
    };
    return s;
  }

  private recordInventory(s: ActionServices): void { s.observations.push(s.observeInventory()); }
  private result(s: ActionServices, reason?: string): ResultPayload { return { outcome: 'completed', observations: s.observations, evidence: s.evidence, checkpoint: s.checkpoint, ...(reason ? { reason } : {}) }; }

  async near(p: { x: number; y: number; z: number }, signal: AbortSignal, radius = 2): Promise<void> {
    checkAbort(signal);
    const target = vector(p);
    if (this.bot.entity.position.distanceTo(target) <= radius + 0.5) return;
    const cancel = () => this.bot.pathfinder.setGoal(null);
    signal.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, 20000);
    try {
      await this.bot.pathfinder.goto(new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), radius));
      checkAbort(signal);
      if (this.bot.entity.position.distanceTo(target) > radius + 1.5) throw new ConditionWait('목표 위치에 접근할 경로를 확인해야 합니다.');
    } catch (error) {
      checkAbort(signal);
      if (error instanceof ActionFailure) throw error;
      if (timedOut) throw new ConditionWait(`20초 동안 목표 위치 ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}에 접근하지 못해 이동을 중단했습니다.`);
      throw error instanceof ConditionWait ? error : new ConditionWait(`현재 지형에서 접근 가능한 경로를 찾지 못했습니다: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }

  async place(p: { x: number; y: number; z: number }, itemName: string, expectedName: string | undefined, s: ActionServices, face?: { x: number; y: number; z: number }): Promise<void> {
    s.check();
    const target = vector(p), existing = this.bot.blockAt(target);
    if (!existing) throw new ConditionWait('설치 위치의 청크 관측을 기다립니다.');
    if (expectedName && existing.name === expectedName) return;
    if (!['air', 'cave_air', 'void_air'].includes(existing.name)) throw new ConditionWait(`설치 위치에 기존 ${existing.name} 블록이 있습니다.`);
    const item = this.bot.inventory.items().find((i) => i.name === itemName);
    if (!item) throw new ConditionWait(`${itemName} 재료가 필요합니다.`, { missingItem: itemName });
    await s.near(p, 3);
    await this.bot.equip(item, 'hand'); s.check();
    let inventoryBeforePlacement = this.count(itemName);
    if (['wheat', 'carrots', 'potatoes', 'beetroots'].includes(expectedName ?? '')) {
      const soil = this.bot.blockAt(target.offset(0, -1, 0));
      if (soil?.name !== 'farmland') throw new ConditionWait('파종할 경작지를 확인해야 합니다.');
      await this.bot.activateBlock(soil, new Vec3(0, 1, 0), new Vec3(0.5, 0.9375, 0.5));
    } else {
      const defaults = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)];
      const fixedFace = ['wall_torch', 'ladder'].includes(expectedName ?? '') || (expectedName ?? '').endsWith('_bed') || (expectedName ?? '').endsWith('_door');
      const faces = face ? fixedFace ? [vector(face)] : [vector(face), ...defaults.filter(f => !f.equals(vector(face)))] : defaults;
      const candidates = faces.map(f => ({ face: f, reference: this.bot.blockAt(target.minus(f)) }))
        .filter((r): r is { face: Vec3; reference: Block } => !!r.reference && r.reference.boundingBox === 'block' && !unsafeBlocks.has(r.reference.name));
      if (!candidates.length) throw new ConditionWait('블록을 설치할 지지체가 필요합니다.');
      const click = (r: { face: Vec3; reference: Block }) => r.reference.position.offset(0.5 + r.face.x * 0.5, 0.5 + r.face.y * 0.5, 0.5 + r.face.z * 0.5);
      const visible = (r: { face: Vec3; reference: Block }) => {
        const eye = vector(this.bot.entity.position).offset(0, 1.62, 0), delta = click(r).minus(eye), length = delta.norm();
        if (length > 4.5) return false;
        const hit = this.bot.world.raycast(eye, delta.scaled(1 / (length || 1)), Math.max(0, length - 0.02));
        if (!hit) return true;
        const hitBlock = rayPosition(hit);
        const expectedFace = r.face.y === 1 ? 1 : r.face.y === -1 ? 0 : r.face.z === -1 ? 2 : r.face.z === 1 ? 3 : r.face.x === -1 ? 4 : 5;
        return !!hitBlock?.equals(vector(r.reference.position)) && hit.face === expectedFace;
      };
      const occupiesTarget = () => {
        const feet = this.bot.entity.position, halfWidth = (this.bot.entity.width ?? 0.6) / 2;
        return feet.x + halfWidth > target.x && feet.x - halfWidth < target.x + 1 &&
          feet.z + halfWidth > target.z && feet.z - halfWidth < target.z + 1 &&
          feet.y < target.y + 1 && feet.y + (this.bot.entity.height ?? 1.8) > target.y;
      };
      const attempts = new Set<string>();
      const attemptKey = (r: { face: Vec3 }) => `${this.bot.entity.position.floored()}:${r.face}`;
      const choose = () => occupiesTarget() ? undefined : [...candidates]
        .sort((a, b) => click(a).distanceTo(vector(this.bot.entity.position)) - click(b).distanceTo(vector(this.bot.entity.position)))
        .find(r => !attempts.has(attemptKey(r)) && visible(r));
      const floorY = Math.floor(this.bot.entity.position.y);
      const standHeights = [...new Set([floorY, floorY - 1, floorY + 1, Math.floor(p.y), Math.floor(p.y) + 1])];
      const stands = standHeights.flatMap(y =>
        [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2], [-1, 0], [1, 0], [0, -1], [0, 1]]
          .map(([dx, dz]) => new Vec3(p.x + dx, y, p.z + dz)))
        .filter(q => {
          const ground = this.bot.blockAt(q.offset(0, -1, 0)), feet = this.bot.blockAt(q), head = this.bot.blockAt(q.offset(0, 1, 0));
          return ground?.boundingBox === 'block' && feet?.boundingBox === 'empty' && head?.boundingBox === 'empty' &&
            ![ground.name, feet.name, head.name].some(name => unsafeBlocks.has(name));
        })
        .sort((a, b) => a.distanceTo(vector(this.bot.entity.position)) - b.distanceTo(vector(this.bot.entity.position)));
      let standIndex = 0, placed = false, refused = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        let placement = choose();
        while (!placement && standIndex < stands.length) {
          const stand = stands[standIndex++];
          try { await s.near(stand.offset(0.5, 0, 0.5), 0); } catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; continue; }
          placement = choose();
        }
        if (!placement) break;
        s.check(); attempts.add(attemptKey(placement));
        // Movement or the last server inventory packet may change the selected stack.
        const available = this.bot.inventory.items().find(i => i.name === itemName && i.count > 0);
        if (!available) throw new ConditionWait(`${itemName} 재료를 실제 인벤토리에서 다시 확인해야 합니다.`);
        await this.bot.equip(available, 'hand'); s.check();
        const beforeItems = this.count(itemName);
        inventoryBeforePlacement = beforeItems;
        try { await this.bot.placeBlock(placement.reference, placement.face); placed = true; break; }
        catch (error) {
          const current = this.bot.blockAt(target);
          if (current?.name === (expectedName ?? itemName)) { placed = true; break; }
          const cause = error instanceof Error ? error.message : String(error);
          const confirmedRefusal = /Server refused(?: to place| block placement)/.test(cause);
          if (!confirmedRefusal || !current || !['air', 'cave_air', 'void_air'].includes(current.name) || this.count(itemName) < beforeItems)
            throw new ActionFailure(`설치 응답과 실제 블록 상태를 확인해야 합니다. ${JSON.stringify({ target: position(target), item: itemName, expected: expectedName ?? itemName, actual: current?.name ?? 'unloaded', inventoryDelta: this.count(itemName) - beforeItems, held: this.bot.heldItem ? { name: this.bot.heldItem.name, count: this.bot.heldItem.count } : null, reference: position(placement.reference.position), face: position(placement.face), bot: position(this.bot.entity.position), cause })}`, 'PLACE_UNCERTAIN', false, false);
          s.check();
          refused = true;
        }
      }
      if (!placed) throw new ConditionWait(`${refused ? '서버가 설치를 거부했습니다. 다른 설치 면과 안전한 위치를 다시 확인합니다.' : '실제 설치 면까지 시야와 도달 가능한 위치를 확보해야 합니다.'} ${JSON.stringify({ target: position(target), item: itemName, bot: position(this.bot.entity.position), candidates: candidates.map(candidate => ({ reference: position(candidate.reference.position), face: position(candidate.face) })) })}`);
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && this.bot.blockAt(target)?.name !== (expectedName ?? itemName)) await pause(50, s.signal);
    const observed = this.bot.blockAt(target);
    if (!observed || observed.name !== (expectedName ?? itemName)) throw new ActionFailure('설치 결과를 서버 관측으로 확인하지 못했습니다.', 'PLACE_UNCERTAIN', false, false);
    s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'blocks', data: { blocks: [{ position: position(target), name: observed.name }] } });
    // Block updates precede slot updates. Confirm this consumption before using
    // the next stack, so a late previous update cannot be mistaken for new effects.
    const inventoryDeadline = Date.now() + 2000;
    while (this.count(itemName) >= inventoryBeforePlacement && Date.now() < inventoryDeadline) await pause(50, s.signal);
    if (this.count(itemName) >= inventoryBeforePlacement) {
      this.recordInventory(s);
      throw new ActionFailure(`설치 블록은 확인했지만 재료 소비 보고를 기다려야 합니다. ${JSON.stringify({ target: position(target), item: itemName, actual: observed.name, inventoryDelta: this.count(itemName) - inventoryBeforePlacement })}`, 'PLACE_UNCERTAIN', false, false);
    }
    s.check();
  }

  async observeContainer(container: ContainerRef, s: ActionServices): Promise<ObservationInput> {
    this.assertContainer(container);
    await s.near(container.position, 2);
    const block = this.bot.blockAt(vector(container.position));
    if (!block || !['chest', 'trapped_chest', 'barrel'].includes(block.name)) throw new ConditionWait('지정한 공동 창고를 실제로 확인해야 합니다.');
    const window = await this.bot.openContainer(block);
    try {
      const result: ObservationInput = { ...observationBase(this.options.world, this.options.dimension()), kind: 'container', data: { container, items: window.containerItems().map((i) => ({ name: i.name, count: i.count })) } };
      s.observations.push(result); this.recordInventory(s); return result;
    } finally { await window.close(); }
  }
  private assertContainer(container: ContainerRef): void {
    if (container.world !== this.options.world || container.dimension !== this.options.dimension()) throw new ConditionWait('공동 창고의 서버와 차원이 현재 연결과 다릅니다.');
  }
  private async transfer(container: ContainerRef, itemName: string, quantity: number, direction: 'store' | 'take', s: ActionServices): Promise<void> {
    this.assertContainer(container); s.check();
    const data = this.bot.registry.itemsByName[itemName];
    if (!data || !Number.isInteger(quantity) || quantity <= 0) throw new ConditionWait('이동할 아이템과 수량을 확인해야 합니다.');
    await s.near(container.position, 2);
    const block = this.bot.blockAt(vector(container.position));
    if (!block || !['chest', 'trapped_chest', 'barrel'].includes(block.name)) throw new ConditionWait('지정한 창고가 없거나 관측되지 않았습니다.');
    const window = await this.bot.openContainer(block);
    let started = false;
    try {
      const beforeInventory = itemCount(window.items().map((i) => ({ name: i.name, count: i.count })), itemName);
      const beforeContainer = itemCount(window.containerItems().map((i) => ({ name: i.name, count: i.count })), itemName);
      if ((direction === 'store' ? beforeInventory : beforeContainer) < quantity) throw new ConditionWait('실제 출발지 물자가 요청한 수량보다 적습니다.');
      s.check(); started = true;
      if (direction === 'store') await window.deposit(data.id, null, quantity); else await window.withdraw(data.id, null, quantity);
      const afterInventory = itemCount(window.items().map((i) => ({ name: i.name, count: i.count })), itemName);
      const afterContainer = itemCount(window.containerItems().map((i) => ({ name: i.name, count: i.count })), itemName);
      const evidence = { kind: 'transfer' as const, container, item: itemName, quantity, direction, beforeInventory, afterInventory, beforeContainer, afterContainer };
      s.evidence.push(evidence);
      s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'container', data: { container, items: window.containerItems().map((i) => ({ name: i.name, count: i.count })) } });
      this.recordInventory(s);
      const delta = direction === 'store' ? quantity : -quantity;
      if (beforeInventory - afterInventory !== delta || afterContainer - beforeContainer !== delta) throw new ActionFailure('출발지와 도착지의 수량 변화가 일치하지 않습니다.', 'TRANSFER_UNCERTAIN', false, false);
      s.check();
    } catch (error) {
      if (started && !(error instanceof ActionFailure)) throw new ActionFailure('운반을 시작했지만 결과가 불확실합니다. 창고를 다시 확인해야 합니다.', 'TRANSFER_UNCERTAIN', false, false);
      throw error;
    } finally { await window.close(); }
  }

  private collectMatches(itemName: string, blockName: string): boolean { return (dropBlocks[itemName] ?? [itemName]).includes(blockName); }
  private harvestTool(blockName: string): string { return /diamond|gold|redstone|emerald/.test(blockName) ? 'iron_pickaxe' : /iron|copper|lapis/.test(blockName) ? 'stone_pickaxe' : 'wooden_pickaxe'; }
  private collectible(block: Block, s: ActionServices): boolean {
    return !this.protectedBuildPosition(block.position, s) && (!block.name.endsWith('_log') || this.naturalLog(block.position)) &&
      (!['wheat', 'carrots', 'potatoes', 'beetroots'].includes(block.name) || Number(block.getProperties().age) >= (block.name === 'beetroots' ? 3 : 7)) &&
      this.bot.blockAt(block.position.offset(0, 1, 0))?.name !== 'lava' && !unsafeBlocks.has(this.bot.blockAt(block.position.offset(0, -1, 0))?.name ?? '');
  }
  private naturalLog(p: Vec3): boolean {
    for (let dy = 1; dy <= 8; dy++) for (const [dx, dz] of [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]]) if (this.bot.blockAt(p.offset(dx, dy, dz))?.name.endsWith('_leaves')) return true;
    return false;
  }
  private protectedBuildPosition(p: { x: number; y: number; z: number }, s: ActionServices): boolean {
    for (const field of ['protectedPositions', 'buildPreparationProtection']) {
      const cells = s.checkpoint[field];
      if (Array.isArray(cells) && cells.some(value => value && typeof value === 'object' && 'x' in value && 'y' in value && 'z' in value && value.x === p.x && value.y === p.y && value.z === p.z)) return true;
    }
    const area = s.checkpoint.buildProtection as { origin?: { x: number; y: number; z: number }; width?: number; depth?: number; height?: number } | undefined;
    const origin = area?.origin;
    if (!origin || !Number.isFinite(area?.width) || !Number.isFinite(area?.depth) || !Number.isFinite(area?.height)) return false;
    return p.x >= origin.x - 1 && p.x <= origin.x + area!.width! && p.z >= origin.z - 1 && p.z <= origin.z + area!.depth! && p.y >= origin.y - 1 && p.y <= origin.y + Math.max(2, area!.height!);
  }
  private resourceRecovery(item: string, names: string[], s: ActionServices): ResourceRecovery {
    return new ResourceRecovery(this.bot, s, item, names, this.options.config.allowedActions.includes('explore') && (s.checkpoint.resourceRecoveryScope !== '$food' || item === '$food'), p => this.protectedBuildPosition(p, s));
  }
  private resourceStands(block: Block, s: ActionServices): Position[] {
    if (!block.boundingBox) return [];
    const feet = vector(this.bot.entity.position).floored();
    if (block.position.equals(feet) || block.position.equals(feet.offset(0, -1, 0))) return [];
    if (![new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].some(d => ['air', 'cave_air', 'void_air'].includes(this.bot.blockAt(block.position.plus(d))?.name ?? ''))) return [];
    const candidates = [feet];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) for (const dy of [-2, -1, 0, 1, 2]) candidates.push(block.position.offset(dx!, dy, dz!));
    return [...new Map(candidates.map(p => [`${p.x},${p.y},${p.z}`, p])).values()].filter(p => p.distanceTo(block.position) <= 4 && Math.abs(p.y - feet.y) <= 3 && safeResourceStand(this.bot, p, q => this.protectedBuildPosition(q, s)))
      .sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet)).slice(0, 3);
  }
  private currentSupport(block: Block): boolean {
    const feet = vector(this.bot.entity.position).floored();
    return block.position.equals(feet) || block.position.equals(feet.offset(0, -1, 0));
  }
  private async collect(itemName: string, minimum: number, s: ActionServices): Promise<void> {
    if (!this.options.config.allowedActions.includes('collect')) throw new ConditionWait('이 봇에는 수집 작업이 허용되지 않았습니다.');
    const recovery = this.resourceRecovery(itemName, dropBlocks[itemName] ?? [itemName], s);
    const skipped = new Set<string>();
    let attempts = 0;
    while (this.count(itemName) < minimum) {
      s.check(); s.progress('수집', `${itemName} ${this.count(itemName)}/${minimum}`);
      if (this.bot.inventory.emptySlotCount() === 0 && !this.bot.inventory.items().some((i) => i.name === itemName && i.count < i.stackSize)) throw new ConditionWait('인벤토리 공간을 확보해야 합니다.');
      const block = this.bot.findBlock({ matching: (b) => this.collectMatches(itemName, b.name), useExtraInfo: (b) =>
        !skipped.has(`${b.position}`) && !recovery.failed(b.position) && recovery.within(b.position) && this.collectible(b, s), maxDistance: 48 });
      if (!block || !recovery.canApproach()) {
        if (await recovery.move()) continue;
        throw recovery.wait(`관측된 자원과 안전한 지상 탐색을 확인했지만 ${itemName}을 확보하지 못했습니다. ${recovery.state.reason || '새 자원이나 접근 지형의 실제 변화를 기다립니다.'}`, minimum);
      }
      if (++attempts > 128) {
        if (await recovery.move()) { attempts = 0; continue; }
        throw recovery.wait('현재 위치의 자원 후보 128개를 확인했지만 접근 가능한 노출면을 찾지 못했습니다. 실제 자원이나 접근 지형의 변화를 기다립니다.', minimum);
      }
      recovery.sample(block.position);
      const stands = this.resourceStands(block, s);
      if (!stands.length) { skipped.add(`${block.position}`); recovery.reject(block.position, block.name, '자원까지 노출된 면과 안전하게 설 수 있는 지상 발판을 확인하지 못했습니다.'); continue; }
      let stand: Position | undefined, approachReason = '';
      for (const candidate of stands) {
        if (!recovery.canApproach()) break;
        try {
          await recovery.approach(vector(candidate).offset(0.5, 0, 0.5), 0);
          const actual = this.bot.blockAt(block.position);
          if (!actual || typeof this.bot.canSeeBlock !== 'function' || !this.bot.canSeeBlock(actual)) { approachReason = '안전한 발판에서 자원까지 실제 시야를 확인하지 못했습니다.'; continue; }
          stand = candidate; break;
        } catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; approachReason = error.message; }
      }
      if (!stand) { skipped.add(`${block.position}`); recovery.reject(block.position, block.name, approachReason); continue; }
      const approach = async () => recovery.approach(vector(stand!).offset(0.5, 0, 0.5), 0);
      let current = this.bot.blockAt(block.position);
      if (!current || !this.collectMatches(itemName, current.name) || !this.collectible(current, s) || this.currentSupport(current)) { skipped.add(`${block.position}`); continue; }
      if (this.bot.blockAt(current.position.offset(0, 1, 0))?.name === 'lava' || unsafeBlocks.has(this.bot.blockAt(current.position.offset(0, -1, 0))?.name ?? '')) { skipped.add(`${block.position}`); continue; }
      if (!current.canHarvest(this.bot.heldItem?.type ?? null)) {
        const tool = this.harvestTool(current.name);
        await this.ensureItem(tool, 1, s);
        const available = this.bot.inventory.items().find((i) => i.name === tool);
        if (!available) throw new ConditionWait(`${tool} 도구를 확보해야 합니다.`);
        // Tool ingredients and the crafting table may be far from this resource.
        try { await approach(); }
        catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; skipped.add(`${block.position}`); recovery.reject(block.position, block.name, error.message); continue; }
        current = this.bot.blockAt(block.position);
        if (!current || !this.collectMatches(itemName, current.name) || !this.collectible(current, s) || this.currentSupport(current)) { skipped.add(`${block.position}`); continue; }
        if (this.bot.blockAt(current.position.offset(0, 1, 0))?.name === 'lava' || unsafeBlocks.has(this.bot.blockAt(current.position.offset(0, -1, 0))?.name ?? '')) { skipped.add(`${block.position}`); continue; }
        await this.bot.equip(available, 'hand');
        if (!current.canHarvest(available.type)) throw new ConditionWait('이 블록을 수확할 수 있는 도구가 필요합니다.');
      } else {
        const blockName = current.name;
        const tool = this.bot.inventory.items().find((i) => blockName.endsWith('_log') ? i.name.endsWith('_axe') : /stone|ore/.test(blockName) ? i.name.endsWith('_pickaxe') : i.name.endsWith('_shovel'));
        if (tool) await this.bot.equip(tool, 'hand');
      }
      current = this.bot.blockAt(block.position);
      if (!current || !this.collectMatches(itemName, current.name) || !this.collectible(current, s) || this.currentSupport(current) || !safeResourceStand(this.bot, vector(this.bot.entity.position).floored(), p => this.protectedBuildPosition(p, s))) { skipped.add(`${block.position}`); continue; }
      if (typeof this.bot.canSeeBlock !== 'function' || !this.bot.canSeeBlock(current)) { skipped.add(`${current.position}`); recovery.reject(current.position, current.name, '현재 안전한 발판에서 자원까지 실제 시야를 확보하지 못했습니다.'); continue; }
      s.check(); const before = this.count(itemName);
      await this.bot.dig(current); await s.pause(150);
      await this.pickup(current.position, s, itemName, before + 1);
      this.recordInventory(s);
      s.checkpoint.lastResourcePosition = position(current.position);
      if (this.count(itemName) <= before) { skipped.add(`${current.position}`); recovery.reject(current.position, current.name, '채굴 후 실제 아이템 획득을 확인하지 못했습니다.'); }
      else recovery.progress();
    }
    this.recordInventory(s);
  }
  private async pickup(location: { x: number; y: number; z: number }, s: ActionServices, item?: string, minimum = Infinity, avoidSupports: Position[] = []): Promise<void> {
    const p = vector(location);
    for (let round = 0; round < (item ? 20 : 3); round++) {
      s.check();
      if (item && this.count(item) >= minimum) return;
      const drops = Object.values(this.bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(p) < 5);
      for (const drop of drops.slice(0, 12)) {
        // A freshly broken upper log can still be falling. Its first packet
        // is not a reachable stand position; reobserve until it has ground.
        const feet = drop.position.floored(), support = this.bot.blockAt(feet.offset(0, -1, 0));
        const body = this.bot.blockAt(feet), head = this.bot.blockAt(feet.offset(0, 1, 0));
        if (avoidSupports.some(p => p.x === feet.x && p.y === feet.y - 1 && p.z === feet.z)) return;
        if (support?.boundingBox !== 'block' || body?.boundingBox !== 'empty' || head?.boundingBox !== 'empty' ||
          [support.name, body.name, head.name].some(name => unsafeBlocks.has(name))) continue;
        try { await s.near({ x: drop.position.x, y: feet.y, z: drop.position.z }, 0); await s.pause(150); }
        catch (error) { s.check(); if (error instanceof ActionFailure) throw error; }
        if (item && this.count(item) >= minimum) return;
      }
      await s.pause(150);
    }
  }

  private recipes(item: string, evaluation: RecipeEvaluation): CraftRecipe[] {
    if (!evaluation.recipes.has(item)) {
      const data = this.bot.registry.itemsByName[item];
      evaluation.recipes.set(item, data ? this.bot.recipesAll(data.id, null, true).slice(0, 128) : []);
    }
    return evaluation.recipes.get(item)!;
  }

  private recipeCost(recipe: CraftRecipe, minimum: number, current: number, chain: Set<string>, s: ActionServices, evaluation: RecipeEvaluation): number {
    const times = Math.ceil((minimum - current) / recipe.result.count);
    let cost = recipe.requiresTable && !evaluation.table ? this.acquisitionCost('crafting_table', 1, chain, s, evaluation) : 0;
    for (const ingredient of recipe.delta.filter(i => i.count < 0)) {
      const name = this.bot.registry.items[ingredient.id]?.name;
      if (!name) return Infinity;
      // Evaluate every ingredient so a wait can watch all candidate raw materials.
      cost += this.acquisitionCost(name, -ingredient.count * times, chain, s, evaluation);
    }
    return cost;
  }

  private acquisitionCost(item: string, minimum: number, chain: Set<string>, s: ActionServices, evaluation: RecipeEvaluation): number {
    s.check();
    const missing = minimum - this.count(item);
    if (missing <= 0) return 0;
    if (chain.has(item) || chain.size > 10 || evaluation.remaining-- <= 0) return Infinity;
    const cacheKey = `${item}:${minimum}:${[...chain].sort().join(',')}`;
    if (evaluation.costs.has(cacheKey)) return evaluation.costs.get(cacheKey)!;
    const next = new Set(chain); next.add(item);
    let cost = Infinity;
    if (item in dropBlocks || item.endsWith('_log') || ['sand', 'gravel'].includes(item)) {
      for (const name of dropBlocks[item] ?? [item]) evaluation.resourceNames.add(name);
      if (this.options.config.allowedActions.includes('collect')) {
        if (!evaluation.sources.has(item)) evaluation.sources.set(item, this.bot.findBlock({ matching: b => this.collectMatches(item, b.name), useExtraInfo: b => this.collectible(b, s), maxDistance: 48 }));
        const block = evaluation.sources.get(item);
        if (block) {
          const toolCost = block.canHarvest(this.bot.heldItem?.type ?? null) || this.bot.inventory.items().some(i => block.canHarvest(i.type)) ? 0 : this.acquisitionCost(this.harvestTool(block.name), 1, next, s, evaluation);
          // A source is a candidate, not proof of its total yield or accessibility.
          cost = missing + block.position.distanceTo(vector(this.bot.entity.position)) / 48 + toolCost;
        }
      }
    } else if (smeltInputs[item] && this.options.config.allowedActions.includes('smelt')) {
      const furnace = this.ownedUtilities.get('furnace');
      const furnaceCost = furnace && this.bot.blockAt(furnace)?.name === 'furnace' ? 0 : this.acquisitionCost('furnace', 1, next, s, evaluation);
      const fuelCost = Math.min(...['coal', 'charcoal', 'oak_planks'].map(fuel => this.acquisitionCost(fuel, 1, next, s, evaluation)));
      cost = this.acquisitionCost(smeltInputs[item], minimum, next, s, evaluation) + furnaceCost + fuelCost;
    } else if (this.options.config.allowedActions.includes('craft')) {
      for (const recipe of this.recipes(item, evaluation)) {
        if (evaluation.remaining-- <= 0) break;
        cost = Math.min(cost, this.recipeCost(recipe, minimum, this.count(item), next, s, evaluation));
      }
    }
    if (!Number.isFinite(cost) && item in huntDrops && this.options.config.allowedActions.includes('hunt')) {
      evaluation.resourceNames.add(huntDrops[item]!);
      const seen = Object.values(this.bot.entities).some(e => e.name === huntDrops[item] && e.position.distanceTo(this.bot.entity.position) <= 40 &&
        !(s.rules.center && Math.hypot(e.position.x - s.rules.center.x, e.position.z - s.rules.center.z) <= s.rules.radius));
      if (seen) cost = missing;
    }
    evaluation.costs.set(cacheKey, cost);
    return cost;
  }

  async ensureItem(itemName: string, minimum: number, s: ActionServices, chain: Set<string> = new Set()): Promise<void> {
    s.check();
    if (!chain.size) {
      delete s.checkpoint.missingResource; delete s.checkpoint.missingItem;
      delete s.checkpoint.resourceNames; delete s.checkpoint.minimum;
    }
    if (this.count(itemName) >= minimum) return;
    if (chain.has(itemName) || chain.size > 10) throw new ConditionWait(`${itemName} 재료를 확보할 경로가 필요합니다.`);
    const next = new Set(chain); next.add(itemName);
    const data = this.bot.registry.itemsByName[itemName];
    if (!data) throw new ConditionWait(`현재 Minecraft 버전에는 ${itemName} 아이템이 없습니다.`);
    if (itemName in dropBlocks || itemName.endsWith('_log') || ['sand', 'gravel'].includes(itemName)) { await this.collect(itemName, minimum, s); return; }
    if (smeltInputs[itemName] && this.options.config.allowedActions.includes('smelt')) { await this.smelt(itemName, minimum, s, next); return; }
    let table = this.bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 24 });
    const evaluation: RecipeEvaluation = { remaining: 1024, table, recipes: new Map(), sources: new Map(), costs: new Map(), resourceNames: new Set() };
    const recipes = this.recipes(itemName, evaluation).filter(r => r.delta.filter(i => i.count < 0).every(i => !next.has(this.bot.registry.items[i.id]?.name ?? '')));
    const candidates = this.options.config.allowedActions.includes('craft') ? recipes.map(recipe => ({ recipe, cost: this.recipeCost(recipe, minimum, this.count(itemName), next, s, evaluation),
      inventoryMissing: recipe.delta.filter(i => i.count < 0).reduce((sum, i) => sum + Math.max(0, -i.count * Math.ceil((minimum - this.count(itemName)) / recipe.result.count) - this.count(this.bot.registry.items[i.id]?.name ?? '')), 0) }))
      .filter(candidate => Number.isFinite(candidate.cost)).sort((a, b) => a.inventoryMissing - b.inventoryMissing || a.cost - b.cost) : [];
    let prepared: CraftRecipe | undefined, preparationWait: ConditionWait | undefined;
    for (const { recipe } of candidates.slice(0, 5)) {
      try {
        const times = Math.ceil((minimum - this.count(itemName)) / recipe.result.count);
        if (recipe.requiresTable && !table) {
          await this.ensureItem('crafting_table', 1, s, next);
          table = await this.placeUtility('crafting_table', s);
        }
        const ingredients = recipe.delta.filter(i => i.count < 0).map(i => ({ name: this.bot.registry.items[i.id]?.name, minimum: -i.count * times }));
        if (ingredients.some(i => !i.name)) throw new ConditionWait('제작 재료의 아이템 정보를 확인해야 합니다.');
        // Making sticks can consume planks already prepared for a pickaxe.
        for (let round = 0; round < 4; round++) {
          const missing = ingredients.filter(i => this.count(i.name!) < i.minimum);
          if (!missing.length) break;
          for (const ingredient of missing) await this.ensureItem(ingredient.name!, ingredient.minimum, s, next);
        }
        if (ingredients.some(i => this.count(i.name!) < i.minimum)) throw new ConditionWait('중간 제작에서 소비한 재료를 다시 확보해야 합니다.');
        if (table) await s.near(table.position, 2);
        prepared = recipe; break;
      } catch (error) {
        s.check();
        if (!(error instanceof ConditionWait)) throw error;
        preparationWait = error;
        // Only known preparation waits may change recipe. Crafting effects never retry here.
        this.recordInventory(s);
      }
    }
    if (prepared) {
      s.check(); s.progress('제작', `${itemName} 제작과 산출물을 확인합니다.`);
      let crafts = 0;
      while (this.count(itemName) < minimum) {
        s.check();
        if (++crafts > 128) throw new ConditionWait('제작을 계속하기 전에 물자와 남은 수량을 다시 확인해야 합니다.');
        const before = this.count(itemName);
        const possibleRecipes = this.bot.recipesFor(data.id, null, 1, table);
        const possible = possibleRecipes.find(r => recipeKey(r) === recipeKey(prepared!)) ?? possibleRecipes[0];
        if (!possible) throw new ConditionWait('현재 재료와 작업대에서 제작 가능한 조합이 없습니다.');
        // Separate public craft calls let the final click settle before the next recipe.
        await this.bot.craft(possible, 1, table ?? undefined);
        await s.pause(150);
        const deadline = Date.now() + 2000;
        while (this.count(itemName) < before + possible.result.count && Date.now() < deadline) { s.check(); await s.pause(50); }
        this.recordInventory(s); s.check();
        if (this.count(itemName) < before + possible.result.count) throw new ActionFailure('제작 산출물을 확인하지 못했습니다.', 'CRAFT_UNCERTAIN', false, false);
      }
      return;
    }
    if (itemName in huntDrops && this.options.config.allowedActions.includes('hunt')) {
      await this.hunt(huntDrops[itemName], s, itemName, minimum); return;
    }
    if (this.recipes(itemName, evaluation).length) {
      const recovery = this.resourceRecovery(itemName, [...evaluation.resourceNames].slice(0, 100), s);
      if (await recovery.move()) return this.ensureItem(itemName, minimum, s, chain);
      const error = recovery.wait(preparationWait?.message ?? `${itemName}에 필요한 재료를 실제 인벤토리나 주변 자연 자원에서 확보할 수 있는 제작 경로가 필요합니다.`, minimum);
      delete error.checkpoint.missingResource; error.checkpoint.missingItem = itemName;
      throw error;
    }
    await this.collect(itemName, minimum, s);
  }

  private async placeUtility(itemName: string, s: ActionServices) {
    const old = this.ownedUtilities.get(itemName);
    if (old && this.bot.blockAt(old)?.name === itemName) return this.bot.blockAt(old)!;
    const origin = this.bot.entity.position.floored();
    const offsets = [2, 4, 6, 8, 10, 12].flatMap(distance => [[distance, 0], [-distance, 0], [0, distance], [0, -distance], [distance, distance], [-distance, -distance]]);
    for (const [dx, dz] of offsets) {
      const p = origin.offset(dx, 0, dz), block = this.bot.blockAt(p), below = this.bot.blockAt(p.offset(0, -1, 0));
      if (this.protectedBuildPosition(p, s)) continue;
      if (block?.name !== 'air' || below?.boundingBox !== 'block' || unsafeBlocks.has(below.name)) continue;
      await this.place(p, itemName, itemName, s);
      this.ownedUtilities.set(itemName, vector(p)); s.checkpoint[`${itemName}Position`] = position(p);
      return this.bot.blockAt(p)!;
    }
    throw new ConditionWait(`${itemName}을 설치할 빈 공간과 지지체가 필요합니다.`);
  }
  private async smelt(itemName: string, minimum: number, s: ActionServices, chain = new Set<string>()): Promise<void> {
    const input = smeltInputs[itemName];
    if (!input) throw new ConditionWait('지원하는 제련 산출물을 선택해 주세요.');
    const amount = Math.max(0, minimum - this.count(itemName)); if (!amount) return;
    await this.ensureItem(input, amount, s, chain);
    const savedFurnace = PositionSchema.safeParse(s.checkpoint.furnacePosition);
    if (savedFurnace.success && this.bot.blockAt(vector(savedFurnace.data))?.name === 'furnace') this.ownedUtilities.set('furnace', vector(savedFurnace.data));
    if (!this.ownedUtilities.has('furnace')) await this.ensureItem('furnace', 1, s, chain);
    const furnaceBlock = await this.placeUtility('furnace', s);
    let fuel = this.bot.inventory.items().find((i) => ['coal', 'charcoal'].includes(i.name) && i.count >= Math.ceil(amount / 8));
    if (!fuel) { await this.ensureItem('oak_planks', Math.ceil(amount / 1.5), s, chain); fuel = this.bot.inventory.items().find((i) => i.name === 'oak_planks'); }
    if (!fuel) throw new ConditionWait('제련 연료를 확보해야 합니다.');
    await s.near(furnaceBlock.position, 2); const furnace = await this.bot.openFurnace(furnaceBlock);
    try {
      const storedInput = furnace.inputItem(), output = furnace.outputItem();
      if (storedInput && storedInput.name !== input || output && output.name !== itemName) throw new ConditionWait('제련기의 기존 작업이 끝날 때까지 기다립니다.');
      const inputItem = this.bot.inventory.items().find((i) => i.name === input);
      if (!inputItem) throw new ConditionWait('제련 원재료를 확인해야 합니다.');
      const missingInput = Math.max(0, amount - (storedInput?.count ?? 0));
      if (missingInput > 0) await furnace.putInput(inputItem.type, null, missingInput);
      await furnace.putFuel(fuel.type, null, fuel.name === 'oak_planks' ? Math.ceil(amount / 1.5) : Math.ceil(amount / 8));
      const deadline = Date.now() + amount * 12000 + 15000;
      while (this.count(itemName) < minimum && Date.now() < deadline) {
        s.check(); s.progress('제련', `${itemName} ${this.count(itemName)}/${minimum}`);
        if (furnace.outputItem()?.name === itemName) { await furnace.takeOutput(); this.recordInventory(s); }
        await s.pause(250);
      }
      if (this.count(itemName) < minimum) throw new ConditionWait('제련 산출물을 계속 확인해야 합니다.', { furnacePosition: position(furnaceBlock.position), item: itemName, minimum });
    } finally { await furnace.close(); }
  }

  async ensureFood(s: ActionServices): Promise<void> {
    s.check();
    if (this.bot.inventory.items().some(i => foodNames.has(i.name))) return;
    const scope = s.checkpoint.resourceRecoveryScope;
    s.checkpoint.resourceRecoveryScope = '$food';
    let waiting: ConditionWait | undefined;
    try {
      for (let round = 0; round <= 5; round++) {
        s.check();
        const table = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 24 });
        const evaluation: RecipeEvaluation = { remaining: 1024, table, recipes: new Map(), sources: new Map(), costs: new Map(), resourceNames: new Set() };
        const candidates = [...foodNames].filter(item => {
          if (!this.bot.registry.itemsByName[item]) return false;
          // Critical health cannot authorize a new hunt during food recovery.
          const raw = smeltInputs[item] ?? item;
          return this.bot.health > s.rules.combat.retreatHealth || !(raw in huntDrops) || this.count(raw) > 0;
        }).map(item => ({ item, cost: this.acquisitionCost(item, 1, new Set(), s, evaluation) }))
          .filter(candidate => Number.isFinite(candidate.cost)).sort((a, b) => a.cost - b.cost);
        const recovery = this.resourceRecovery('$food', [...evaluation.resourceNames].slice(0, 100), s);
        for (const { item } of candidates.slice(0, 5)) {
          const started = Date.now();
          try { await this.ensureItem(item, 1, s); if (this.count(item) > 0) { recovery.progress(); return; } }
          catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; waiting = error; }
          finally { recovery.state.elapsedMs = Math.min(80000, recovery.state.elapsedMs + Math.max(0, Date.now() - started)); }
          if (recovery.state.elapsedMs >= 60000) break;
        }
        if (await recovery.move()) continue;
        const error = recovery.wait('현재 관측한 범위에서 확보 가능한 식량이나 재료를 확인하지 못했습니다.');
        delete error.checkpoint.missingResource;
        Object.assign(error.checkpoint, { missingFood: true, ...(waiting ? { foodCause: waiting.message } : {}) });
        const candidatePositions = waiting?.checkpoint.resourcePositions;
        if (Array.isArray(candidatePositions)) error.checkpoint.resourcePositions = [...new Map([...error.checkpoint.resourcePositions as Position[], ...candidatePositions as Position[]].map(p => [`${p.x},${p.y},${p.z}`, p])).values()].slice(-64);
        throw error;
      }
    } finally { if (scope === undefined) delete s.checkpoint.resourceRecoveryScope; else s.checkpoint.resourceRecoveryScope = scope; }
  }

  async eat(s: ActionServices): Promise<boolean> {
    if (this.bot.food >= 19) return false;
    const food = this.bot.inventory.items().find((i) => foodNames.has(i.name));
    if (!food) return false;
    const before = this.bot.food, count = this.count(food.name);
    await this.bot.equip(food, 'hand'); s.check(); await this.bot.consume(); this.recordInventory(s);
    if (this.bot.food <= before && this.count(food.name) >= count) throw new ActionFailure('섭취 결과를 확인하지 못했습니다.', 'EAT_UNCERTAIN', false, false);
    return true;
  }
  async retreat(target: Entity, s: ActionServices): Promise<void> {
    await retreatToSafety(this.bot, target, s, p => this.protectedBuildPosition(vector(p), s));
    s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'position', data: { position: position(this.bot.entity.position) } });
  }
  private combatDecision(target: Entity, s: ActionServices) {
    const threats = Object.values(this.bot.entities).filter(e => HOSTILES.has(e.name ?? '') && e.position.distanceTo(this.bot.entity.position) < 16);
    const allies = Object.values(this.bot.players).filter(player => player.entity && player.entity.id !== this.bot.entity.id && player.entity.position.distanceTo(this.bot.entity.position) < 8).length;
    // The caller already authorized this hostile or hunt target. Reuse the
    // gear and survival policy without reinterpreting an explicit fight goal
    // as an unsolicited attack.
    return assessCombat({ role: this.options.config.role, health: this.bot.health, food: this.bot.food, ...combatEquipment(this.bot), enemies: Math.max(1, threats.length), rangedEnemies: threats.filter(e => rangedThreat(e.name ?? '')).length, allies, attacked: true, threateningVillage: false, targetName: target.name ?? '', distance: target.position.distanceTo(this.bot.entity.position) }, { ...s.rules, combat: { ...s.rules.combat, counterattackWhenAttacked: true } });
  }
  private async approachCombat(target: Entity, s: ActionServices, validTarget: () => boolean): Promise<void> {
    const controller = new AbortController(); let unsafe = false, expired = false;
    const stop = () => { const decision = this.combatDecision(target, s); expired = !validTarget(); if (expired || ['retreat', 'support', 'ignore'].includes(decision.response)) { unsafe = true; controller.abort(); } };
    const parentAbort = () => controller.abort(); s.signal.addEventListener('abort', parentAbort, { once: true });
    this.bot.on('health', stop); this.bot.on('entityMoved', stop);
    const timer = setInterval(stop, 100);
    try { stop(); if (combatEquipment(this.bot).shield && rangedThreat(target.name ?? '')) this.bot.activateItem(true); await this.near(target.position, controller.signal, 2); }
    catch (error) { s.check(); if (unsafe && error instanceof ActionFailure && error.code === 'CANCELLED') { if (expired) throw new ConditionWait('지원 대상의 세션, 유효 시간과 관측을 다시 확인해야 합니다.'); return; } throw error; }
    finally { clearInterval(timer); this.bot.removeListener('health', stop); this.bot.removeListener('entityMoved', stop); s.signal.removeEventListener('abort', parentAbort); }
  }
  async fightEntity(target: Entity, s: ActionServices, hunt = false, validTarget: () => boolean = () => true): Promise<void> {
    if (target.type === 'player' || target.username || !(hunt ? HUNTABLE : HOSTILES).has(target.name ?? '')) throw new ConditionWait('허용된 전투 대상을 확인해야 합니다.');
    const targetId = target.uuid ?? `${target.id}`;
    const sameTarget = () => { const actual = this.bot.entities[target.id]; return !!actual && (actual.uuid ?? `${actual.id}`) === targetId && actual.name === target.name && actual.type !== 'player' && !actual.username && validTarget(); };
    this.fighting = true; let killed = false;
    const onDeath = (e: Entity) => { if ((e.uuid ?? `${e.id}`) === targetId && e.name === target.name) { killed = true; s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'entity-death', data: { entityId: e.uuid ?? `${e.id}`, entityName: e.name ?? target.name ?? 'unknown', position: position(e.position) } }); } };
    this.bot.on('entityDead', onDeath);
    try {
      const weapon = this.bot.inventory.items().filter((i) => /_(sword|axe)$/.test(i.name)).sort((a, b) => ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(b.name.split('_')[0]) - ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(a.name.split('_')[0]))[0];
      if (weapon) await this.bot.equip(weapon, 'hand');
      const deadline = Date.now() + 45000;
      while (this.bot.entities[target.id] && !killed && Date.now() < deadline) {
        s.check(); if (!sameTarget()) throw new ConditionWait('전투 대상의 고유 ID와 지원 요청의 유효 시간을 다시 확인해야 합니다.');
        const decision = this.combatDecision(target, s);
        if (['retreat', 'support', 'ignore'].includes(decision.response)) {
          s.progress('퇴각', decision.reason); await this.retreat(target, s); throw new ConditionWait('지원과 회복 후 전투를 다시 확인합니다.', s.checkpoint);
        }
        const distance = this.bot.entity.position.distanceTo(target.position);
        if (distance > 3) { s.progress('접근', `${target.name}에 접근합니다.`); await this.approachCombat(target, s, sameTarget); continue; }
        const start = this.bot.entity.position.offset(0, 1.62, 0), aim = target.position.offset(0, Math.min(target.height ?? 1, 1), 0), diff = aim.minus(start), length = diff.norm();
        const obstruction = this.bot.world.raycast(start, diff.scaled(1 / (length || 1)), Math.max(0, length - 0.3));
        const obstructionPosition = obstruction ? rayPosition(obstruction) : undefined;
        if (obstruction && (!obstructionPosition || this.bot.blockAt(obstructionPosition)?.boundingBox === 'block')) throw new ConditionWait('전투 대상까지 시야를 확보해야 합니다.');
        s.progress(hunt ? '사냥' : '반격', `${target.name}에게 공격합니다.`); this.bot.deactivateItem(); await this.bot.lookAt(aim);
        s.check(); if (!sameTarget()) throw new ConditionWait('전투 대상의 고유 ID나 지원 요청의 유효 시간이 바뀌었습니다.');
        if (['retreat', 'support', 'ignore'].includes(this.combatDecision(target, s).response)) continue;
        this.bot.attack(target);
        await s.pause(weapon?.name.endsWith('_axe') ? 1100 : 650);
        if (combatEquipment(this.bot).shield && rangedThreat(target.name ?? '')) { this.bot.activateItem(true); await s.pause(200); }
      }
      if (!killed) throw new ConditionWait('대상 이탈 또는 시간 초과로 서버의 처치 확인을 기다립니다.');
      await this.pickup(target.position, s); this.recordInventory(s);
    } finally { this.bot.removeListener('entityDead', onDeath); this.bot.deactivateItem(); this.bot.clearControlStates(); this.fighting = false; }
  }
  private async hunt(name: string, s: ActionServices, item?: string, minimum = 1, kills = 1): Promise<void> {
    let count = 0;
    while (item ? this.count(item) < minimum : count < kills) {
      s.check();
      const candidate = Object.values(this.bot.entities).filter((e) => e.name === name && HUNTABLE.has(e.name) && e.position.distanceTo(this.bot.entity.position) <= 40 && !(s.rules.center && Math.hypot(e.position.x - s.rules.center.x, e.position.z - s.rules.center.z) <= s.rules.radius)).sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position))[0];
      if (!candidate) throw new ConditionWait('마을의 보호 가축을 제외한 사냥 대상을 찾아야 합니다.');
      await this.fightEntity(candidate, s, true); count++;
      if (count >= 64) throw new ConditionWait('사냥 결과와 자원 수량을 다시 확인해야 합니다.');
    }
  }

  private async supportFight(task: TaskSpec, s: ActionServices): Promise<void> {
    const p = task.params, expiry = p.expiresAt;
    const metadataValid = () => typeof p.supportRequestId === 'string' && !!p.supportRequestId && typeof p.requesterBotId === 'string' && !!p.requesterBotId && typeof p.requesterSessionId === 'string' && !!p.requesterSessionId && typeof p.targetEntityId === 'string' && !!p.targetEntityId && typeof p.targetName === 'string' && HOSTILES.has(p.targetName) && p.world === this.options.world && p.dimension === this.options.dimension() && typeof expiry === 'number' && Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.now() + 15000;
    const target = () => Object.values(this.bot.entities).find(e => (e.uuid ?? `${e.id}`) === p.targetEntityId && e.name === p.targetName && e.type !== 'player' && !e.username);
    if (!metadataValid()) throw new ConditionWait('지원 요청의 대상, 월드와 15초 유효 시간을 다시 확인해야 합니다.');
    if (!target()) {
      const location = PositionSchema.safeParse(p.position);
      if (!location.success) throw new ConditionWait('지원 요청의 실제 관측 위치가 필요합니다.');
      const route = safeCombatRoute(this.bot, location.data, { protectedPosition: q => this.protectedBuildPosition(vector(q), s) });
      if (!route.safe) throw new ConditionWait(`지원 대상의 안전한 접근로가 필요합니다: ${route.reason}`);
      const controller = new AbortController(), abort = () => controller.abort();
      s.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, Number(expiry) - Date.now()));
      try { await this.near(location.data, controller.signal, 1); }
      catch (error) { s.check(); if (error instanceof ActionFailure && error.code === 'CANCELLED' && !metadataValid()) throw new ConditionWait('지원 대상의 관측 유효 시간이 지났습니다.'); throw error; }
      finally { clearTimeout(timer); s.signal.removeEventListener('abort', abort); }
    }
    const observed = target();
    if (!metadataValid() || !observed) throw new ConditionWait('요청한 적의 고유 ID를 실제로 관측해야 합니다. 다른 적에게 지원 공격을 전환하지 않습니다.');
    await this.fightEntity(observed, s, false, () => metadataValid() && target() === observed);
  }

  async execute(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
    s.checkpoint.protectedPositions = Array.isArray(task.params.protectedPositions) ? task.params.protectedPositions.slice(0, 10000) : [];
    s.check(); const item = typeof task.params.item === 'string' ? task.params.item : '';
    const quantity = task.completion.kind === 'inventory' ? task.completion.minimum : typeof task.params.quantity === 'number' ? task.params.quantity : 1;
    if (['fight', 'guard'].includes(task.kind) && typeof task.params.supportRequestId === 'string') { await this.supportFight(task, s); this.recordInventory(s); s.check(); return this.result(s); }
    switch (task.kind) {
      case 'collect': await this.ensureItem(item, quantity, s); break;
      case 'craft': await this.ensureItem(item, quantity, s); break;
      case 'smelt': await this.smelt(item, quantity, s); break;
      case 'store': case 'take': {
        const container = ContainerRefSchema.parse(task.params.destination ?? s.rules.warehouse);
        await this.transfer(container, item, typeof task.params.quantity === 'number' ? task.params.quantity : quantity, task.kind, s); break;
      }
      case 'build': case 'farm': case 'breed': {
        if (!this.options.villageTask) throw new ConditionWait('마을 작업 실행기를 연결해야 합니다.');
        return this.options.villageTask(task, s);
      }
      case 'hunt': await this.hunt(typeof task.params.targetName === 'string' ? task.params.targetName : 'cow', s, task.completion.kind === 'inventory' ? task.completion.item : undefined, quantity, task.completion.kind === 'entity-death' ? task.completion.minimum : 1); break;
      case 'fight': {
        const deaths = task.completion.kind === 'entity-death' ? task.completion.minimum : 1;
        for (let n = 0; n < deaths; n++) {
          const target = Object.values(this.bot.entities).filter((e) => HOSTILES.has(e.name ?? '') && (typeof task.params.targetName !== 'string' || e.name === task.params.targetName)).sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position))[0];
          if (!target) throw new ConditionWait('관측한 범위에 지정한 적이 없습니다.');
          await this.fightEntity(target, s);
        }
        break;
      }
      case 'home': case 'guard': {
        const p = PositionSchema.parse(task.params.position ?? s.rules.center); await s.near(p, typeof task.params.radius === 'number' ? task.params.radius : 2);
        s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'position', data: { position: position(this.bot.entity.position) } }); break;
      }
      case 'explore': {
        if (task.params.mode === 'build-site') return exploreBuildSite(task, s);
        const names = Array.isArray(task.params.resourceNames) ? task.params.resourceNames.filter((v): v is string => typeof v === 'string') : [];
        const start = this.bot.entity.position.floored();
        for (const [dx, dz] of [[12, 0], [0, 12], [-12, 0], [0, -12]]) {
          try { await s.near(start.offset(dx, 0, dz), 2); } catch { s.check(); continue; }
          const resources = names.length ? this.bot.findBlocks({ matching: (b) => names.includes(b.name), maxDistance: 32, count: 64 }).flatMap((p) => { const b = this.bot.blockAt(p); return b ? [{ position: position(p), name: b.name }] : []; }) : [];
          s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'exploration', data: { position: position(this.bot.entity.position), resources } });
          if (!names.length || resources.some((r) => names.includes(r.name))) return this.result(s);
        }
        throw new ConditionWait('지정한 자원을 아직 관측하지 못했습니다.');
      }
      case 'sleep': {
        const bed = this.bot.findBlock({ matching: (b) => b.name.endsWith('_bed'), maxDistance: 32 });
        if (!bed) throw new ConditionWait('사용할 침대가 필요합니다.');
        await s.near(bed.position, 2); await this.bot.sleep(bed);
        s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'sleep', data: { isSleeping: this.bot.isSleeping } }); break;
      }
      case 'follow': {
        const name = typeof task.params.targetName === 'string' ? task.params.targetName : '';
        const entity = this.bot.players[name]?.entity;
        if (!entity) throw new ConditionWait('따라갈 플레이어 이름과 현재 접속을 확인해야 합니다.');
        this.bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
        try { while (this.bot.players[name]?.entity) { s.progress('따라가기', `${name}을 따라갑니다.`); await s.pause(1000); } } finally { this.bot.pathfinder.setGoal(null); }
        throw new ConditionWait('따라갈 플레이어의 접속을 기다립니다.');
      }
      case 'survive': while (true) { s.check(); await this.eat(s); s.progress('생존 유지', '체력, 허기와 주변 위험을 확인합니다.'); await s.pause(1000); }
      default: throw new ConditionWait('현재 실행기가 지원하는 작업을 선택해 주세요.');
    }
    this.recordInventory(s); s.check(); return this.result(s);
  }
}
