import type { Rules } from '../../contracts/src';

export const HOSTILES = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'blaze', 'ghast', 'creeper', 'witch', 'pillager', 'vindicator', 'ravager', 'cave_spider', 'silverfish', 'endermite']);
export const HUNTABLE = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit']);
export interface CombatAssessment { role: string; health: number; food: number; weapon: boolean; shield: boolean; enemies: number; allies: number; attacked: boolean; threateningVillage: boolean; targetName: string; distance: number; }
export interface CombatDecision { response: 'attack' | 'defend' | 'support' | 'retreat' | 'ignore'; reason: string; supportRequired: boolean; }

export function assessCombat(state: CombatAssessment, rules: Rules): CombatDecision {
  const proactive = rules.combat.proactiveRoles.includes(state.role) && state.threateningVillage;
  if (!proactive && !(state.attacked && rules.combat.counterattackWhenAttacked)) return { response: 'ignore', reason: '공격이나 보호 대상의 위협을 확인하지 못했습니다.', supportRequired: false };
  if (state.health <= rules.combat.retreatHealth) return { response: 'retreat', reason: '현재 체력으로 전투를 지속하기 어려워 지원을 요청하고 거리를 확보합니다.', supportRequired: true };
  if (state.targetName === 'creeper' && state.distance < 7) return { response: 'retreat', reason: '가까운 크리퍼의 폭발 범위에서 벗어납니다.', supportRequired: true };
  const outnumbered = state.enemies > (state.allies + 1) * rules.combat.enemyRatioLimit;
  if (outnumbered || !state.weapon && state.enemies > 1) return { response: state.shield ? 'support' : 'retreat', reason: '적의 수와 장비가 불리해 지원을 요청합니다.', supportRequired: true };
  if (state.health <= rules.combat.supportHealth) return { response: state.shield ? 'defend' : 'attack', reason: '반격과 방어를 유지하며 동료 지원을 요청합니다.', supportRequired: true };
  return { response: 'attack', reason: state.attacked ? '피격한 봇이 확인된 적에게 반격합니다.' : '마을이나 동료를 위협하는 적에게 선제 대응합니다.', supportRequired: false };
}
