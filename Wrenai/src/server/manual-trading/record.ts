import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { manualTrades } from "@/server/db/manual-schema";
import { ExecutionError, executionPlanSchema } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { hlOrderRecordSchema } from "@/server/execution/hyperliquid/order-record";
import { returnRecordSchema } from "@/server/execution/hyperliquid/return-record";
import { preparedOrderSchema } from "@/server/execution/intents-record";
import { fundingRecordSchema } from "@/server/execution/perps-funding-record";
import { executionHash } from "@/server/execution/records";
import { rheaPreparedSchema } from "@/server/execution/rhea/contracts";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { manualIntentSchema, manualPreviewSchema } from "@/shared/manual-trading";

export const manualEnvelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("perps_funding"),
    preview: manualPreviewSchema,
    plan: defiPlanSchema,
    prepared: fundingRecordSchema,
  }),
  z.strictObject({
    kind: z.literal("perps_return"),
    preview: manualPreviewSchema,
    plan: defiPlanSchema,
    prepared: returnRecordSchema,
  }),
  z.strictObject({
    kind: z.literal("rhea"),
    preview: manualPreviewSchema,
    plan: executionPlanSchema,
    prepared: rheaPreparedSchema,
  }),
  z.strictObject({
    kind: z.literal("intents"),
    preview: manualPreviewSchema,
    plan: executionPlanSchema,
    prepared: preparedOrderSchema,
  }),
  z.strictObject({
    kind: z.literal("perps"),
    preview: manualPreviewSchema,
    plan: defiPlanSchema,
    prepared: hlOrderRecordSchema,
    instruction: agentInstructionSchema,
  }),
]);
export type ManualEnvelope = z.infer<typeof manualEnvelopeSchema>;
export type ManualTrade = typeof manualTrades.$inferSelect;
export async function ownedManualTrade(db: AppDatabase, userId: string, id: string): Promise<ManualTrade> {
  const [row] = await db
    .select()
    .from(manualTrades)
    .where(and(eq(manualTrades.userId, userId), eq(manualTrades.id, id)))
    .limit(1);
  if (!row) {
    throw new ExecutionError("not_found", "This trade could not be found.");
  }
  return row;
}
export function manualEnvelope(row: ManualTrade): ManualEnvelope {
  const envelope = manualEnvelopeSchema.parse(JSON.parse(row.previewJson));
  const intent = manualIntentSchema.parse(JSON.parse(row.intentJson));
  const { bindingHash: _binding, ...bound } = envelope.preview;
  if (
    executionHash(intent) !== row.intentHash ||
    executionHash({ preview: bound, plan: envelope.plan, prepared: envelope.prepared }) !== row.bindingHash ||
    envelope.preview.bindingHash !== row.bindingHash ||
    envelope.plan.manualTradeId !== row.id ||
    envelope.plan.agentId !== row.subjectId ||
    envelope.plan.requestId !== row.requestId ||
    envelope.plan.budgetMode !== "manual" ||
    executionHash(envelope.preview.intent) !== row.intentHash
  ) {
    throw new ExecutionError("conflict", "The saved trade differs from its exact confirmation.");
  }
  return envelope;
}
