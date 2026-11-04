import { z } from "zod";
import { instructionAssetSchema } from "./agent-instructions";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "./token-units";
import { tradeAssetSchema } from "./trade-preview";

export const tradingDecimalSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,36})?$/)
  .refine((s) => /[1-9]/.test(s), "Enter a positive amount.");
/**
 * The default provider-fee cap for a Spot quote, in basis points. 1Click adds its own 20 bps app fee to every
 * NEAR Intents quote, even when the request lists no fees (observed Nov 4, 2026 with and without an API key).
 * The cap equals that fee, so ordinary quotes pass, and any higher or new fee still fails closed.
 */
export const DEFAULT_SPOT_FEE_BPS = 20;
const controls = {
  slippageBps: z.number().int().min(1).max(500),
  maximumFeeBps: z.number().int().min(0).max(2000),
};
export const manualSpotIntentSchema = z
  .strictObject({
    kind: z.literal("spot"),
    inputAssetId: instructionAssetSchema,
    outputAssetId: instructionAssetSchema,
    amount: tradingDecimalSchema,
    balance: z.enum(["confidential", "native_near"]),
    ...controls,
  })
  .refine((p) => p.inputAssetId !== p.outputAssetId, "Choose two different tokens.");
export const manualPerpsIntentSchema = z
  .strictObject({
    kind: z.literal("perps"),
    market: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9:_-]+$/),
    action: z.enum(["open", "reduce", "close"]),
    side: z.enum(["long", "short"]),
    quantity: tradingDecimalSchema,
    leverage: z.number().int().min(1).max(50),
    maximumMarginUsd: tradingDecimalSchema,
    stopLossPrice: tradingDecimalSchema.nullable(),
    takeProfitPrice: tradingDecimalSchema.nullable(),
    trailingStopBps: z.number().int().min(1).max(9999).nullable(),
    ...controls,
  })
  .refine(
    (p) => p.action !== "open" || p.stopLossPrice !== null,
    "Set a stop-loss before opening a position.",
  );
export const manualFundingIntentSchema = z.strictObject({
  kind: z.literal("perps_funding"),
  direction: z.enum(["deposit", "return"]),
  assetId: instructionAssetSchema,
  amount: tradingDecimalSchema,
  ...controls,
});
export type ManualFundingIntent = z.infer<typeof manualFundingIntentSchema>;
export const manualIntentSchema = z.discriminatedUnion("kind", [
  manualSpotIntentSchema,
  manualPerpsIntentSchema,
  manualFundingIntentSchema,
]);
export type ManualIntent = z.infer<typeof manualIntentSchema>;
export type ManualSpotIntent = z.infer<typeof manualSpotIntentSchema>;
export type ManualPerpsIntent = z.infer<typeof manualPerpsIntentSchema>;
export const manualQuoteInputSchema = z.strictObject({
  requestId: z.uuid(),
  source: z.enum(["jarvis", "spot", "perps"]),
  intent: manualIntentSchema,
});
export const manualConfirmationSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const manualPreviewSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  intent: manualIntentSchema,
  title: z.string().min(1).max(240),
  venue: z.enum(["NEAR Intents", "RHEA", "Hyperliquid"]),
  input: tradeAssetSchema.nullable(),
  output: tradeAssetSchema.nullable(),
  inputUnits: positiveTokenUnitsSchema,
  outputUnits: positiveTokenUnitsSchema.nullable(),
  minimumOutputUnits: positiveTokenUnitsSchema.nullable(),
  maximumDebit: z.string().min(1).max(140),
  limitPrice: z.string().max(100).nullable(),
  feeNote: z.string().max(400),
  visibility: z.enum(["confidential", "public"]),
  expiresAt: z.number().int().positive(),
  actionId: z.uuid().nullable(),
  status: z.enum([
    "quoted",
    "expired",
    "cancelled",
    "reserved",
    "submitting",
    "submitted",
    "unknown",
    "settled",
    "refunded",
    "no_fill",
  ]),
  execution: z
    .strictObject({
      spentUnits: tokenUnitsSchema,
      receivedUnits: tokenUnitsSchema,
      refundedUnits: tokenUnitsSchema,
    })
    .optional(),
});
export type ManualPreview = z.infer<typeof manualPreviewSchema>;
export const manualBalanceSchema = z.strictObject({
  assetId: z.string().max(256),
  units: tokenUnitsSchema,
  availableUnits: tokenUnitsSchema,
  scope: z.enum(["confidential", "native_near", "hyperliquid"]),
});
export type ManualBalance = z.infer<typeof manualBalanceSchema>;
export type TradingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };
