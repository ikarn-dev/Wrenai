import { z } from "zod";
import { statusSchema } from "./agents";

export const agentRuntimeStatusSchema = z.strictObject({
  agent: z.strictObject({
    id: z.string(),
    status: statusSchema,
    reason: z.string(),
    revision: z.number().int(),
    updatedAt: z.number().int(),
  }),
  runtime: z
    .strictObject({
      state: z.enum(["starting", "active", "stopped", "blocked"]),
      nextCheckAt: z.number().int(),
    })
    .nullable(),
  pending: z
    .array(
      z.strictObject({
        id: z.string(),
        status: z.string(),
        startedAt: z.number().int().nullable(),
      }),
    )
    .max(10)
    .readonly(),
});
export type AgentRuntimeStatus = z.infer<typeof agentRuntimeStatusSchema>;
