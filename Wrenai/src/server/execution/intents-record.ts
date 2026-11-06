import { z } from "zod";
import { copyEvidenceSchema } from "@/server/research/explorer-contracts";
import { WALLET_SWAP_NATIVE_OUTPUT } from "@/shared/swap-assets";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import { generatedIntentSchema } from "./intents-payload";

const tokenAssetId = z
  .string()
  .max(180)
  .regex(/^nep141:[^\s:*]+$/);

export const swapSignalSchema = z
  .strictObject({
    requestId: z.uuid(),
    agentId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    scope: z.literal("native_near").optional(),
    inputAssetId: tokenAssetId,
    outputAssetId: z.union([tokenAssetId, z.literal(WALLET_SWAP_NATIVE_OUTPUT)]),
    inputUnits: positiveTokenUnitsSchema,
    referenceInputMicroUsd: positiveTokenUnitsSchema.optional(),
    purpose: z
      .enum(["trigger_entry", "trigger_exit", "copy_trade", "instruction_entry", "instruction_exit"])
      .optional(),
    instructionSlot: z.string().min(1).max(200).optional(),
    copyTrade: copyEvidenceSchema.optional(),
    referenceOutputPriceMicroUsd: positiveTokenUnitsSchema.optional(),
    outputDecimals: z.number().int().min(0).max(36).optional(),
  })
  .refine((signal) => signal.outputAssetId !== WALLET_SWAP_NATIVE_OUTPUT || signal.scope === "native_near", {
    message: "Native NEAR payouts require the public native route.",
  });
export const preparedOrderSchema = z.strictObject({
  format: z.literal(1),
  signalHash: z.string().regex(/^[a-f0-9]{64}$/),
  signal: swapSignalSchema.optional(),
  quotedAt: z.number().int().nonnegative(),
  maximumProviderFeeBps: z.number().int().min(0).max(2000),
  requestDeadline: z.iso.datetime(),
  providerDeadline: z.iso.datetime(),
  providerQuote: z.unknown(),
  generated: generatedIntentSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  depositAddress: z.string().regex(/^[a-f0-9]{64}$/),
});
