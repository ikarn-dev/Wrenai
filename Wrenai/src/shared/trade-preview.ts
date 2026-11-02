import { z } from "zod";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "./token-units";

export const tradeAssetSchema = z.strictObject({
  symbol: z.string().trim().min(1).max(180),
  assetId: z.string().min(3).max(256),
  tokenSymbol: z.string().min(1).max(80),
  blockchain: z.string().min(1).max(40),
  contractAddress: z.string().max(200).nullable(),
  decimals: z.number().int().min(0).max(36),
});
export type TradeAsset = z.infer<typeof tradeAssetSchema>;

export const agentAssetInputSchema = z.strictObject({
  agentId: z.uuid(),
  expectedRevision: z.number().int().positive(),
});
export const reviewAgentAssetsSchema = agentAssetInputSchema.extend({
  requestId: z.uuid(),
  assets: z
    .array(tradeAssetSchema.pick({ symbol: true, assetId: true }))
    .min(1)
    .max(6),
});
export const tradePreviewInputSchema = agentAssetInputSchema
  .extend({
    requestId: z.uuid(),
    inputAssetId: z.string().min(3).max(256),
    outputAssetId: z.string().min(3).max(256),
    inputUnits: positiveTokenUnitsSchema,
    slippageBps: z.number().int().min(1).max(500),
    purpose: z.enum(["trade", "funding"]).optional(),
  })
  .refine((input) => input.inputAssetId !== input.outputAssetId, "Choose different input and output assets.");
export type TradePreviewInput = z.infer<typeof tradePreviewInputSchema>;

export const tradeBalanceSchema = z.strictObject({
  scope: z.enum(["intents", "confidential"]),
  status: z.enum(["verified", "unavailable"]),
  observedAt: z.number().int().positive(),
  blockHeight: z.number().int().positive().nullable(),
  balances: z.array(z.strictObject({ assetId: z.string(), units: tokenUnitsSchema })).max(6),
  note: z.string().max(400),
});
export type TradeBalance = z.infer<typeof tradeBalanceSchema>;

export const tradeQuoteSchema = z.strictObject({
  provider: z.literal("oneclick"),
  scope: z.enum(["intents", "confidential"]),
  inputAssetId: z.string(),
  outputAssetId: z.string(),
  inputUnits: positiveTokenUnitsSchema,
  outputUnits: positiveTokenUnitsSchema,
  minOutputUnits: positiveTokenUnitsSchema,
  inputMicroUsd: positiveTokenUnitsSchema.nullable(),
  outputMicroUsd: tokenUnitsSchema.nullable(),
  slippageBps: z.number().int().min(1).max(500),
  appFeeBps: z.number().int().min(0).max(2000),
  capturedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
  recipient: z.string().min(2).max(64),
  refundTo: z.string().min(2).max(64),
  feeNote: z.string().max(400),
});
export type TradeQuote = z.infer<typeof tradeQuoteSchema>;

export const tradePreviewSchema = z.strictObject({
  id: z.uuid(),
  agentId: z.uuid(),
  agentRevision: z.number().int().positive(),
  strategyVersion: z.number().int().positive(),
  riskPolicyRevision: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  input: tradeAssetSchema,
  output: tradeAssetSchema,
  quote: tradeQuoteSchema.nullable(),
  balance: tradeBalanceSchema,
  decision: z.enum(["allowed", "blocked", "approval_required"]),
  checks: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(80),
        status: z.enum(["passed", "blocked", "approval_required"]),
        reason: z.string().max(400),
      }),
    )
    .min(1)
    .max(20),
  executionEnabled: z.literal(false),
  purpose: z.enum(["trade", "funding"]).optional(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TradePreview = z.infer<typeof tradePreviewSchema>;

export interface AgentTradeAssets {
  readonly agentId: string;
  readonly revision: number;
  readonly strategyVersion: number;
  readonly choices: readonly {
    readonly symbol: string;
    readonly candidates: readonly TradeAsset[];
  }[];
  readonly reviewed: readonly TradeAsset[];
  readonly fundingReference?: TradeAsset;
}
