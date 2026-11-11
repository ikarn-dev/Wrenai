import { z } from "zod";
import { statusSchema } from "./agents";

export const agentRuntimeStatusSchema = z.strictObject({
  agent: z.strictObject({
    id: z.string(),
    status: statusSchema,
    reason: z.string(),
    revision: z.number().int(),
    updatedAt: z.number().int(),
    returningFunds: z.boolean(),
    /** When the owner claimed its funds, so the page can show how long the claim has run. */
    returningSince: z.number().int().nullable(),
    /** Deleted by the owner; it disappears once it holds nothing, and its funds wait in Claims. */
    deleting: z.boolean(),
    deleted: z.boolean(),
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
