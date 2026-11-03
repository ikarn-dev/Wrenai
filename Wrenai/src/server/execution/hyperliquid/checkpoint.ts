import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { tokenUnitsSchema } from "@/shared/token-units";
import { hlOrderSchema } from "./contracts";

export const perpsCheckpointSchema = z.strictObject({
  entryActionId: z.uuid(),
  time: z.number().int().nonnegative().safe(),
  cash: tokenUnitsSchema,
  quantity: tokenUnitsSchema,
  collateral: tokenUnitsSchema,
  collateralPrincipal: tokenUnitsSchema,
  sequence: z.number().int().min(0).max(10000000),
  watermark: z.string(),
  stop: z.string(),
  orders: z
    .array(z.strictObject({ oid: z.number().int().nonnegative().safe(), wire: hlOrderSchema }))
    .max(20),
});
export type PerpsCheckpoint = z.infer<typeof perpsCheckpointSchema>;
export async function readPerpsCheckpoint(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<PerpsCheckpoint | null> {
  const [row] = await db
    .select({ detail: executionEvents.detailJson })
    .from(executionEvents)
    .innerJoin(executionActions, eq(executionActions.id, executionEvents.actionId))
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        eq(executionEvents.kind, "hl_checkpoint"),
      ),
    )
    .orderBy(desc(executionEvents.createdAt), desc(executionEvents.id))
    .limit(1);
  return row ? perpsCheckpointSchema.parse(JSON.parse(row.detail)) : null;
}
