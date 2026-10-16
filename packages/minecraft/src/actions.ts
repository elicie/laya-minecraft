import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Block } from 'prismarine-block';
import { goals,Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { ContainerRefSchema, PositionSchema, itemCount, type ActionKind, type BotConfig, type ContainerRef, type ObservationInput, type Position, type ResultPayload, type Rules, type TaskSpec } from '../../contracts/src';
import { ActionFailure, ConditionWait, checkAbort, pause, type ActionServices } from './services';
import { inventory, inventoryObservation, observationBase, position, vector,walkingFeet } from './observations';
import { assessCombat, combatEquipment, rangedThreat, HUNTABLE, HOSTILES } from './combat-policy';
import { retreatToSafety, safeCombatRoute, visibleRangedThreat, visibleThreat } from './combat-retreat';
import { buildTemplate, deferBuildWindows, exploreBuildSite } from './village-actions';
import { ResourceRecovery, resourceClearance, safeResourceStand, safeResourceRoute } from './resource-recovery';
import { approachKnownBase, beginResourceTrip, recordResourceTripPosition, resourceTrip, returnFromResourceTrip, resumeResourceTrip, walkTripSteps } from './resource-trip';
import {settleWarehouseThreshold} from './base-threshold';
import { walkVerified } from './verified-walk';
import { walkCorner } from './safe-walk';
import { observedGroundApproach, observedGroundRoute, observedGroundStand } from './observed-ground-walk';
import { centerSupportedCell, settleStandingFootprint } from './standing-footprint';
import { restUnderCover } from './night-shelter';
import { duskOrNight, restInNightBurrow } from './night-burrow';
import { prepareMaterialAccess } from './material-access';
import { restInWarehouse, warehouseInterior } from './base-shelter';
import {farmSurfaceWalk} from './farm-surface-walk';

export const EXECUTABLE_ACTIONS: ActionKind[] = ['collect', 'store', 'take', 'craft', 'smelt', 'build', 'farm', 'hunt', 'fight', 'guard', 'explore', 'follow', 'home', 'sleep', 'survive', 'breed'];
const unsafeBlocks = new Set(['lava', 'magma_block', 'fire', 'soul_fire', 'cactus', 'campfire', 'soul_campfire']);
const shoreFish=new Set(['cod','salmon']);
const foodNames = new Set(['carrot', 'potato', 'beetroot', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'baked_potato', 'apple', 'melon_slice', 'sweet_berries', 'beef', 'porkchop', 'mutton', 'rabbit','cod','salmon','cooked_cod','cooked_salmon','chicken']);
const smeltInputs: Record<string, string> = { iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone', smooth_stone: 'stone', charcoal: 'oak_log', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken', cooked_mutton: 'mutton', cooked_rabbit: 'rabbit', baked_potato: 'potato',cooked_cod:'cod',cooked_salmon:'salmon' };
const dropBlocks: Record<string, string[]> = { cobblestone: ['stone', 'cobblestone'], raw_iron: ['iron_ore', 'deepslate_iron_ore'], raw_gold: ['gold_ore', 'deepslate_gold_ore'], raw_copper: ['copper_ore', 'deepslate_copper_ore'], coal: ['coal_ore', 'deepslate_coal_ore'], diamond: ['diamond_ore', 'deepslate_diamond_ore'], wheat_seeds: ['short_grass', 'tall_grass'], dirt: ['dirt', 'grass_block'], wheat: ['wheat'], carrot: ['carrots'], potato: ['potatoes'], beetroot: ['beetroots'], melon_slice: ['melon'] };
const huntDrops: Record<string, string> = { beef: 'cow', leather: 'cow', porkchop: 'pig', chicken: 'chicken', mutton: 'sheep', white_wool: 'sheep', rabbit: 'rabbit',cod:'cod',salmon:'salmon' };
type CraftRecipe = ReturnType<Bot['recipesAll']>[number];
interface AcquisitionEstimate {
  cost: number;
  /** Only the chosen acquisition path, not every rejected recipe variant. */
  dependencies: Set<string>;
  depth: number;
}
interface RecipeEvaluation {
  remaining: number;
  table: Block | null;
  recipes: Map<string, CraftRecipe[]>;
  sources: Map<string, Block | null>;
  costs: Map<string, AcquisitionEstimate>;
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
  private readonly utilityAccessFailures=new WeakSet<ConditionWait>();
  constructor(readonly bot: Bot, readonly options: ExecutorOptions) {}
  setRules(rules: Rules, config = this.options.config): void { this.options.rules = rules; this.options.config = config; }
  count(item: string): number { return itemCount(inventory(this.bot), item); }
  stopControls(): void { this.bot.pathfinder.setGoal(null); this.bot.clearControlStates(); this.bot.deactivateItem(); if (this.bot.targetDigBlock) this.bot.stopDigging(); }

  services(signal: AbortSignal, checkpoint: ActionServices['checkpoint'] = {}): ActionServices {
    let farmSurfaceRouting=false;
    const s: ActionServices = {
      bot: this.bot, rules: this.options.rules, signal, checkpoint, observations: [], evidence: [],
      check: () => checkAbort(signal), pause: (ms) => pause(ms, signal),
      walkVerified: (path, stand) => walkVerified(this.bot,path,signal,stand,(p,childSignal)=>this.near(p,childSignal,0)),
      near: async (p, radius) => {
        s.check();
        await settleWarehouseThreshold(s);
        if(this.bot.entity.position.distanceTo(vector(p))<=(radius??2)+.5)return;
        if(s.checkpoint.nightBasePending!==true&&warehouseInterior(s)&&!warehouseInterior(s,p)){
          if(!await restInWarehouse(s,()=>this.options.config.enabled,undefined,'exit'))throw new ConditionWait('실제 창고 출입문으로 나와 작업을 재개해야 합니다.',s.checkpoint);
        }
        const trip=resourceTrip(s.checkpoint);
        const activeTrip=!!trip&&trip.phase!=='complete';
        const farmDryGround=s.checkpoint.farmDryGround===true||s.checkpoint.dryGroundApproach===true;
        const plots=(Array.isArray(s.checkpoint.farmPlotPositions)?s.checkpoint.farmPlotPositions:[]).flatMap(raw=>{const parsed=PositionSchema.safeParse(raw);return parsed.success?[parsed.data]:[];});
        if(farmDryGround&&plots.length&&!farmSurfaceRouting&&(radius??0)===0){if(await farmSurfaceWalk(s,p,plots,async q=>{farmSurfaceRouting=true;try{await s.near(q,0);}finally{farmSurfaceRouting=false;}}))return;}
        const blocked=(p:Position)=>plots.some(soil=>p.x===soil.x&&p.z===soil.z&&p.y===soil.y+1&&(!['air','cave_air','void_air'].includes(this.bot.blockAt(vector(soil).offset(0,1,0))?.name??'')||(this.bot.blockAt(vector(soil))?.name!=='farmland'&&!(s.checkpoint.farmRepairBarePlots===true&&['dirt','grass_block'].includes(this.bot.blockAt(vector(soil))?.name??'')))));
        if (activeTrip || s.checkpoint.safeDetourRequired === true || farmDryGround) {
          // A real collision box may rest on the neighboring full block while
          // its quantized center is over air. Settle that existing support
          // before requiring a safe starting cell for route planning.
          await settleStandingFootprint(this.bot,s,()=>{});
          const strictPath=farmDryGround?undefined:safeResourceRoute(this.bot,p,{radius:radius??2});
          const path=strictPath??observedGroundApproach(this.bot,p,radius??2,farmDryGround,blocked);
          if (!path) throw new ConditionWait('원정 이동의 전체 실제 발판을 확인하지 못했습니다.',s.checkpoint);
          if(!path.length)return;
          const stand=(p:Position)=>!blocked(p)&&(safeResourceStand(this.bot,p,()=>false)||observedGroundStand(this.bot,p,undefined,farmDryGround))&&!Object.values(this.bot.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(vector(p))<12);
          try{
            if(!activeTrip&&await walkVerified(this.bot,path,signal,stand,(p,childSignal)=>this.near(p,childSignal,0),farmDryGround?2:1))return;
            if(farmDryGround){
              for(const step of path){
                const current=walkingFeet(this.bot),points:Position[]=[];
                if(current.x!==step.x&&current.z!==step.z){const corner=walkCorner(current,step,stand);if(!corner)throw new ConditionWait('밭 모서리의 실제 마른 발판을 확인해야 합니다.',s.checkpoint);points.push(corner);}
                points.push(step);
                for(const point of points){s.check();if(!stand(point)||!await walkVerified(this.bot,[point],signal,stand,(p,child)=>this.near(p,child,0),2))throw new ConditionWait('밭 가장자리의 실제 육지 보행을 완료해야 합니다.',s.checkpoint);}
              }
              return;
            }
            for(let offset=0;offset<path.length;offset+=8){
              const segment=path.slice(offset,offset+8);
              if(activeTrip&&await walkVerified(this.bot,segment,signal,stand,(p,childSignal)=>this.near(p,childSignal,0))){if(resourceTrip(s.checkpoint)?.phase==='outbound')await recordResourceTripPosition(s,true);}
              else await walkTripSteps(s,segment,q=>this.near(q,signal,0),async()=>{if(resourceTrip(s.checkpoint)?.phase==='outbound')await recordResourceTripPosition(s,true);});
            }
          }catch(error){
            s.check();if(!(error instanceof ConditionWait)||!error.message.startsWith('20초 동안 목표 위치'))throw error;
            this.stopControls();await s.pause(150);await settleStandingFootprint(this.bot,s,()=>{});await centerSupportedCell(this.bot,s);
            const fresh=(farmDryGround?undefined:safeResourceRoute(this.bot,p,{radius:radius??2}))??observedGroundApproach(this.bot,p,radius??2,farmDryGround,blocked);
            if(!fresh)throw error;
            await walkTripSteps(s,fresh,q=>this.near(q,signal,0),async()=>{if(resourceTrip(s.checkpoint)?.phase==='outbound')await recordResourceTripPosition(s,true);});
          }
        } else await this.near(p, signal, radius);
      },
      ensureItem: (item, quantity) => s.checkpoint.materialExpedition===true ? this.gatherWithReturn(item,quantity,s) : this.ensureItem(item, quantity, s), place: (p, item, expected, face) => this.place(p, item, expected, s, face),
      recoverDrops: (p, item, minimum, avoidSupports) => this.pickup(p, s, item, minimum, avoidSupports),
      observeInventory: () => inventoryObservation(this.bot, this.options.world, this.options.dimension()),
      progress: (action, reason) => this.options.onProgress?.(action, reason),
    };
    return s;
  }

  private recordInventory(s: ActionServices): void { s.observations.push(s.observeInventory()); }
  private async utilityAccess<T>(s:ActionServices,access:()=>Promise<T>):Promise<T>{try{return await access();}catch(error){s.check();if(error instanceof ConditionWait)this.utilityAccessFailures.add(error);throw error;}}
  private async returnForUtility(s: ActionServices): Promise<void> {
    const trip=resourceTrip(s.checkpoint);
    if (trip?.phase==='outbound' && this.bot.entity.position.distanceTo(vector(trip.home))>8) {
      await returnFromResourceTrip(s); await beginResourceTrip(s,trip.item,trip.minimum,trip.home);
    }
  }
  private async gatherWithReturn(item: string, minimum: number, s: ActionServices, destination?: Position,searchFrom?:Position): Promise<void> {
    // Other work or a night interruption may have brought this same body
    // inside. Reconnect the saved outdoor trip through the real doorway first.
    if(warehouseInterior(s)&&s.rules.baseShelter)await s.near(vector(s.rules.baseShelter.outside).offset(.5,0,.5),0);
    const previous=resourceTrip(s.checkpoint);
    if(previous&&typeof s.checkpoint.confirmedRecoveryDeathId==='string'&&previous.deathId!==s.checkpoint.confirmedRecoveryDeathId)await returnFromResourceTrip(s);
    if(this.materialRestNeeded(item,minimum,s)){
      if(previous&&previous.phase!=='complete')await returnFromResourceTrip(s);
      await restUnderCover(s);
      s.checkpoint.missingResource=item;s.checkpoint.minimum=minimum;s.checkpoint.waitingFor={kind:'inventory',causeCode:'BUILD_MATERIAL',item,minimum,watchPosition:false,watchDaylight:true};
      throw new ConditionWait('야간의 장비 없는 재료 원정에서 사망이 반복되어 실제 작업 지점으로 복귀했습니다. 가진 재료의 설치를 마치고 해가 뜨면 재료 원정을 이어갑니다.',s.checkpoint);
    }
    if(previous&&previous.phase==='outbound'&&this.bot.entity.position.distanceTo(vector(previous.trail.at(-1)??previous.home))>48)await returnFromResourceTrip(s);
    const trip=await beginResourceTrip(s,item,minimum,destination);
    if (trip.phase==='returning') { await returnFromResourceTrip(s); if (trip.failure) throw new ConditionWait(trip.failure,s.checkpoint); if (this.count(item)<minimum) await beginResourceTrip(s,item,minimum,destination??trip.home); }
    if (this.count(item)<minimum) {
      try { if(searchFrom)await s.near(vector(searchFrom).floored().offset(.5,0,.5),0);await this.ensureItem(item,minimum,s); }
      catch (error) {
        s.check(); if (!(error instanceof ConditionWait)) throw error;
        Object.assign(s.checkpoint,error.checkpoint);
        const failed=resourceTrip(s.checkpoint)!; failed.failure=error.message.slice(0,2000); s.checkpoint.resourceTrip=failed as unknown as ActionServices['checkpoint'];
        await returnFromResourceTrip(s); throw new ConditionWait(error.message,s.checkpoint);
      }
    }
    if (resourceTrip(s.checkpoint)?.phase!=='complete') await returnFromResourceTrip(s);
    if (this.count(item)<minimum) throw new ConditionWait('복귀 후 요청한 재료의 실제 인벤토리를 다시 확인해야 합니다.',s.checkpoint);
  }
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
      const feet=walkingFeet(this.bot,p),tolerance=this.bot.blockAt(feet.offset(0,-1,0))?.name==='farmland'?Math.max(radius,.1):radius;
      await this.bot.pathfinder.goto(new goals.GoalNear(feet.x,feet.y,feet.z,tolerance));
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

  canObserveContainerHere(container:ContainerRef):boolean {
    if(container.world!==this.options.world||container.dimension!==this.options.dimension()||this.bot.entity.onGround!==true||!observedGroundStand(this.bot,this.bot.entity.position))return false;
    const block=this.bot.blockAt(vector(container.position));
    return !!block&&['chest','trapped_chest','barrel'].includes(block.name)&&vector(this.bot.entity.position).offset(0,1.62,0).distanceTo(block.position.offset(.5,.5,.5))<=4.5&&typeof this.bot.canSeeBlock==='function'&&this.bot.canSeeBlock(block);
  }
  async observeContainer(container: ContainerRef, s: ActionServices, allowMovement=true): Promise<ObservationInput> {
    s.check();
    if(!allowMovement&&!this.canObserveContainerHere(container))throw new ConditionWait('현재 안전한 발판에서 직접 열 수 있는 창고만 이동 없이 관측합니다.');
    const block = allowMovement?await this.approachContainer(container, s):this.bot.blockAt(vector(container.position))!;
    const window = await this.bot.openContainer(block);
    try {
      const result: ObservationInput = { ...observationBase(this.options.world, this.options.dimension()), kind: 'container', data: { container, items: window.containerItems().map((i) => ({ name: i.name, count: i.count })) } };
      s.observations.push(result); this.recordInventory(s); return result;
    } finally { await window.close(); }
  }

  private async reuseWarehouseFarmHoe(s:ActionServices):Promise<void>{
    if(this.bot.inventory.items().some(i=>i.name.endsWith('_hoe'))||!this.options.config.allowedActions.includes('craft'))return;
    const carried=()=>this.bot.inventory.items().some(i=>i.name.endsWith('_log'))||this.bot.inventory.items().filter(i=>i.name.endsWith('_planks')).reduce((n,i)=>n+i.count,0)>=4;
    if(s.rules.warehouse&&this.options.config.allowedActions.includes('take')){
      const observed=await this.observeContainer(s.rules.warehouse,s);
      if(!carried()&&observed.kind==='container'){
        const hoe=observed.data.items.find(i=>i.name.endsWith('_hoe')&&i.count>0),log=observed.data.items.find(i=>i.name.endsWith('_log')&&i.count>0);
        const material=hoe??log;
        if(material){await this.transfer(s.rules.warehouse,material.name,1,'take',s);s.checkpoint.farmToolWarehouseSupply={item:material.name,quantity:1,observedAt:Date.now(),warehouseId:s.rules.warehouse.id};}
      }
    }
    if(!this.bot.inventory.items().some(i=>i.name.endsWith('_hoe'))&&carried())await this.ensureItem('wooden_hoe',1,s);
  }

  private async registerWarehouse(task: TaskSpec, s: ActionServices): Promise<ResultPayload> {
    if (task.completion.kind !== 'warehouse') throw new ConditionWait('창고 등록에 건물 전체와 실제 창고 확인 조건이 필요합니다.');
    const { container, blocks } = task.completion;
    this.assertContainer(container);
    const min = { x: Math.min(...blocks.map(b => b.position.x)), y: Math.min(...blocks.map(b => b.position.y)), z: Math.min(...blocks.map(b => b.position.z)) };
    s.checkpoint.buildProtection = { origin: min, width: Math.max(...blocks.map(b => b.position.x)) - min.x + 1, depth: Math.max(...blocks.map(b => b.position.z)) - min.z + 1, height: Math.max(...blocks.map(b => b.position.y)) - min.y };
    if (!blocks.some(b => b.position.x === container.position.x && b.position.y === container.position.y && b.position.z === container.position.z && ['chest', 'trapped_chest', 'barrel'].includes(b.name)))
      throw new ConditionWait('설계도에 포함된 실제 창고 블록을 등록해야 합니다.');
    const observeBuilding = () => {
      const actual = blocks.flatMap(expected => {
        const block = this.bot.blockAt(vector(expected.position));
        return block ? [{ position: expected.position, name: block.name }] : [];
      });
      s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'blocks', data: { blocks: actual } });
      const mismatches = blocks.filter(expected => this.bot.blockAt(vector(expected.position))?.name !== expected.name);
      if (mismatches.length) {
        s.checkpoint.waitingFor = { kind: 'blocks', causeCode: 'BUILD_OBSERVATION', positions: mismatches.map(b => b.position) };
        throw new ConditionWait('창고 등록 전에 설계도 전체의 실제 완공 상태를 다시 확인해야 합니다.', s.checkpoint);
      }
    };
    observeBuilding(); s.check(); s.progress('창고 확인', '완성한 창고를 실제로 열어 공동 창고로 사용할 수 있는지 확인합니다.');
    try { await this.observeContainer(container, s); }
    catch (error) {
      s.check(); if (!(error instanceof ConditionWait)) throw error;
      const feet = vector(this.bot.entity.position).floored(), positions = [container.position, position(feet), position(feet.offset(0, 1, 0)), position(feet.offset(0, -1, 0))];
      const actual = positions.flatMap(p => { const block = this.bot.blockAt(vector(p)); return block ? [{ position: p, name: block.name }] : []; });
      s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'blocks', data: { blocks: actual } });
      Object.assign(s.checkpoint, error.checkpoint);
      s.checkpoint.waitingFor = { kind: 'blocks', causeCode: 'BUILD_ACCESS', positions, watchPosition: true };
      throw new ConditionWait(error.message, s.checkpoint);
    }
    s.check(); observeBuilding(); delete s.checkpoint.waitingFor;
    return this.result(s, '건물 전체와 창고 내부를 실제로 확인했습니다.');
  }
  private assertContainer(container: ContainerRef): void {
    if (container.world !== this.options.world || container.dimension !== this.options.dimension()) throw new ConditionWait('공동 창고의 서버와 차원이 현재 연결과 다릅니다.');
  }
  private async approachContainer(container: ContainerRef, s: ActionServices): Promise<Block> {
    this.assertContainer(container); s.check();
    if(s.rules.baseShelter?.warehouseId===container.id&&s.checkpoint.nightBasePending!==true){
      if(this.bot.entity.position.distanceTo(vector(s.rules.baseShelter.outside))>32)await approachKnownBase(s,s.rules.baseShelter.outside);
      if(!await restInWarehouse(s,()=>this.options.config.enabled,undefined,'enter'))throw new ConditionWait('등록한 창고의 실제 안전한 출입을 먼저 확인해야 합니다.',s.checkpoint);
    }
    // A raised chest behind the warehouse wall has no reachable integer path
    // node inside radius 2. Radius 3 includes the adjacent outside ground.
    await s.near(container.position, 3); s.check();
    const block = this.bot.blockAt(vector(container.position));
    if (!block || !['chest', 'trapped_chest', 'barrel'].includes(block.name)) throw new ConditionWait('지정한 창고가 없거나 관측되지 않았습니다.');
    const eyes = vector(this.bot.entity.position).offset(0, 1.62, 0);
    const distance = eyes.distanceTo(vector(block.position).offset(0.5, 0.5, 0.5));
    if (!Number.isFinite(distance) || distance > 4.5) throw new ConditionWait('창고를 열기 전에 실제 상호작용 거리 안의 안전한 위치로 접근해야 합니다.');
    return block;
  }
  private async transfer(container: ContainerRef, itemName: string, quantity: number, direction: 'store' | 'take', s: ActionServices): Promise<void> {
    this.assertContainer(container); s.check();
    const data = this.bot.registry.itemsByName[itemName];
    if (!data || !Number.isInteger(quantity) || quantity <= 0) throw new ConditionWait('이동할 아이템과 수량을 확인해야 합니다.');
    if(direction==='store'&&this.count(itemName)<quantity){
      s.checkpoint.waitingFor={kind:'inventory',causeCode:'BUILD_MATERIAL',item:itemName,minimum:quantity,watchPosition:false};
      throw new ConditionWait('입고할 실제 소지 수량을 먼저 확보해야 합니다. 창고로 이동하지 않고 물자 변화를 기다립니다.',s.checkpoint);
    }
    const block = await this.approachContainer(container, s);
    const window = await this.bot.openContainer(block);
    let started = false;
    try {
      const beforeInventory = itemCount(window.items().map((i) => ({ name: i.name, count: i.count })), itemName);
      const beforeContainer = itemCount(window.containerItems().map((i) => ({ name: i.name, count: i.count })), itemName);
      if ((direction === 'store' ? beforeInventory : beforeContainer) < quantity) throw new ConditionWait('실제 출발지 물자가 요청한 수량보다 적습니다.',direction==='take'?{missingWarehouseItem:itemName}:{});
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
    if(s.rules.world===this.options.world&&s.rules.dimension===this.options.dimension()){
      if(s.rules.baseShelter?.blocks.some(b=>b.position.x===p.x&&b.position.y===p.y&&b.position.z===p.z))return true;
      if(s.rules.baseAutonomy?.positions.some(soil=>soil.x===p.x&&soil.z===p.z&&(soil.y===p.y||soil.y+1===p.y)))return true;
    }
    for (const field of ['protectedPositions', 'buildPreparationProtection']) {
      const cells = s.checkpoint[field];
      if (Array.isArray(cells) && cells.some(value => value && typeof value === 'object' && 'x' in value && 'y' in value && 'z' in value && value.x === p.x && value.y === p.y && value.z === p.z)) return true;
    }
    const area = s.checkpoint.buildProtection as { origin?: { x: number; y: number; z: number }; width?: number; depth?: number; height?: number } | undefined;
    const origin = area?.origin;
    if (!origin || !Number.isFinite(area?.width) || !Number.isFinite(area?.depth) || !Number.isFinite(area?.height)) return false;
    return p.x >= origin.x - 1 && p.x <= origin.x + area!.width! && p.z >= origin.z - 1 && p.z <= origin.z + area!.depth! && p.y >= origin.y - 1 && p.y <= origin.y + Math.max(2, area!.height!);
  }
  private materialRestNeeded(item:string,minimum:number,s:ActionServices):boolean{
    if(s.checkpoint.materialExpedition!==true||s.checkpoint.resourceRecoveryScope==='$food'||this.bot.time?.doDaylightCycle!==true||this.count(item)>=minimum)return false;
    const gear=combatEquipment(this.bot),data=this.bot.registry.itemsByName[item];
    if(gear.weapon&&(gear.shield||gear.armorPoints>=12)||data&&this.bot.recipesFor(data.id,null,minimum,true).length)return false;
    const trip=resourceTrip(s.checkpoint),trail=trip?.phase==='outbound'?trip.trail:[];
    let distance=trail.length?vector(this.bot.entity.position).distanceTo(vector(trail.at(-1)!)):0;
    for(let i=trail.length-1;i>0;i--)distance+=vector(trail[i]!).distanceTo(vector(trail[i-1]!));
    if(trip&&trail.length)distance+=vector(trail[0]!).distanceTo(vector(trip.home));
    const threshold=Math.max(6000,Math.min(8000,Math.floor(12000-(distance/1.5+45)*20))),time=this.bot.time.timeOfDay;
    const due=duskOrNight(this.bot)||Number.isFinite(time)&&time>=threshold;
    if(due)s.checkpoint.resourceReturnDeadline={timeOfDay:Number.isFinite(time)?time:null,threshold,routeDistance:Math.round(distance),observedAt:Date.now()};
    return due;
  }
  private resourceRecovery(item: string, names: string[], s: ActionServices): ResourceRecovery {
    return new ResourceRecovery(this.bot, s, item, names, this.options.config.allowedActions.includes('explore') && (s.checkpoint.resourceRecoveryScope !== '$food' || item === '$food'), p => this.protectedBuildPosition(p, s));
  }
  private collectionStand(p:Position,s:ActionServices):boolean {
    const protectedPosition=(q:Position)=>this.protectedBuildPosition(q,s),feet=vector(p).floored();
    return safeResourceStand(this.bot,p,protectedPosition)||s.checkpoint.materialExpedition===true&&s.checkpoint.resourceRecoveryScope!=='$food'&&this.bot.health>s.rules.combat.retreatHealth&&this.bot.food>6&&![feet,feet.offset(0,1,0),feet.offset(0,-1,0)].some(protectedPosition)&&observedGroundStand(this.bot,p);
  }
  private directHarvestStand(p:Position,s:ActionServices):boolean {
    const feet=vector(p).floored();
    return this.collectionStand(p,s)||s.checkpoint.resourceRecoveryScope!=='$food'&&![feet,feet.offset(0,1,0),feet.offset(0,-1,0)].some(q=>this.protectedBuildPosition(q,s))&&observedGroundStand(this.bot,p);
  }
  /** Existing safe footing and a harvestable block already in reach need no
   * further route search. This never renews the search allowance. */
  private directlyHarvestable(block:Block,s:ActionServices,centered=true):boolean {
    const feet=walkingFeet(this.bot),actual=this.bot.entity.position;
    if(this.bot.entity.onGround!==true||Math.abs(actual.y-feet.y)>.1||centered&&(Math.abs(actual.x-feet.x-.5)>.15||Math.abs(actual.z-feet.z-.5)>.15)||this.bot.health<=s.rules.combat.retreatHealth||this.bot.food<=6)return false;
    if(vector(actual).offset(0,1.62,0).distanceTo(block.position.offset(.5,.5,.5))>4.5||!this.directHarvestStand(feet,s)||Object.values(this.bot.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(actual)<12))return false;
    if(!this.collectible(block,s)||this.currentSupport(block)||typeof this.bot.canSeeBlock!=='function'||!this.bot.canSeeBlock(block)||typeof this.bot.canDigBlock!=='function'||!this.bot.canDigBlock(block))return false;
    return block.canHarvest(this.bot.heldItem?.type??null)||this.bot.inventory.items().some(i=>block.canHarvest(i.type));
  }
  private async settleDirectHarvest(names:string[],s:ActionServices,recovery:ResourceRecovery):Promise<void> {
    if(recovery.canApproach())return;
    const block=this.bot.findBlock({matching:b=>names.includes(b.name),useExtraInfo:b=>this.directlyHarvestable(b,s,false),maxDistance:5});
    // Public pathfinding can stop away from the cell center. Settle only on
    // the existing support, with no new cell, route search or allowance.
    if(block&&!this.directlyHarvestable(block,s))await centerSupportedCell(this.bot,s);
  }
  private resourceStands(block: Block, s: ActionServices): Position[] {
    if (!block.boundingBox) return [];
    const feet = vector(this.bot.entity.position).floored();
    if (block.position.equals(feet) || block.position.equals(feet.offset(0, -1, 0))) return [];
    const faces = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].map(d => this.bot.blockAt(block.position.plus(d)));
    if (!faces.some(resourceClearance)) {
      s.checkpoint.resourceStandObservation = { resource: position(block.position), name: block.name, feet: position(feet), reason: 'covered-faces', faces: faces.map(b => b?.name ?? 'unloaded'), observedAt: Date.now() };
      return [];
    }
    const candidates = [feet];
    for (let dx=-2;dx<=2;dx++) for (let dz=-2;dz<=2;dz++) if(dx||dz) for (const dy of [-5,-4,-3,-2,-1,0,1,2,3]) candidates.push(block.position.offset(dx,dy,dz));
    const unique = [...new Map(candidates.map(p => [`${p.x},${p.y},${p.z}`, p])).values()];
    const sight=(p:Vec3)=>{
      if(typeof this.bot.world?.raycast!=='function')return true;
      const eye=p.offset(.5,1.62,.5),delta=block.position.offset(.5,.5,.5).minus(eye),length=delta.norm();
      if(!length)return false;
      const hit=this.bot.world.raycast(eye,delta.scaled(1/length),length+.01);
      // This ranks candidate viewpoints only; actual canSeeBlock/canDigBlock
      // are still mandatory after arrival, including when no ray hit is given.
      return !hit||!!rayPosition(hit)?.equals(block.position);
    };
    const stands = unique.filter(p => p.offset(.5,1.62,.5).distanceTo(block.position.offset(.5,.5,.5)) <= 4.25 && Math.abs(p.y - feet.y) <= 8 && this.collectionStand(p,s)&&sight(p))
      .sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet)).slice(0, 3);
    if (!stands.length) s.checkpoint.resourceStandObservation = { resource: position(block.position), name: block.name, feet: position(feet), reason: 'no-stand', faces: faces.map(b => b?.name ?? 'unloaded'), observedAt: Date.now(),
      candidates: unique.slice(1,41).map(p => ({ position: position(p), column: [-1,0,1].map(dy => this.bot.blockAt(p.offset(0,dy,0))?.name ?? 'unloaded'), neighbors: [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz]) => [-2,-1,0].map(dy => this.bot.blockAt(p.offset(dx!,dy,dz!))?.name ?? 'unloaded')) })) };
    return stands;
  }
  private currentSupport(block: Block): boolean {
    const feet = vector(this.bot.entity.position).floored();
    return block.position.equals(feet) || block.position.equals(feet.offset(0, -1, 0));
  }
  private async collect(itemName: string, minimum: number, s: ActionServices, selectedSource?: Position, scopedRecovery?: ResourceRecovery): Promise<void> {
    if (!this.options.config.allowedActions.includes('collect')) throw new ConditionWait('이 봇에는 수집 작업이 허용되지 않았습니다.');
    const recovery = scopedRecovery ?? this.resourceRecovery(itemName, dropBlocks[itemName] ?? [itemName], s);
    if (!s.checkpoint.resourceStandObservation) {
      const prior = [...recovery.state.failed].reverse().map(record => this.bot.blockAt(vector(record.position))).find(block => block && this.collectMatches(itemName, block.name) && this.collectible(block, s));
      if (prior) this.resourceStands(prior, s);
    }
    const skipped = new Set<string>();
    let skippedFrom = vector(this.bot.entity.position).floored(), legacyCheckedAt = '';
    let attempts = 0;
    while (this.count(itemName) < minimum) {
      if(resourceTrip(s.checkpoint)?.phase==='returning')throw new ConditionWait('미완료 재료 원정의 실제 복귀를 먼저 마쳐야 합니다.',s.checkpoint);
      if(this.materialRestNeeded(itemName,minimum,s)){
        s.checkpoint.waitingFor={kind:'inventory',causeCode:'BUILD_MATERIAL',item:itemName,minimum,watchPosition:false,watchDaylight:true};
        throw new ConditionWait('야간 대비 준비 시간이 되어 수집 진행과 이미 확보한 재료를 보존하고 작업 지점으로 복귀합니다.',s.checkpoint);
      }
      s.check(); s.progress('수집', `${itemName} ${this.count(itemName)}/${minimum}`);
      const actual = vector(this.bot.entity.position).floored();
      if (actual.distanceTo(skippedFrom) >= 8 || Math.abs(actual.y-skippedFrom.y) >= 2) { skipped.clear(); skippedFrom = actual; }
      const region = `${Math.floor(actual.x/8)},${Math.floor(actual.y/2)},${Math.floor(actual.z/8)}`;
      if (region !== legacyCheckedAt) {
        legacyCheckedAt = region;
        const legacy = recovery.state.failed.filter(entry => !entry.from && this.collectMatches(itemName, entry.name) && recovery.within(entry.position) && vector(entry.position).distanceTo(actual)<=48).sort((a,b)=>vector(a.position).distanceTo(actual)-vector(b.position).distanceTo(actual)).slice(0,8);
        for (const entry of legacy) {
          const block = this.bot.blockAt(vector(entry.position));
          if (!block || !this.collectMatches(itemName,block.name) || !this.collectible(block,s)) continue;
          const stands = this.resourceStands(block,s), route = stands.find(p=>recovery.route(vector(p)));
          const saved = Array.isArray(s.checkpoint.resourceApproachRechecks) ? s.checkpoint.resourceApproachRechecks : [];
          s.checkpoint.resourceApproachRechecks = [...saved,{...entry,from:position(actual),observedAt:Date.now(),routeConfirmed:!!route,...(route?{stand:position(route)}:{})}].slice(-16);
          if (route) recovery.state.failed = recovery.state.failed.filter(prior=>prior!==entry);
          else entry.from = position(actual);
        }
      }
      if (this.bot.inventory.emptySlotCount() === 0 && !this.bot.inventory.items().some((i) => i.name === itemName && i.count < i.stackSize)) throw new ConditionWait('인벤토리 공간을 확보해야 합니다.');
      await this.settleDirectHarvest(dropBlocks[itemName]??[itemName],s,recovery);
      const eligible = (b: Block) => this.collectMatches(itemName,b.name) && !skipped.has(`${b.position}`) && this.collectible(b,s) && (this.directlyHarvestable(b,s)||recovery.canApproach()&&!recovery.failed(b.position)&&recovery.within(b.position));
      const selected = selectedSource ? this.bot.blockAt(vector(selectedSource)) : undefined;
      const block = selectedSource ? selected && eligible(selected) ? selected : null : this.bot.findBlock({ matching: b => this.collectMatches(itemName,b.name), useExtraInfo: eligible, maxDistance:48 });
      const direct=!!block&&this.directlyHarvestable(block,s);
      if (!block || !recovery.canApproach()&&!direct) {
        if (selectedSource) throw new ConditionWait('선택한 자연 나무의 실제 노출면과 접근을 확인해야 합니다.',s.checkpoint);
        if (await recovery.move()) continue;
        if (recovery.journey?.pending) { await s.pause(100); continue; }
        if (recovery.beginResourceJourney()) continue;
        throw recovery.wait(`관측된 자원과 안전한 지상 탐색을 확인했지만 ${itemName}을 확보하지 못했습니다. ${recovery.state.reason || '새 자원이나 접근 지형의 실제 변화를 기다립니다.'}`, minimum);
      }
      if (++attempts > 128) {
        if (await recovery.move()) { attempts = 0; continue; }
        if (recovery.journey?.pending) { await s.pause(100); attempts = 0; continue; }
        if (recovery.beginResourceJourney()) { attempts = 0; continue; }
        throw recovery.wait('현재 위치의 자원 후보 128개를 확인했지만 접근 가능한 노출면을 찾지 못했습니다. 실제 자원이나 접근 지형의 변화를 기다립니다.', minimum);
      }
      recovery.sample(block.position);
      const stands = direct?[position(walkingFeet(this.bot))]:this.resourceStands(block, s);
      if (!stands.length) { skipped.add(`${block.position}`); recovery.reject(block.position, block.name, '자원까지 노출된 면과 안전하게 설 수 있는 지상 발판을 확인하지 못했습니다.'); continue; }
      let stand: Position | undefined=direct?position(walkingFeet(this.bot)):undefined, approachReason = '';
      for (const candidate of stands) {
        if(stand)break;
        if (!recovery.canApproach()) break;
        try {
          await recovery.approach(vector(candidate).offset(0.5, 0, 0.5), 0);
          const actual = this.bot.blockAt(block.position);
          if (!actual || typeof this.bot.canSeeBlock !== 'function' || !this.bot.canSeeBlock(actual)) { approachReason = '안전한 발판에서 자원까지 실제 시야를 확인하지 못했습니다.'; continue; }
          stand = candidate; break;
        } catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; approachReason = error.message; }
      }
      if (!stand) { skipped.add(`${block.position}`); recovery.reject(block.position, block.name, approachReason); continue; }
      const approach = async () => {
        const actual=this.bot.blockAt(block.position);
        if(actual&&this.directlyHarvestable(actual,s))return;
        await recovery.approach(vector(stand!).offset(0.5,0,0.5),0);
      };
      let current = this.bot.blockAt(block.position);
      if (!current || !this.collectMatches(itemName, current.name) || !this.collectible(current, s) || this.currentSupport(current)) { skipped.add(`${block.position}`); continue; }
      if (this.bot.blockAt(current.position.offset(0, 1, 0))?.name === 'lava' || unsafeBlocks.has(this.bot.blockAt(current.position.offset(0, -1, 0))?.name ?? '')) { skipped.add(`${block.position}`); continue; }
      if (!current.canHarvest(this.bot.heldItem?.type ?? null)) {
        const tool = this.harvestTool(current.name);
        const trip=resourceTrip(s.checkpoint), sourceTrail=trip?.phase==='outbound'?[...trip.trail,stand]:undefined;
        await this.ensureItem(tool, 1, s);
        const available = this.bot.inventory.items().find((i) => i.name === tool);
        if (!available) throw new ConditionWait(`${tool} 도구를 확보해야 합니다.`);
        if (sourceTrail && this.bot.entity.position.distanceTo(vector(stand))>48) await resumeResourceTrip(s,sourceTrail);
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
      if (!current || !this.collectMatches(itemName, current.name) || !this.collectible(current, s) || this.currentSupport(current) || !this.directlyHarvestable(current,s)&&!this.collectionStand(vector(this.bot.entity.position).floored(),s)) { skipped.add(`${block.position}`); continue; }
      if (typeof this.bot.canSeeBlock !== 'function' || !this.bot.canSeeBlock(current)) { skipped.add(`${current.position}`); recovery.reject(current.position, current.name, '현재 안전한 발판에서 자원까지 실제 시야를 확보하지 못했습니다.'); continue; }
      if (typeof this.bot.canDigBlock==='function'&&!this.bot.canDigBlock(current)) {skipped.add(`${current.position}`);recovery.reject(current.position,current.name,'현재 발판에서 자원까지 실제 채굴 거리를 확인하지 못했습니다.');continue;}
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

  private async utilityWood(s: ActionServices, minimumPlanks=4, variantMinimum=4): Promise<void> {
    const names = Object.keys(this.bot.registry.itemsByName).filter(name=>name.endsWith('_log'));
    const stocked=()=>{const byWood=new Map<string,number>();for(const i of this.bot.inventory.items())if(i.name.endsWith('_log')||i.name.endsWith('_planks')){const wood=i.name.replace(/_(log|planks)$/,'');byWood.set(wood,(byWood.get(wood)??0)+i.count*(i.name.endsWith('_log')?4:1));}return [...byWood.values()].reduce((sum,n)=>sum+n,0)>=minimumPlanks&&Math.max(0,...byWood.values())>=variantMinimum;};
    if (!names.length || stocked()) return;
    const recovery = this.resourceRecovery('$utility_wood',names,s);
    while (true) {
      s.check();
      if(resourceTrip(s.checkpoint)?.phase==='returning')throw new ConditionWait('미완료 재료 원정의 실제 복귀를 먼저 마쳐야 합니다.',s.checkpoint);
      // Falling logs can enter the inventory while scouting another stand.
      // Recheck actual stock before choosing another species or search leg.
      if(stocked()){recovery.progress();return;}
      await this.settleDirectHarvest(names,s,recovery);
      const block = this.bot.findBlock({ matching:b=>names.includes(b.name),useExtraInfo:b=>this.collectible(b,s)&&(this.directlyHarvestable(b,s)||recovery.canApproach()&&!recovery.failed(b.position)&&recovery.within(b.position)&&this.resourceStands(b,s).some(p=>recovery.route(vector(p)))),maxDistance:48 });
      if (block && (recovery.canApproach()||this.directlyHarvestable(block,s))) {
        try { await this.collect(block.name,this.count(block.name)+1,s,position(block.position),recovery); continue; }
        catch(error) {s.check();if(!(error instanceof ConditionWait))throw error;recovery.reject(block.position,block.name,error.message);continue;}
      }
      if (await recovery.move()) continue;
      if (recovery.journey?.pending) {await s.pause(100);continue;}
      if (recovery.beginResourceJourney()) continue;
      throw recovery.wait('작업대용으로 실제 접근 가능한 자연 나무를 찾고 있습니다.',1);
    }
  }
  private async pickup(location: { x: number; y: number; z: number }, s: ActionServices, item?: string, minimum = Infinity, avoidSupports: Position[] = []): Promise<void> {
    const p = vector(location);
    for (let round = 0; round < (item ? 20 : 3); round++) {
      s.check();
      if (item && this.count(item) >= minimum) return;
      const drops = Object.values(this.bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(p) < 5);
      for (const drop of drops.slice(0, 12)) {
        if (item && typeof drop.getDroppedItem === 'function' && drop.getDroppedItem()?.name !== item) continue;
        // A freshly broken upper log can still be falling. Its first packet
        // is not a reachable stand position; reobserve until it has ground.
        const feet = walkingFeet(this.bot,drop.position), support = this.bot.blockAt(feet.offset(0, -1, 0));
        const body = this.bot.blockAt(feet), head = this.bot.blockAt(feet.offset(0, 1, 0));
        if (s.checkpoint.farmDryGround!==true&&avoidSupports.some(p => p.x === feet.x && p.y === feet.y - 1 && p.z === feet.z)) continue;
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

  private async craftAvailableWeapon(s:ActionServices,table:Block|null):Promise<void>{
    if(s.checkpoint.materialExpedition!==true||!['craft','fight'].every(action=>this.options.config.allowedActions.includes(action as ActionKind))||combatEquipment(this.bot).weapon||!table||this.bot.blockAt(table.position)?.name!=='crafting_table'||this.bot.entity.position.distanceTo(table.position)>4.5||Object.values(this.bot.entities??{}).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(this.bot.entity.position)<12))return;
    for(const item of ['stone_sword','wooden_sword']){
      const data=this.bot.registry.itemsByName[item];if(!data)continue;
      const recipe=this.bot.recipesFor(data.id,null,1,table)[0];if(!recipe)continue;
      s.check();s.progress('생존 도구 준비','현재 남은 재료로 검을 제작해 채굴 중의 가까운 적에 대비합니다.');
      const before=this.count(item);await this.bot.craft(recipe,1,table);await s.pause(150);
      const until=Date.now()+2000;while(this.count(item)<=before&&Date.now()<until){s.check();await s.pause(50);}
      this.recordInventory(s);s.check();
      if(this.count(item)<=before)throw new ActionFailure('생존용 검의 실제 제작 결과를 확인하지 못했습니다.','CRAFT_UNCERTAIN',false,false);
      s.checkpoint.survivalWeapon={item,table:position(table.position),observedAt:Date.now()};return;
    }
  }

  private furnaceFuels(): string[] {
    return ['coal', 'charcoal', ...Object.keys(this.bot.registry.itemsByName).filter(name => name.endsWith('_planks') && !['crimson_planks', 'warped_planks'].includes(name))];
  }

  private fuelAmount(name: string, smelts: number): number { return Math.ceil(smelts / (name.endsWith('_planks') ? 1.5 : 8)); }

  private async furnaceFuel(itemName: string, amount: number, s: ActionServices, chain: Set<string>) {
    const stocked = () => this.bot.inventory.items().find(item => this.furnaceFuels().includes(item.name) && item.count >= this.fuelAmount(item.name, amount));
    const existing = stocked(); if (existing) return existing;
    const table = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 24 });
    const evaluation: RecipeEvaluation = { remaining: 1024, table, recipes: new Map(), sources: new Map(), costs: new Map(), resourceNames: new Set() };
    const candidates = this.furnaceFuels().map(name => ({ name, cost: this.acquisitionCost(name, this.fuelAmount(name, amount), chain, s, evaluation) }))
      .filter(candidate => Number.isFinite(candidate.cost)).sort((a, b) => a.cost - b.cost);
    let preparationWait: ConditionWait | undefined;
    for (const candidate of candidates.slice(0, 5)) {
      try {
        await this.ensureItem(candidate.name, this.fuelAmount(candidate.name, amount), s, chain);
        const fuel = stocked(); if (fuel) return fuel;
      } catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; preparationWait = error; }
    }
    if (preparationWait) throw preparationWait;
    const recovery = this.resourceRecovery(itemName, [...evaluation.resourceNames].slice(0, 100), s);
    throw recovery.wait('현재 소지한 연료나 관측한 자연 목재·석탄으로 제련 연료를 확보해야 합니다.', amount);
  }

  private recipeCost(recipe: CraftRecipe, minimum: number, current: number, chain: Set<string>, s: ActionServices, evaluation: RecipeEvaluation): number {
    return this.recipeEstimate(recipe, minimum, current, chain, s, evaluation).cost;
  }

  private recipeEstimate(recipe: CraftRecipe, minimum: number, current: number, chain: Set<string>, s: ActionServices, evaluation: RecipeEvaluation): AcquisitionEstimate {
    const times = Math.ceil((minimum - current) / recipe.result.count);
    const estimates: AcquisitionEstimate[] = [];
    for (const ingredient of recipe.delta.filter(i => i.count < 0)) {
      const name = this.bot.registry.items[ingredient.id]?.name;
      if (!name) return { cost: Infinity, dependencies: new Set(), depth: 0 };
      // Evaluate every ingredient so a wait can watch all candidate raw materials.
      estimates.push(this.acquisitionEstimate(name, -ingredient.count * times, chain, s, evaluation));
    }
    // Reject absent raw variants before repeatedly evaluating their shared table.
    if (estimates.every(value => Number.isFinite(value.cost)) && recipe.requiresTable && !evaluation.table) estimates.push(this.acquisitionEstimate('crafting_table', 1, chain, s, evaluation));
    return { cost: estimates.reduce((sum, value) => sum + value.cost, 0), dependencies: new Set(estimates.flatMap(value => [...value.dependencies])), depth: Math.max(0, ...estimates.map(value => value.depth)) };
  }

  private acquisitionCost(item: string, minimum: number, chain: Set<string>, s: ActionServices, evaluation: RecipeEvaluation): number {
    return this.acquisitionEstimate(item, minimum, chain, s, evaluation).cost;
  }

  private acquisitionEstimate(item: string, minimum: number, chain: Set<string>, s: ActionServices, evaluation: RecipeEvaluation): AcquisitionEstimate {
    s.check();
    const missing = minimum - this.count(item);
    if (missing <= 0) return { cost: 0, dependencies: new Set(), depth: 0 };
    const unavailable = (): AcquisitionEstimate => ({ cost: Infinity, dependencies: new Set([item]), depth: 1 });
    if (chain.has(item) || chain.size > 10) return unavailable();
    const sharedKey = `${item}:${minimum}`, contextKey = `${sharedKey}:${[...chain].sort().join(',')}`;
    const shared = evaluation.costs.get(sharedKey);
    // A finite path can be shared across wood/fuel variants only when none of
    // its dependencies would close a cycle in the caller's current ancestry.
    if (shared && chain.size + shared.depth <= 11 && ![...shared.dependencies].some(name => chain.has(name))) return shared;
    const contextual = evaluation.costs.get(contextKey);
    if (contextual) return contextual;
    // Cache reads do not spend the bounded graph evaluation budget.
    if (evaluation.remaining-- <= 0) return unavailable();
    const next = new Set(chain); next.add(item);
    let estimate = unavailable();
    if (item in dropBlocks || item.endsWith('_log') || ['sand', 'gravel'].includes(item)) {
      for (const name of dropBlocks[item] ?? [item]) evaluation.resourceNames.add(name);
      if (this.options.config.allowedActions.includes('collect')) {
        if (!evaluation.sources.has(item)) evaluation.sources.set(item, this.bot.findBlock({ matching: b => this.collectMatches(item, b.name), useExtraInfo: b => this.collectible(b, s), maxDistance: 48 }));
        const block = evaluation.sources.get(item);
        if (block) {
          const tool = block.canHarvest(this.bot.heldItem?.type ?? null) || this.bot.inventory.items().some(i => block.canHarvest(i.type)) ? { cost: 0, dependencies: new Set<string>(), depth: 0 } : this.acquisitionEstimate(this.harvestTool(block.name), 1, next, s, evaluation);
          // A source is a candidate, not proof of its total yield or accessibility.
          estimate = { cost: missing + block.position.distanceTo(vector(this.bot.entity.position)) / 48 + tool.cost, dependencies: new Set([item, ...tool.dependencies]), depth: 1 + tool.depth };
        } else if (s.checkpoint.materialExpedition===true && this.options.config.allowedActions.includes('explore')) {
          // This is search effort, not evidence that a missing source exists.
          // Only the opted-in material stage may consider a distant raw input.
          estimate={cost:100+missing,dependencies:new Set([item]),depth:1};
        }
      }
    } else if (smeltInputs[item] && this.options.config.allowedActions.includes('smelt')) {
      // Observe the actual smelting input first. An unavailable input must
      // remain a wait source even when facility/fuel alternatives are costly.
      const input = this.acquisitionEstimate(smeltInputs[item], missing, next, s, evaluation);
      if (Number.isFinite(input.cost)) {
        const furnace = this.ownedUtilities.get('furnace');
        const facility = furnace && this.bot.blockAt(furnace)?.name === 'furnace' ? { cost: 0, dependencies: new Set<string>(), depth: 0 } : this.acquisitionEstimate('furnace', 1, next, s, evaluation);
        if (Number.isFinite(facility.cost)) {
          let fuel = unavailable();
          for (const name of this.furnaceFuels()) {
            const candidate = this.acquisitionEstimate(name, this.fuelAmount(name, missing), next, s, evaluation);
            if (candidate.cost < fuel.cost) fuel = candidate;
          }
          estimate = { cost: input.cost + facility.cost + fuel.cost, dependencies: new Set([item, ...input.dependencies, ...facility.dependencies, ...fuel.dependencies]), depth: 1 + Math.max(input.depth, facility.depth, fuel.depth) };
        }
      }
    } else if (this.options.config.allowedActions.includes('craft')) {
      for (const recipe of this.recipes(item, evaluation)) {
        if (evaluation.remaining-- <= 0) break;
        const candidate = this.recipeEstimate(recipe, minimum, this.count(item), next, s, evaluation);
        if (candidate.cost < estimate.cost) estimate = { cost: candidate.cost, dependencies: new Set([item, ...candidate.dependencies]), depth: 1 + candidate.depth };
      }
    }
    if (!Number.isFinite(estimate.cost) && item in huntDrops && this.options.config.allowedActions.includes('hunt')) {
      evaluation.resourceNames.add(huntDrops[item]!);
      const seen = Object.values(this.bot.entities).some(e => e.name === huntDrops[item] && e.position.distanceTo(this.bot.entity.position) <= 40 &&(!shoreFish.has(e.name??'')||this.safeFoodHunt(e))&&
        !(s.rules.center && Math.hypot(e.position.x - s.rules.center.x, e.position.z - s.rules.center.z) <= s.rules.radius));
      if (seen) estimate = { cost: missing, dependencies: new Set([item]), depth: 1 };
    }
    // Infinity can be caused by the current ancestor cycle, so keep failures
    // contextual. Only an actually feasible dependency path is shared.
    evaluation.costs.set(Number.isFinite(estimate.cost) ? sharedKey : contextKey, estimate);
    return estimate;
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
    // Generic wooden tools and sticks accept any wood. Choose a real accessible
    // log before pinning their recipe, including when a table already exists.
    let table = this.bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 24 });
    if (['crafting_table','stick','wooden_pickaxe','wooden_axe','wooden_shovel','wooden_hoe','wooden_sword'].includes(itemName) && s.checkpoint.materialExpedition===true && ['explore','collect','craft'].every(action=>this.options.config.allowedActions.includes(action as ActionKind)) && !this.bot.recipesFor(data.id,null,1,table).length){
      const recipe=this.bot.recipesAll(data.id,null,true).find(r=>r.delta.some(i=>i.count<0&&this.bot.registry.items[i.id]?.name.endsWith('_planks')));
      if(recipe){
        const times=Math.ceil((minimum-this.count(itemName))/recipe.result.count);
        const planks=-recipe.delta.filter(i=>i.count<0&&this.bot.registry.items[i.id]?.name.endsWith('_planks')).reduce((sum,i)=>sum+i.count*times,0);
        const sticks=-recipe.delta.filter(i=>i.count<0&&this.bot.registry.items[i.id]?.name==='stick').reduce((sum,i)=>sum+i.count*times,0);
        const tablePlanks=recipe.requiresTable&&!table&&!this.count('crafting_table')?4:0,stickPlanks=Math.ceil(Math.max(0,sticks-this.count('stick'))/4)*2;
        const needed=planks+stickPlanks+tablePlanks;
        await this.utilityWood(s,needed,Math.max(planks,tablePlanks,stickPlanks?2:0));
        table=this.bot.findBlock({matching:b=>b.name==='crafting_table',maxDistance:24});
        if(recipe.requiresTable&&!table){await this.ensureItem('crafting_table',1,s,next);table=await this.utilityAccess(s,async()=>{await this.returnForUtility(s);return this.bot.findBlock({matching:b=>b.name==='crafting_table',maxDistance:24})??await this.placeUtility('crafting_table',s);});}
        if(sticks>this.count('stick'))await this.ensureItem('stick',sticks,s,next);
      }
    }
    const evaluation: RecipeEvaluation = { remaining: 1024, table, recipes: new Map(), sources: new Map(), costs: new Map(), resourceNames: new Set() };
    const recipes = this.recipes(itemName, evaluation).filter(r => r.delta.filter(i => i.count < 0).every(i => !next.has(this.bot.registry.items[i.id]?.name ?? '')));
    const candidates = this.options.config.allowedActions.includes('craft') ? recipes.map(recipe => ({ recipe, cost: this.recipeCost(recipe, minimum, this.count(itemName), next, s, evaluation),
      inventoryMissing: recipe.delta.filter(i => i.count < 0).reduce((sum, i) => sum + Math.max(0, -i.count * Math.ceil((minimum - this.count(itemName)) / recipe.result.count) - this.count(this.bot.registry.items[i.id]?.name ?? '')), 0) }))
      .filter(candidate => Number.isFinite(candidate.cost)).sort((a, b) => a.cost - b.cost || a.inventoryMissing - b.inventoryMissing) : [];
    const savedPreparations=s.checkpoint.craftPreparations;
    const preparations=savedPreparations&&typeof savedPreparations==='object'&&!Array.isArray(savedPreparations)?savedPreparations:{};
    const diagnostic:typeof preparations={item:itemName,minimum,chain:[...chain],inventory:inventory(this.bot),table:table?position(table.position):null,observedAt:Date.now(),variants:candidates.slice(0,5).map(({recipe,cost})=>({cost,ingredients:recipe.delta.filter(i=>i.count<0).map(i=>({name:this.bot.registry.items[i.id]?.name??'unknown',count:-i.count}))}))};
    preparations[itemName]=diagnostic;s.checkpoint.craftPreparations=Object.fromEntries(Object.entries(preparations).slice(-16));
    let prepared: CraftRecipe | undefined, preparationWait: ConditionWait | undefined;
    for (const { recipe } of candidates.slice(0, 5)) {
      try {
        diagnostic.selected=recipe.delta.filter(i=>i.count<0).map(i=>({name:this.bot.registry.items[i.id]?.name??'unknown',count:-i.count}));
        const times = Math.ceil((minimum - this.count(itemName)) / recipe.result.count);
        if (recipe.requiresTable && !table) {
          await this.ensureItem('crafting_table', 1, s, next);
          table=await this.utilityAccess(s,async()=>{await this.returnForUtility(s);return this.bot.findBlock({matching:b=>b.name==='crafting_table',maxDistance:24})??await this.placeUtility('crafting_table',s);});
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
        if ((recipe.requiresTable||warehouseInterior(s))&&table) {
          await this.utilityAccess(s,async()=>{await this.returnForUtility(s);
          // Gathering may have selected a forest table before the real return.
          // Reobserve the work point instead of walking back to that old table.
          const observed=this.bot.findBlock({matching:b=>b.name==='crafting_table',maxDistance:24})??table;
          if(!observed||this.bot.blockAt(observed.position)?.name!=='crafting_table')throw new ConditionWait('제작할 실제 작업대를 다시 확인해야 합니다.',s.checkpoint);
          table=observed;await s.near(observed.position, 2);});
        }
        prepared = recipe; break;
      } catch (error) {
        s.check();
        if (!(error instanceof ConditionWait)) throw error;
        if(resourceTrip(s.checkpoint)?.phase==='returning'||this.utilityAccessFailures.has(error))throw error;
        preparationWait = error;
        diagnostic.reason=error.message.slice(0,500);
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
        // Reopen the real base worktable after warehouse transfers, including
        // small recipes; its fresh window avoids relying on an old inventory grid.
        const craftTable=prepared.requiresTable||warehouseInterior(s)?table:null;
        const possibleRecipes = this.bot.recipesFor(data.id, null, 1, craftTable);
        const possible = possibleRecipes.find(r => recipeKey(r) === recipeKey(prepared!)) ?? possibleRecipes[0];
        if (!possible) throw new ConditionWait('현재 재료와 작업대에서 제작 가능한 조합이 없습니다.');
        // Separate public craft calls let the final click settle before the next recipe.
        await this.bot.craft(possible, 1, craftTable ?? undefined);
        await s.pause(150);
        const deadline = Date.now() + 2000;
        while (this.count(itemName) < before + possible.result.count && Date.now() < deadline) { s.check(); await s.pause(50); }
        this.recordInventory(s); s.check();
        if (this.count(itemName) < before + possible.result.count) throw new ActionFailure('제작 산출물을 확인하지 못했습니다.', 'CRAFT_UNCERTAIN', false, false);
      }
      if(itemName.endsWith('_pickaxe'))await this.craftAvailableWeapon(s,table);
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
      if (!resourceClearance(block) || below?.boundingBox !== 'block' || unsafeBlocks.has(below.name)) continue;
      if (block && !['air', 'cave_air', 'void_air'].includes(block.name)) {
        await s.near(p, 2); s.check();
        const actual = this.bot.blockAt(p);
        if (!actual || !resourceClearance(actual) || this.protectedBuildPosition(p, s)) continue;
        if (!['air', 'cave_air', 'void_air'].includes(actual.name)) {
          if (typeof this.bot.canSeeBlock !== 'function' || !this.bot.canSeeBlock(actual)) continue;
          await this.bot.dig(actual); s.check();
          const cleared = this.bot.blockAt(p);
          if (!cleared || !['air', 'cave_air', 'void_air'].includes(cleared.name)) throw new ActionFailure('작업대 공간의 자연 풀 정리 결과를 확인해야 합니다.', 'DIG_UNCERTAIN', false, false);
          s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'blocks', data: { blocks: [{ position: position(p), name: cleared.name }] } });
        }
      }
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
    await this.returnForUtility(s);
    const savedFurnace = PositionSchema.safeParse(s.checkpoint.furnacePosition);
    if (savedFurnace.success && this.bot.blockAt(vector(savedFurnace.data))?.name === 'furnace') this.ownedUtilities.set('furnace', vector(savedFurnace.data));
    if (!this.ownedUtilities.has('furnace')) await this.ensureItem('furnace', 1, s, chain);
    const furnaceBlock = await this.placeUtility('furnace', s);
    const fuel = await this.furnaceFuel(itemName, amount, s, chain);
    await s.near(furnaceBlock.position, 2); const furnace = await this.bot.openFurnace(furnaceBlock);
    try {
      const storedInput = furnace.inputItem(), output = furnace.outputItem();
      if (storedInput && storedInput.name !== input || output && output.name !== itemName) throw new ConditionWait('제련기의 기존 작업이 끝날 때까지 기다립니다.');
      const inputItem = this.bot.inventory.items().find((i) => i.name === input);
      if (!inputItem) throw new ConditionWait('제련 원재료를 확인해야 합니다.');
      const missingInput = Math.max(0, amount - (storedInput?.count ?? 0));
      if (missingInput > 0) await furnace.putInput(inputItem.type, null, missingInput);
      await furnace.putFuel(fuel.type, null, this.fuelAmount(fuel.name, amount));
      const deadline = Date.now() + amount * 12000 + 15000;
      while (this.count(itemName) < minimum && Date.now() < deadline) {
        s.check(); s.progress('제련', `${itemName} ${this.count(itemName)}/${minimum}`);
        if (furnace.outputItem()?.name === itemName) { await furnace.takeOutput(); this.recordInventory(s); }
        await s.pause(250);
      }
      if (this.count(itemName) < minimum) throw new ConditionWait('제련 산출물을 계속 확인해야 합니다.', { furnacePosition: position(furnaceBlock.position), item: itemName, minimum });
    } finally { await furnace.close(); }
  }

  private async warehouseFood(s: ActionServices): Promise<boolean> {
    const container = s.rules.warehouse;
    if (!container || !this.options.config.allowedActions.includes('take') || container.world !== this.options.world || container.dimension !== this.options.dimension()) return false;
    if(s.rules.baseShelter?.warehouseId===container.id&&this.bot.entity.position.distanceTo(vector(s.rules.baseShelter.outside))>32){
      s.progress('창고 보급 경로 관측','등록한 거점 방향의 실제 안전한 지면을 확인하며 식량 재고를 확인하러 돌아갑니다.');
      await approachKnownBase(s,s.rules.baseShelter.outside);
    }
    const observation = await this.observeContainer(container, s);
    if (observation.kind !== 'container') return false;
    s.checkpoint.foodWarehouse = { container, items: observation.data.items.map(item => ({ name: item.name, count: item.count })) };
    const food = observation.data.items.find(item => foodNames.has(item.name) && item.count > 0 && this.bot.registry.itemsByName[item.name]);
    if (!food) return false;
    s.progress('식량 확보', `공동 창고에서 실제 ${food.name} 1개를 가져옵니다.`);
    await this.transfer(container, food.name, 1, 'take', s);
    const after = [...s.observations].reverse().find(o => o.kind === 'container' && o.data.container.id === container.id);
    if (after?.kind === 'container') s.checkpoint.foodWarehouse = { container, items: after.data.items.map(item => ({ name: item.name, count: item.count })) };
    return this.count(food.name) > 0;
  }

  async shelterAtNight(s:ActionServices):Promise<boolean>{
    const permitted=()=>['build','collect'].every(action=>this.options.config.allowedActions.includes(action as ActionKind));
    if(s.checkpoint.nightBurrowPending!==true&&await restInWarehouse(s,()=>this.options.config.enabled,async()=>{if(!await this.eat(s)&&await this.warehouseFood(s))await this.eat(s);}))return true;
    if(!permitted()&&s.checkpoint.nightBurrowPending!==true)return false;
    const sheltered=await restInNightBurrow(s,p=>this.protectedBuildPosition(p,s),()=>this.options.config.enabled&&permitted());
    if(!sheltered)s.checkpoint.nightBurrowPending=false;
    return sheltered;
  }

  async ensureFood(s: ActionServices): Promise<void> {
    s.check();
    if(s.checkpoint.nightBurrowPending===true||s.checkpoint.nightBasePending===true)await this.shelterAtNight(s);
    if (this.bot.inventory.items().some(i => foodNames.has(i.name))) return;
    const gear=combatEquipment(this.bot);
    if(this.bot.time?.doDaylightCycle===true&&duskOrNight(this.bot)&&this.bot.health>this.options.rules.combat.retreatHealth&&!(gear.weapon&&(gear.shield||gear.armorPoints>=12))){
      if(!await this.shelterAtNight(s)){s.checkpoint.nightShelterUnavailable=true;throw new ConditionWait('야간의 장비 없는 식량 원정은 실제 안전한 대피처와 낮을 먼저 확인합니다.',s.checkpoint);}
      if(this.bot.food>=(s.checkpoint.expeditionFoodTarget===19?19:18)||this.bot.inventory.items().some(i=>foodNames.has(i.name)))return;
    }
    const scope = s.checkpoint.resourceRecoveryScope;
    s.checkpoint.resourceRecoveryScope = '$food';
    let waiting: ConditionWait | undefined;
    try {
      let warehousePosition: Vec3 | undefined, warehouseElapsed = 0;
      const checkWarehouse = async (): Promise<boolean> => {
        warehousePosition = vector(this.bot.entity.position); const started = Date.now();
        try { return await this.warehouseFood(s); }
        catch (error) {
          s.check(); if (!(error instanceof ConditionWait)) throw error;
          const container = s.rules.warehouse, feet = vector(this.bot.entity.position).floored();
          const positions = [position(feet), position(feet.offset(0, 1, 0)), position(feet.offset(0, -1, 0)), ...(container ? [container.position] : [])];
          const blocks = positions.flatMap(p => { const actual = this.bot.blockAt(vector(p)); return actual ? [{ position: p, name: actual.name }] : []; });
          s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'blocks', data: { blocks } });
          waiting = new ConditionWait(error.message, { ...error.checkpoint, resourcePositions: positions });
          return false;
        } finally { warehouseElapsed += Math.max(0, Date.now() - started); }
      };
      for (let round = 0; ; round++) {
        s.check();
        // A blocked base approach belongs to its actual viewpoint. Recheck
        // after real exploration, retaining both food and return allowances.
        if ((!warehousePosition || warehousePosition.distanceTo(vector(this.bot.entity.position)) >= 8) && await checkWarehouse()) return;
        const table = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 24 });
        const evaluation: RecipeEvaluation = { remaining: 1024, table, recipes: new Map(), sources: new Map(), costs: new Map(), resourceNames: new Set() };
        const candidates = [...foodNames].filter(item => {
          if (!this.bot.registry.itemsByName[item]) return false;
          // Passive food animals require no nearby hostile and an observed
          // safe route; a lost weapon must not make visible food unusable.
          const raw = smeltInputs[item] ?? item;
          return this.bot.health > s.rules.combat.retreatHealth || !(raw in huntDrops) || this.count(raw) > 0 || Object.values(this.bot.entities).some(e=>e.name===huntDrops[raw]&&this.safeFoodHunt(e));
        }).map(item => ({ item, cost: this.acquisitionCost(item, 1, new Set(), s, evaluation) }))
          .filter(candidate => Number.isFinite(candidate.cost)).sort((a, b) => a.cost - b.cost);
        s.checkpoint.foodSourceObservation={position:position(this.bot.entity.position),health:this.bot.health,food:this.bot.food,weapon:combatEquipment(this.bot).weapon,animals:Object.values(this.bot.entities).filter(e=>HUNTABLE.has(e.name??'')&&e.position.distanceTo(this.bot.entity.position)<=40).slice(0,16).map(e=>({name:e.name??'',position:position(e.position),safeRoute:this.safeFoodHunt(e)})),candidates:candidates.slice(0,5),observedAt:Date.now()};
        const recovery = this.resourceRecovery('$food', [...evaluation.resourceNames].slice(0, 100), s);
        if (this.options.config.enabled && await recovery.reanchorFoodJourney()) continue;
        if (recovery.state.foodJourney && !this.options.config.enabled) {
          recovery.pauseFoodJourney(); throw recovery.wait('식량 원정의 이동 기록을 보존하고 일시정지했습니다.');
        }
        recovery.state.elapsedMs = Math.min(recovery.timeLimit + 20000, recovery.state.elapsedMs + warehouseElapsed); warehouseElapsed = 0;
        for (const { item } of candidates.slice(0, 5)) {
          if (!recovery.state.foodJourney && recovery.state.elapsedMs >= recovery.timeLimit) break;
          const started = Date.now();
          try { await this.ensureItem(item, 1, s); if (this.count(item) > 0) { recovery.progress(); return; } }
          catch (error) { s.check(); if (!(error instanceof ConditionWait)) throw error; waiting = error; }
          finally { recovery.state.elapsedMs = Math.min(recovery.timeLimit + 20000, recovery.state.elapsedMs + Math.max(0, Date.now() - started)); }
          if (!recovery.state.foodJourney && recovery.state.elapsedMs >= recovery.timeLimit) break;
        }
        if(this.bot.time?.doDaylightCycle===true&&duskOrNight(this.bot)&&await this.shelterAtNight(s))continue;
        if (await recovery.move()) { await s.pause(50); continue; }
        if (recovery.state.foodJourney?.pending) { await s.pause(100); continue; }
        if (recovery.expandFoodSearch()) continue;
        if (this.options.config.enabled && recovery.beginFoodJourney()) continue;
        const error = recovery.wait(recovery.state.foodJourney ? '더 먼 식량을 찾는 원정 경로가 막혔습니다. 실제 식량이나 안전한 접근 경로의 변화를 기다립니다.' : `안전한 식량 경로를 최대 ${recovery.radius}블록 범위에서 확인했지만 확보하지 못했습니다. 새 식량·접근 경로·창고 입고가 필요합니다.`);
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
    await this.bot.equip(food, 'hand'); s.check(); await this.bot.consume();
    // Consumption can finish before the public inventory/health packets arrive.
    // Await those observations without sending a second consume request.
    const deadline=Date.now()+2000;
    while((this.bot.food<=before||this.count(food.name)>=count)&&Date.now()<deadline){s.check();await s.pause(50);}
    this.recordInventory(s);
    if (this.bot.food <= before && this.count(food.name) >= count) throw new ActionFailure('섭취 결과를 확인하지 못했습니다.', 'EAT_UNCERTAIN', false, false);
    const meals=Array.isArray(s.checkpoint.foodMeals)?s.checkpoint.foodMeals:[];
    s.checkpoint.foodMeals=[...meals,{item:food.name,beforeFood:before,afterFood:this.bot.food,beforeCount:count,afterCount:this.count(food.name),position:position(this.bot.entity.position),world:this.options.world,dimension:this.options.dimension(),worldAge:this.bot.time?.age??null,observedAt:Date.now()}].slice(-8);
    s.progress('식량 섭취',`${food.name}의 실제 소비를 확인했습니다 (허기 ${before} → ${this.bot.food}).`);
    return true;
  }
  async retreat(target: Entity, s: ActionServices): Promise<void> {
    await retreatToSafety(this.bot, target, s, p => this.protectedBuildPosition(vector(p), s));
    s.observations.push({ ...observationBase(this.options.world, this.options.dimension()), kind: 'position', data: { position: position(this.bot.entity.position) } });
  }
  private passiveHuntStepClear(p:Position):boolean{return !Object.values(this.bot.entities).some(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(vector(p))<20);}
  private passiveHuntClear(target:Entity):boolean{return this.bot.health>0&&HUNTABLE.has(target.name??'')&&target.type!=='player'&&!target.username&&this.passiveHuntStepClear(this.bot.entity.position)&&this.passiveHuntStepClear(target.position);}
  private foodHuntRoute(target:Entity):Position[]|undefined {
    if(!this.options.config.allowedActions.includes('hunt')||!this.passiveHuntClear(target))return;
    if(!shoreFish.has(target.name??''))return safeResourceRoute(this.bot,target.position,{radius:2,clear:p=>this.passiveHuntStepClear(p)});
    const candidates:Vec3[]=[],center=vector(target.position).floored();
    for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++){
      const p=center.offset(dx,1,dz),eye=p.offset(.5,1.62,.5);
      if(Math.hypot(p.x+.5-target.position.x,p.z+.5-target.position.z)>1.5||eye.distanceTo(vector(target.position).offset(0,.2,0))>3.25||!observedGroundStand(this.bot,p,undefined,true)||!this.passiveHuntStepClear(p))continue;
      candidates.push(p);
    }
    candidates.sort((a,b)=>a.distanceTo(vector(this.bot.entity.position))-b.distanceTo(vector(this.bot.entity.position)));
    for(const p of candidates.slice(0,4)){const path=observedGroundRoute(this.bot,p,48,undefined,true);if(path&&path.every(q=>this.passiveHuntStepClear(q)))return path;}
  }
  private safeFoodHunt(target:Entity):boolean{return this.foodHuntRoute(target)!==undefined;}
  private combatDecision(target: Entity, s: ActionServices) {
    if(this.passiveHuntClear(target))return{response:'attack' as const,reason:'위협 없는 수동적 식량 대상과 현재 사냥 조건을 확인했습니다.',supportRequired:false};
    const threats = this.visibleCombatThreats();
    const allies = Object.values(this.bot.players).filter(player => player.entity && player.entity.id !== this.bot.entity.id && player.entity.position.distanceTo(this.bot.entity.position) < 8).length;
    // The caller already authorized this hostile or hunt target. Reuse the
    // gear and survival policy without reinterpreting an explicit fight goal
    // as an unsolicited attack.
    return assessCombat({ role: this.options.config.role, health: this.bot.health, food: this.bot.food, ...combatEquipment(this.bot), enemies: Math.max(1, threats.length), rangedEnemies: threats.filter(e => rangedThreat(e.name ?? '')).length, allies, attacked: true, threateningVillage: false, targetName: target.name ?? '', distance: target.position.distanceTo(this.bot.entity.position) }, { ...s.rules, combat: { ...s.rules.combat, counterattackWhenAttacked: true } });
  }
  private visibleCombatThreats(): Entity[] {
    const observed=typeof this.bot.world?.raycast==='function';
    return Object.values(this.bot.entities).filter(e=>HOSTILES.has(e.name??'')&&e.position.distanceTo(this.bot.entity.position)<20&&(!observed||visibleThreat(this.bot,e)));
  }
  private retreatThreat(target: Entity): Entity {
    const threats=this.visibleCombatThreats().sort((a,b)=>a.position.distanceTo(this.bot.entity.position)-b.position.distanceTo(this.bot.entity.position));
    const threat=threats.find(e=>visibleRangedThreat(this.bot,e))??threats[0];
    if(!threat&&HUNTABLE.has(target.name??''))throw new ConditionWait('현재 체력·허기로 사냥을 지속할 수 없어 다른 안전한 식량을 확인해야 합니다.');
    return threat??target;
  }
  private async approachCombat(target: Entity, s: ActionServices, validTarget: () => boolean): Promise<void> {
    const controller = new AbortController(); let unsafe = false, expired = false;
    const stop = () => { const decision = this.combatDecision(target, s); expired = !validTarget(); if (expired || ['retreat', 'support', 'ignore'].includes(decision.response)) { unsafe = true; controller.abort(); } };
    const parentAbort = () => controller.abort(); s.signal.addEventListener('abort', parentAbort, { once: true });
    this.bot.on('health', stop); this.bot.on('entityMoved', stop);
    const timer = setInterval(stop, 100);
    try {
      stop();if (combatEquipment(this.bot).shield && rangedThreat(target.name ?? '')) this.bot.activateItem(true);
      if(HUNTABLE.has(target.name??'')&&(this.bot.health<=s.rules.combat.retreatHealth||!combatEquipment(this.bot).weapon||shoreFish.has(target.name??''))){
        const path=this.foodHuntRoute(target);
        if(!path)throw new ConditionWait('낮은 체력의 식량 사냥에는 대상에 맞는 장비·적 이탈·전체 안전한 보행 경로가 필요합니다.');
        const stand=(p:Position)=>this.passiveHuntClear(target)&&this.passiveHuntStepClear(p)&&(shoreFish.has(target.name??'')?observedGroundStand(this.bot,p,undefined,true):safeResourceStand(this.bot,p,()=>false));
        if(!await walkVerified(this.bot,path,controller.signal,stand,(p,child)=>this.near(p,child,0))){if(shoreFish.has(target.name??''))throw new ConditionWait('생선에 접근할 실제 육지 보행 경로를 다시 확인해야 합니다.');for(const p of path){s.check();if(!stand(p))throw new ConditionWait('식량 접근 중 실제 위협이나 지면이 바뀌었습니다.');await this.near(vector(p).offset(.5,0,.5),controller.signal,0);}}
      }else await this.near(target.position, controller.signal, 2);
    }
    catch (error) { s.check(); if (unsafe && error instanceof ActionFailure && error.code === 'CANCELLED') { if (expired) throw new ConditionWait('지원 대상의 세션, 유효 시간과 관측을 다시 확인해야 합니다.'); return; } throw error; }
    finally { clearInterval(timer); this.bot.removeListener('health', stop); this.bot.removeListener('entityMoved', stop); s.signal.removeEventListener('abort', parentAbort); }
  }
  async fightEntity(target: Entity, s: ActionServices, hunt = false, validTarget: () => boolean = () => true): Promise<void> {
    if (target.type === 'player' || target.username || !(hunt ? HUNTABLE : HOSTILES).has(target.name ?? '')) throw new ConditionWait('허용된 전투 대상을 확인해야 합니다.');
    if(hunt&&this.passiveHuntClear(target)&&(shoreFish.has(target.name??'')||!combatEquipment(this.bot).weapon||this.bot.health<=s.rules.combat.retreatHealth)){if(!this.safeFoodHunt(target))throw new ConditionWait('식량 사냥에는 실제 안전한 육지 접근로와 주변 위협 이탈이 필요합니다.');s.checkpoint.safeDetourRequired=true;}
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
          s.progress('퇴각', decision.reason); await this.retreat(this.retreatThreat(target), s); throw new ConditionWait('지원과 회복 후 전투를 다시 확인합니다.', s.checkpoint);
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
      const candidate = Object.values(this.bot.entities).filter((e) => e.name === name && HUNTABLE.has(e.name) && e.position.distanceTo(this.bot.entity.position) <= 40 && !(s.rules.center && Math.hypot(e.position.x - s.rules.center.x, e.position.z - s.rules.center.z) <= s.rules.radius)&&(!shoreFish.has(e.name)||this.safeFoodHunt(e))&&(this.bot.health>s.rules.combat.retreatHealth||this.safeFoodHunt(e))).sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position))[0];
      if (!candidate) throw new ConditionWait('마을의 보호 가축을 제외한 사냥 대상을 찾아야 합니다.');
      const before=item?this.count(item):0;await this.fightEntity(candidate, s, true); count++;
      if(shoreFish.has(name)&&item&&this.count(item)<=before)throw new ConditionWait('생선 처치는 확인했지만 육지에서 실제 식량 아이템을 회수해야 합니다.',s.checkpoint);
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
    if (task.kind === 'build' && task.params.mode === 'register-warehouse') return this.registerWarehouse(task, s);
    if(task.kind==='build'&&task.params.mode==='material-access')return prepareMaterialAccess(task,s,p=>this.protectedBuildPosition(p,s),()=>this.options.config.enabled&&['build','collect'].every(action=>this.options.config.allowedActions.includes(action as ActionKind)));
    if (['fight', 'guard'].includes(task.kind) && typeof task.params.supportRequestId === 'string') { await this.supportFight(task, s); this.recordInventory(s); s.check(); return this.result(s); }
    switch (task.kind) {
      case 'collect': {
        s.checkpoint.resourceExpedition = this.options.config.allowedActions.includes('explore');
        if (task.params.returnTo!==undefined) {const home=PositionSchema.parse(task.params.returnTo),searchFrom=task.params.searchFrom===undefined?undefined:PositionSchema.parse(task.params.searchFrom);s.checkpoint.materialExpedition=true;await this.gatherWithReturn(item,quantity,s,home,searchFrom);}
        else await this.ensureItem(item, quantity, s);
        break;
      }
      case 'craft': await this.ensureItem(item, quantity, s); break;
      case 'smelt': await this.smelt(item, quantity, s); break;
      case 'store': case 'take': {
        const container = ContainerRefSchema.parse(task.params.destination ?? s.rules.warehouse);
        await this.transfer(container, item, task.kind==='store'&&task.params.allHarvest===true?this.count(item):typeof task.params.quantity === 'number' ? task.params.quantity : quantity, task.kind, s); break;
      }
      case 'build': case 'farm': case 'breed': {
        if (!this.options.villageTask) throw new ConditionWait('마을 작업 실행기를 연결해야 합니다.');
        if(task.kind==='build'&&task.completion.kind==='blocks'&&task.completion.blocks.length){
          const blocks=task.completion.blocks,min={x:Math.min(...blocks.map(b=>b.position.x)),y:Math.min(...blocks.map(b=>b.position.y)),z:Math.min(...blocks.map(b=>b.position.z))};
          // Recreate protection from the current task before resuming its saved
          // material trip; terrain approval from a previous task is not needed.
          s.checkpoint.buildProtection={origin:min,width:Math.max(...blocks.map(b=>b.position.x))-min.x+1,depth:Math.max(...blocks.map(b=>b.position.z))-min.z+1,height:Math.max(...blocks.map(b=>b.position.y))-min.y};
        }
        if (task.kind==='build' && (task.params.materialExpedition===true||task.source==='user'&&task.params.materialExpedition!==false) && !['prepare-site','prepare-access','material-access','register-warehouse'].includes(String(task.params.mode)) && this.options.config.allowedActions.includes('explore')) {
          s.checkpoint.materialExpedition=true; s.checkpoint.resourceExpedition=true;
          s.checkpoint.observedEnvironment={timeOfDay:this.bot.time?.timeOfDay??null,isDay:this.bot.time?.isDay??null,observedAt:Date.now()};
          // A resumed material expedition may be hundreds of blocks from the
          // entrance. Finish that saved trip before the building asks to approach.
          const pending=resourceTrip(s.checkpoint);
          if(pending&&pending.item==='cobblestone'&&pending.minimum>8&&s.checkpoint.buildStage==='foundation'&&task.completion.kind==='blocks'&&['cabin','house','warehouse'].includes(buildTemplate(task)??'')){
            s.checkpoint.foundationBatchAdjustment={from:pending.minimum,to:8,observedAt:Date.now()};pending.minimum=8;s.checkpoint.resourceTrip=pending as unknown as typeof s.checkpoint;
          }
          if(pending&&pending.phase!=='complete'){
            if(typeof s.checkpoint.confirmedRecoveryDeathId==='string'&&pending.deathId!==s.checkpoint.confirmedRecoveryDeathId)await returnFromResourceTrip(s);
            else if(pending.phase==='outbound'&&!pending.failure&&!deferBuildWindows(task,s,pending.item))await this.gatherWithReturn(pending.item,pending.minimum,s,pending.home);
            else await returnFromResourceTrip(s);
          }
        }
        if(task.kind==='farm'){
          const baseFarm=s.rules.baseAutonomy,harvesting=task.params.mode==='harvest'||task.completion.kind==='farm'&&task.completion.mode==='harvest';
          if(harvesting&&baseFarm&&task.params.id===baseFarm.id&&s.rules.warehouse&&this.options.config.allowedActions.includes('take')){
            const crops=baseFarm.positions.map(p=>this.bot.blockAt(vector(p).offset(0,1,0))),needed=crops.some(b=>!b)?crops.length:crops.filter(b=>b&&(['air','cave_air','void_air'].includes(b.name)||b.name==='wheat'&&Number(b.getProperties().age)>=7)).length;
            if(this.count('wheat_seeds')<needed)try{await this.transfer(s.rules.warehouse,'wheat_seeds',needed-this.count('wheat_seeds'),'take',s);}
            catch(error){s.check();if(!(error instanceof ConditionWait)||error.checkpoint.missingWarehouseItem!=='wheat_seeds')throw error;s.checkpoint.waitingFor={kind:'inventory',causeCode:'BUILD_MATERIAL',item:'wheat_seeds',minimum:needed,watchPosition:false,resourceNames:['short_grass','tall_grass']};throw new ConditionWait('실제 재파종 씨앗을 먼저 보충한 뒤 보존한 수확을 재개합니다.',s.checkpoint);}
            if(needed>0)await this.reuseWarehouseFarmHoe(s);
          }
          const prior=s.checkpoint.farmDryGround,priorPlots=s.checkpoint.farmPlotPositions,priorRepair=s.checkpoint.farmRepairBarePlots;s.checkpoint.farmDryGround=true;s.checkpoint.farmPlotPositions=Array.isArray(task.params.positions)?task.params.positions:[];s.checkpoint.farmRepairBarePlots=task.params.mode==='harvest'||task.completion.kind==='farm'&&task.completion.mode==='harvest';
          const previous=this.bot.pathfinder?.movements,farmland=this.bot.registry?.blocksByName?.farmland,scoped=!!farmland&&!!previous?.blocksToAvoid?.has(farmland.id)&&typeof this.bot.pathfinder.setMovements==='function';
          if(scoped){const movement=new Movements(this.bot);movement.canDig=false;movement.canOpenDoors=true;movement.allow1by1towers=false;movement.allowParkour=false;movement.maxDropDown=2;movement.infiniteLiquidDropdownDistance=false;movement.scafoldingBlocks=[];movement.blocksToAvoid=new Set([...movement.blocksToAvoid,...previous.blocksToAvoid]);movement.blocksToAvoid.delete(farmland.id);movement.exclusionAreasStep=[...previous.exclusionAreasStep];this.bot.pathfinder.setMovements(movement);}
          try{return await this.options.villageTask(task,s);}
          finally{if(scoped){this.bot.pathfinder.setGoal(null);this.bot.clearControlStates();this.bot.pathfinder.setMovements(previous);}if(prior===undefined)delete s.checkpoint.farmDryGround;else s.checkpoint.farmDryGround=prior;if(priorPlots===undefined)delete s.checkpoint.farmPlotPositions;else s.checkpoint.farmPlotPositions=priorPlots;if(priorRepair===undefined)delete s.checkpoint.farmRepairBarePlots;else s.checkpoint.farmRepairBarePlots=priorRepair;}
        }
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
        const p = PositionSchema.parse(task.params.position ?? s.rules.center);
        if(task.kind==='home'&&['inside','outside'].includes(String(task.params.basePassage))){
          const mode=task.params.basePassage==='inside'?'enter':'exit',base=s.rules.baseShelter,target=mode==='enter'?base?.inside:base?.outside;
          if(mode==='enter'&&base&&target&&vector(target).distanceTo(vector(p))<=.01&&this.bot.entity.position.distanceTo(vector(base.outside))>32)await approachKnownBase(s,base.outside);
          if(!target||vector(target).distanceTo(vector(p))>.01||!await restInWarehouse(s,()=>this.options.config.enabled,undefined,mode))throw new ConditionWait('등록한 창고와 실제 안전한 출입 경로를 확인해야 합니다.',s.checkpoint);
        }else await s.near(p, typeof task.params.radius === 'number' ? task.params.radius : 2);
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
