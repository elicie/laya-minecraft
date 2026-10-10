import { z } from 'zod';

export const BLUEPRINT_TEMPLATES = ['cabin', 'house', 'warehouse', 'tower', 'bridge', 'castle'] as const;
export const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped'] as const;
export const BUILD_MATERIALS = ['cobblestone', 'stone', 'stone_bricks', 'bricks', 'andesite', 'diorite', 'granite', 'polished_andesite', 'polished_diorite', 'polished_granite', 'cobbled_deepslate', 'deepslate_bricks', 'terracotta', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks'] as const;
export const WINDOW_MATERIALS = ['glass_pane', 'glass', 'tinted_glass'] as const;
const shape = z.object({
  title: z.string().trim().min(1).max(100), template: z.enum(BLUEPRINT_TEMPLATES),
  width: z.number().int().min(3).max(31), depth: z.number().int().min(3).max(31), height: z.number().int().min(1).max(16), wood: z.enum(WOOD_TYPES),
  materials: z.object({ floor: z.enum(BUILD_MATERIALS), wall: z.enum(BUILD_MATERIALS), roof: z.enum(BUILD_MATERIALS), window: z.enum(WINDOW_MATERIALS) }).strict(),
  furniture: z.object({ chest: z.boolean(), craftingTable: z.boolean(), furnace: z.boolean(), bed: z.boolean(), lighting: z.boolean() }).strict(),
}).strict();
type CatalogShape = z.infer<typeof shape>;
function validateSize(input: CatalogShape, ctx: z.RefinementCtx): void {
  if (input.template === 'castle' && (input.width !== 15 || input.depth !== 15 || input.height !== 8)) ctx.addIssue({ code: 'custom', path: ['width'], message: '성곽은 현재 15×15×8 크기를 사용합니다.' });
  if (input.template === 'bridge') {
    if (input.width % 2 === 0 || input.height !== 1) ctx.addIssue({ code: 'custom', path: ['width'], message: '다리는 홀수 폭과 높이 1을 사용합니다.' });
    if (Object.values(input.furniture).some(Boolean)) ctx.addIssue({ code: 'custom', path: ['furniture'], message: '다리에는 실내 가구를 배치할 수 없습니다.' });
  } else if (input.width < 5 || input.depth < 5 || input.height < 3) ctx.addIssue({ code: 'custom', path: ['width'], message: '건물은 폭·깊이 5 이상, 높이 3 이상이어야 합니다.' });
  if (['cabin', 'house', 'warehouse'].includes(input.template) && input.height > 4) ctx.addIssue({ code: 'custom', path: ['height'], message: '집과 창고는 안전하게 내려올 수 있는 높이 3~4를 사용합니다.' });
  const inside = input.width * input.depth, outside = (input.width + 2) * (input.depth + 2);
  if (inside * (input.height + 2) + (outside - inside) * 3 + outside * 3 + 65 * 6 + 192 * 6 > 10000) ctx.addIssue({ code: 'custom', path: ['height'], message: '전체 부지와 접근로의 관측 한도를 넘습니다. 크기나 높이를 줄여 주세요.' });
}
export const BlueprintInputSchema = shape.superRefine(validateSize);
export type BlueprintInput = z.infer<typeof BlueprintInputSchema>;
export const BlueprintDefinitionSchema = shape.extend({ id: z.string().uuid(), version: z.number().int().positive(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative() }).strict().superRefine((input, ctx) => { validateSize(input, ctx); if (input.updatedAt < input.createdAt) ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: '수정 시각은 생성 시각 이후여야 합니다.' }); });
export type BlueprintDefinition = z.infer<typeof BlueprintDefinitionSchema>;
// Catalog updates replace the entire editable definition; versions are assigned centrally.
export const BlueprintPatchSchema = BlueprintInputSchema;
export function blueprintPreset(template: BlueprintInput['template']): BlueprintInput {
  const sizes = { cabin: [5, 5, 4], house: [7, 7, 4], warehouse: [7, 5, 4], tower: [5, 5, 7], bridge: [3, 9, 1], castle: [15, 15, 8] } as const;
  const titles = { cabin: '작은 나무집', house: '넓은 나무집', warehouse: '창고 건물', tower: '전망대', bridge: '짧은 다리', castle: '성곽과 네 개의 탑' };
  const [width, depth, height] = sizes[template], room = template !== 'bridge' && template !== 'tower';
  return { title: titles[template], template, width, depth, height, wood: 'oak', materials: { floor: template === 'bridge' ? 'oak_planks' : 'cobblestone', wall: template === 'castle' ? 'stone_bricks' : 'oak_planks', roof: template === 'castle' ? 'stone_bricks' : 'oak_planks', window: 'glass_pane' }, furniture: { chest: room, craftingTable: room, furnace: room && template !== 'warehouse', bed: room && template !== 'warehouse', lighting: room && template !== 'castle' } };
}
