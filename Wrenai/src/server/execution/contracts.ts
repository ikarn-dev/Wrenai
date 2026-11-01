import { z } from "zod";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "@/shared/token-units";

export const scopeSchema = z.enum(["intents", "confidential", "native_near", "hyperliquid"]);
export type ExecutionScope = z.infer<typeof scopeSchema>;
const amount = tokenUnitsSchema;
const positiveAmount = positiveTokenUnitsSchema;
const assetId = z.string().trim().min(1).max(256);
const reference = z.string().trim().min(1).max(256);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const executionPlanSchema = z
  .strictObject({
    requestId: z.uuid(),
    agentId: z.uuid(),
    agentRevision: z.number().int().positive(),
    strategyVersion: z.number().int().positive(),
    riskPolicyRevision: z.number().int().positive(),
    scope: scopeSchema,
    inputAssetId: assetId,
    outputAssetId: assetId,
    inputUnits: positiveAmount,
    minOutputUnits: positiveAmount,
    // Worst-case USD debit including excluded costs. Provider quote validation is an Executor responsibility.
    notionalMicroUsd: positiveAmount,
    slippageBps: z.number().int().min(0).max(500),
    providerFeeBps: z.number().int().min(0).max(2000).optional(),
    quoteId: reference,
    quoteHash: hashSchema,
    expiresAt: timestamp,
  })
  .refine((plan) => plan.inputAssetId !== plan.outputAssetId, "A swap requires different assets.");
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

export const inventoryObservationSchema = z
  .strictObject({
    scope: scopeSchema,
    syncToken: z.uuid(),
    balances: z.array(z.strictObject({ assetId, amountUnits: amount })).max(500),
  })
  .refine(
    (observation) =>
      new Set(observation.balances.map((balance) => balance.assetId)).size === observation.balances.length,
    "The inventory observation contains duplicate assets.",
  );

export const fillReceiptSchema = z.strictObject({
  providerEventId: reference,
  inputUnits: positiveAmount,
  outputUnits: positiveAmount,
  inputValueMicroUsd: positiveAmount,
  // Optional verified net output valuation. Missing means performance accounting remains unpriced.
  outputValueMicroUsd: amount.optional(),
  // Included cost metadata only. Null means the adapter cannot independently itemize fees.
  feeMicroUsd: amount.nullable(),
  // Provider clock metadata only. Risk windows use the database's recordedAt to prevent backdating.
  occurredAt: timestamp,
});

export const settlementSchema = z.strictObject({
  providerReceiptId: reference,
  refundedInputUnits: amount,
});

export class ExecutionError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "not_ready" | "insufficient_funds" | "limit" | "lease_lost",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}
