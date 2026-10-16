import { z } from "zod";
const count = z.number().int().nonnegative().nullable();
export const OperationsSchema = z.object({
  observedAt: z.number(),
  stock: z.object({
    observedAt: z.number().nullable(),
    stale: z.boolean(),
    bread: count,
    wheat: count,
    seeds: count,
    wood: count,
    breadTarget: z.number(),
    seedTarget: z.number(),
  }),
  farm: z.object({
    id: z.string().nullable(),
    planned: z.number(),
    planted: count,
    watered: count,
    ripe: count,
    observedAt: z.number().nullable(),
    stale: z.boolean(),
  }),
  bots: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      action: z.string(),
      reason: z.string(),
      health: z.number().nullable(),
      food: z.number().nullable(),
      stale: z.boolean(),
    }),
  ),
  decisions: z.array(
    z.object({
      time: z.number(),
      botId: z.string().optional(),
      source: z.string(),
      action: z.string().nullable().default(null),
      taskKind: z.string().nullable().default(null),
      model: z.string().optional(),
      confidence: z.number().optional(),
      reason: z.string(),
    }),
  ),
  model: z.object({
    status: z.enum(["ready", "unavailable", "unconfigured"]),
    name: z.string().optional(),
    profile: z.string().optional(),
    checkedAt: z.number(),
  }),
  training: z.array(
    z.object({
      id: z.string(),
      state: z.enum(["training", "evaluating", "qualified", "rejected"]),
      step: z.number(),
      totalSteps: z.number().nullable(),
      trainRows: count,
      correct: count,
      total: count,
      illegal: count,
      broadApproved: z.boolean().nullable(),
      normalizedApproved: z.boolean().nullable().default(null),
      profile: z.string().nullable(),
      note: z.string(),
    }),
  ),
});
export type Operations = z.infer<typeof OperationsSchema>;
