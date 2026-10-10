import { z } from 'zod';

const plainText = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Plain display text is required');
export const InventorySlotItemSchema = z.object({
  name: z.string().regex(/^[a-z0-9_.:-]{1,100}$/), count: z.number().int().min(1).max(1000000),
  displayName: plainText.optional(), customName: plainText.optional(), maxStackSize: z.number().int().min(1).max(99).optional(),
  durability: z.object({ remaining: z.number().int().nonnegative(), maximum: z.number().int().min(1).max(1000000) }).strict().refine(value => value.remaining <= value.maximum, 'Remaining durability cannot exceed the maximum').optional(),
  enchants: z.array(z.object({ name: z.string().regex(/^[a-z0-9_.:-]{1,100}$/), level: z.number().int().min(1).max(255) }).strict()).max(32).optional(),
}).strict();
export type InventorySlotItem = z.infer<typeof InventorySlotItemSchema>;
// Java window-0 indices: crafting 0..4, armor 5..8, main 9..35,
// hotbar 36..44, offhand 45. Missing view means unknown, never empty.
export const InventoryViewSchema = z.object({ slots: z.array(InventorySlotItemSchema.nullable()).length(46), selectedHotbarSlot: z.number().int().min(0).max(8).optional(), cursor: InventorySlotItemSchema.nullable().optional() }).strict();
export type InventoryView = z.infer<typeof InventoryViewSchema>;
