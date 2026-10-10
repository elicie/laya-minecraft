import type { Rules } from '../../contracts/src';
import type { Bot } from 'mineflayer';

export const HOSTILES = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'blaze', 'ghast', 'creeper', 'witch', 'pillager', 'vindicator', 'ravager', 'cave_spider', 'silverfish', 'endermite']);
export const HUNTABLE = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit']);
const ranged = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast']);
export function rangedThreat(name: string): boolean { return ranged.has(name); }
export interface CombatEquipment { weapon: boolean; shield: boolean; armorPoints: number; }
export function combatEquipment(bot: Bot): CombatEquipment {
  const armor: Record<string, number[]> = { leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3] };
  const slots = bot.inventory.slots ?? [];
  let armorPoints = 0;
  for (let index = 0; index < 4; index++) {
    const name = slots[5 + index]?.name ?? '', part = ['helmet', 'chestplate', 'leggings', 'boots'][index];
    if (name === 'turtle_helmet' && index === 0) armorPoints += 2;
    else if (name.endsWith(`_${part}`)) armorPoints += armor[name.split('_')[0]]?.[index] ?? 0;
  }
  return { weapon: bot.inventory.items().some(item => item.count > 0 && /_(sword|axe)$/.test(item.name)), shield: slots[45]?.name === 'shield' && slots[45]!.count > 0, armorPoints };
}
export interface CombatAssessment { role: string; health: number; food: number; weapon: boolean; shield: boolean; armorPoints?: number; rangedEnemies?: number; enemies: number; allies: number; attacked: boolean; threateningVillage: boolean; targetName: string; distance: number; }
export interface CombatDecision { response: 'attack' | 'defend' | 'support' | 'retreat' | 'ignore'; reason: string; supportRequired: boolean; }

export function assessCombat(state: CombatAssessment, rules: Rules): CombatDecision {
  const proactive = rules.combat.proactiveRoles.includes(state.role) && state.threateningVillage;
  if (!proactive && !(state.attacked && rules.combat.counterattackWhenAttacked)) return { response: 'ignore', reason: '공격이나 보호 대상의 위협을 확인하지 못했습니다.', supportRequired: false };
  if (state.health <= rules.combat.retreatHealth) return { response: 'retreat', reason: '현재 체력으로 전투를 지속하기 어려워 지원을 요청하고 거리를 확보합니다.', supportRequired: true };
  if (state.targetName === 'creeper' && state.distance < 7) return { response: 'retreat', reason: '가까운 크리퍼의 폭발 범위에서 벗어납니다.', supportRequired: true };
  const outnumbered = state.enemies > (state.allies + 1) * rules.combat.enemyRatioLimit;
  if (outnumbered || !state.weapon && state.enemies > 1) return { response: state.shield ? 'support' : 'retreat', reason: '적의 수와 장비가 불리해 지원을 요청합니다.', supportRequired: true };
  const exposedToRanged = rangedThreat(state.targetName) || (state.rangedEnemies ?? 0) > 0;
  const rangedProtection = state.weapon && (state.shield || (state.armorPoints ?? 0) >= 12 || state.allies >= Math.max(1, state.enemies));
  if (exposedToRanged && (!rangedProtection || state.health <= rules.combat.supportHealth || state.food <= 6)) return { response: state.shield ? 'support' : 'retreat', reason: '원거리 적에게 접근할 장비나 회복 상태가 부족해 엄폐와 지원을 확보합니다.', supportRequired: true };
  if (state.food <= 6) return { response: 'retreat', reason: '허기가 심해 지속 전투보다 식량 확보와 회복을 우선합니다.', supportRequired: true };
  if (state.health <= rules.combat.supportHealth) return { response: state.shield ? 'defend' : 'attack', reason: '반격과 방어를 유지하며 동료 지원을 요청합니다.', supportRequired: true };
  return { response: 'attack', reason: state.attacked ? '피격한 봇이 확인된 적에게 반격합니다.' : '마을이나 동료를 위협하는 적에게 선제 대응합니다.', supportRequired: false };
}
