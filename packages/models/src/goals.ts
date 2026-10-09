import minecraftData from 'minecraft-data';
import { GoalInputSchema, type GoalDefinition, type Interpretation, type Rules, type ActionKind } from '../../contracts/src';
import { BLUEPRINTS } from '../../contracts/src/blueprints';

export class GoalInterpretationError extends Error { readonly code = 'GOAL_UNSUPPORTED'; }
const aliases: [RegExp, string][] = [
  [/철\s*곡괭/, 'iron_pickaxe'], [/돌\s*곡괭/, 'stone_pickaxe'], [/나무\s*곡괭/, 'wooden_pickaxe'],
  [/철\s*(?:검|칼)/, 'iron_sword'], [/돌\s*(?:검|칼)/, 'stone_sword'], [/철\s*괴/, 'iron_ingot'], [/철\s*원석/, 'raw_iron'],
  [/조약돌/, 'cobblestone'], [/석탄/, 'coal'], [/판자/, 'oak_planks'], [/참나무\s*원목|원목|나무|목재/, 'oak_log'],
  [/빵/, 'bread'], [/밀\s*씨앗/, 'wheat_seeds'], [/밀/, 'wheat'], [/당근/, 'carrot'], [/감자/, 'potato'],
  [/모래/, 'sand'], [/흙/, 'dirt'], [/상자/, 'chest'], [/횃불/, 'torch'], [/방패/, 'shield'],
];

function knownGoal(text: string, rules: Rules): GoalDefinition | null {
  if (/(?:그리고|한\s*다음|모으고|캐고|만들고|수확하고|넣고|[;\n])/.test(text)) return null;
  const countMatch = text.match(/(?:총\s*|추가로?\s*)?(\d+)\s*(?:개|마리|블록)?/);
  const quantity = countMatch ? Number(countMatch[1]) : 1;
  const common = { quantity, quantityMode: /추가/.test(text) ? 'additional' as const : 'total' as const, mode: /유지|계속|지속|관리/.test(text) ? 'maintain' as const : 'once' as const, source: 'user' as const, title: text };
  let kind: ActionKind | undefined;
  const params: GoalDefinition['params'] = {};
  if (/따라/.test(text)) { kind = 'follow'; params.targetName = text.match(/([A-Za-z0-9_]{3,16})\s*(?:을|를)?\s*따라/)?.[1] ?? ''; }
  else if (/집으로|기지로|돌아가|귀환/.test(text)) { kind = 'home'; if (rules.center) params.position = { ...rules.center }; }
  else if (/자러|잠자|수면/.test(text)) kind = 'sleep';
  else if (/회수|죽.*아이템|사망.*물자/.test(text)) kind = 'recover';
  else if (/경비|순찰/.test(text)) { kind = 'guard'; if (rules.center) params.position = { ...rules.center }; }
  else if (/살아남|생존/.test(text)) kind = 'survive';
  else if (/번식/.test(text)) { kind = 'breed'; params.animal = /양/.test(text) ? 'sheep' : /돼지/.test(text) ? 'pig' : /닭/.test(text) ? 'chicken' : 'cow'; }
  else if (/탐험|탐색/.test(text)) kind = 'explore';
  else if (/사냥/.test(text)) { kind = 'hunt'; params.targetName = /돼지/.test(text) ? 'pig' : /닭/.test(text) ? 'chicken' : /양/.test(text) ? 'sheep' : 'cow'; }
  else if (/좀비|해골|적.*처치|전투|싸워/.test(text)) { kind = 'fight'; params.targetName = /해골/.test(text) ? 'skeleton' : 'zombie'; }
  else if (/밭|농사|재배|수확/.test(text)) { kind = 'farm'; params.crop = /당근/.test(text) ? 'carrot' : /감자/.test(text) ? 'potato' : /비트/.test(text) ? 'beetroot' : 'wheat'; params.mode = /수확/.test(text) ? 'harvest' : 'setup'; params.plots = 8; }
  else if (/(?:집|건물|창고|탑|다리|성)\s*.*(?:지어|짓|건설)/.test(text)) {
    kind = 'build'; params.design = /성/.test(text) ? 'castle' : /창고/.test(text) ? 'warehouse' : /탑/.test(text) ? 'tower' : /다리/.test(text) ? 'bridge' : /넓은/.test(text) ? 'house' : 'cabin';
  }
  const item = aliases.find(([pattern]) => pattern.test(text))?.[1] ?? text.match(/\b[a-z]+(?:_[a-z]+)+\b/)?.[0];
  if (!kind && item) kind = /꺼내|가져와|출고/.test(text) ? 'take' : /넣어|입고|보관/.test(text) ? 'store' : /제련|구워|녹여/.test(text) ? 'smelt' : /제작|만들/.test(text) ? 'craft' : /모아|수집|구해|확보|유지|캐/.test(text) ? 'collect' : undefined;
  if (!kind) return null;
  return GoalInputSchema.parse({ ...common, kind, ...(kind === 'guard' || kind === 'follow' || kind === 'survive' ? { mode: 'maintain' } : {}), params, ...(['collect', 'store', 'take', 'craft', 'smelt'].includes(kind) && item ? { item } : {}) });
}

export function createGoalInterpreter(options: { url?: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch; version?: string } = {}) {
  const registry = minecraftData(options.version ?? '1.21.1');
  function validate(goal: GoalDefinition): GoalDefinition {
    if (goal.item && !registry.itemsByName[goal.item]) throw new GoalInterpretationError(`지원하는 Minecraft 아이템이 아닙니다: ${goal.item}`);
    if (goal.kind === 'build' && (typeof goal.params.design !== 'string' || !(goal.params.design in BLUEPRINTS))) throw new GoalInterpretationError('지원하는 건축 설계도를 선택해 주세요.');
    return goal;
  }
  return async (text: string, rules: Rules): Promise<Interpretation> => {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new GoalInterpretationError('목표를 1~4000자로 입력해 주세요.');
    let known: GoalDefinition | null;
    try { known = knownGoal(text.trim(), rules); }
    catch { throw new GoalInterpretationError('수량과 목표 기준을 확인해 주세요. 유지 목표는 총 수량을 지정해야 합니다.'); }
    if (known) return { goal: validate(known), source: 'code', warnings: known.kind === 'follow' && !known.params.targetName ? ['따라갈 Minecraft 사용자 이름을 지정해 주세요.'] : [] };
    try {
      const response = await (options.fetchImpl ?? fetch)(`${(options.url ?? process.env.QWEN_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
        body: JSON.stringify({ model: options.model ?? process.env.QWEN_MODEL ?? 'qwen3.5:9b', stream: false, think: false, format: 'json', options: { temperature: 0, num_predict: 600 }, messages: [
          { role: 'system', content: 'Convert ONE Minecraft goal to JSON {kind,item?,quantity,quantityMode:"total"|"additional",mode:"once"|"maintain",params:{},title}. Allowed kinds: collect,store,take,craft,smelt,build,farm,hunt,fight,guard,explore,follow,home,sleep,recover,survive,breed. collect completion means delivery to shared warehouse. Quantity means total unless additional explicitly requested; maintain means fixed stock. build params.design must be cabin,house,warehouse,tower,bridge,castle. Minecraft Java 1.21.1 item registry names. Do not invent capabilities or replace unsupported outcomes. For unsupported or multiple goals return {unsupported:true}. JSON only.' },
          { role: 'user', content: text },
        ] }),
      });
      if (!response.ok) throw new GoalInterpretationError(`목표 해석 모델 응답 실패 (${response.status}). 작업 종류와 수량을 직접 지정할 수 있습니다.`);
      const result = await response.json() as { message?: { content?: string } };
      const value: unknown = JSON.parse(result.message?.content ?? 'null');
      if (value && typeof value === 'object' && 'unsupported' in value) throw new GoalInterpretationError('지원하는 작업을 하나씩 등록해 주세요.');
      return { goal: validate(GoalInputSchema.parse(value)), source: 'qwen', warnings: [] };
    } catch (error) {
      if (error instanceof GoalInterpretationError) throw error;
      throw new GoalInterpretationError('목표를 해석하지 못했습니다. 작업 종류·수량·목적지를 직접 지정해 주세요.');
    }
  };
}
