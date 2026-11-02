import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { z } from "zod";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import type { TradeQuote } from "@/shared/trade-preview";
import { ExecutionError } from "./contracts";
import {
  type GeneratedIntent,
  generatedIntentSchema,
  MAX_PROVIDER_INTENT_VALIDITY_MS,
  validateGeneratedIntent,
} from "./intents-payload";
import { dryQuoteRequest, oneClickJson, verifiedProviderQuote } from "./oneclick-quote";

export const intentsOrderRequestSchema = z.strictObject({
  accountId: z.string().min(2).max(64),
  inputAssetId: z
    .string()
    .max(180)
    .regex(/^nep141:[^\s:*]+$/),
  outputAssetId: z
    .string()
    .max(180)
    .regex(/^nep141:[^\s:*]+$/),
  inputUnits: positiveTokenUnitsSchema,
  slippageBps: z.number().int().min(1).max(500),
  maximumProviderFeeBps: z.number().int().min(0).max(2000),
  paymentRecipient: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
    .optional(),
});
const depositSchema = z.object({
  quote: z.object({
    depositAddress: z.string().regex(/^[a-f0-9]{64}$/),
    depositMemo: z.never().optional(),
    deadline: z.iso.datetime(),
  }),
});
export interface PreparedIntentsOrder {
  readonly quote: TradeQuote;
  readonly providerQuote: unknown;
  readonly depositAddress: string;
  readonly generated: GeneratedIntent;
  readonly payloadHash: string;
}

/** Creates an unfunded provider quote and unsigned payload. The Signer must independently recheck authorization and Guard limits. */
export async function prepareIntentsOrder(
  raw: unknown,
  signal?: AbortSignal,
  sessionToken?: string,
): Promise<PreparedIntentsOrder> {
  const input = intentsOrderRequestSchema.parse(raw);
  if (
    input.paymentRecipient
      ? input.inputAssetId !== input.outputAssetId || input.paymentRecipient === input.accountId
      : input.inputAssetId === input.outputAssetId
  ) {
    throw new ExecutionError("not_ready", "A swap requires different reviewed assets.");
  }
  const request = {
    ...dryQuoteRequest(
      input.accountId,
      input.inputAssetId,
      input.outputAssetId,
      input.inputUnits,
      Math.max(0, input.slippageBps - 1),
      "confidential",
      Date.now(),
    ),
    dry: false,
    ...(input.paymentRecipient
      ? { recipient: input.paymentRecipient, swapType: QuoteRequest.swapType.EXACT_OUTPUT }
      : {}),
  };
  const providerQuote = await oneClickJson("/v0/quote", request, signal, sessionToken);
  const quote = verifiedProviderQuote(providerQuote, request, "confidential", Date.now(), input.slippageBps);
  const deposit = depositSchema.parse(providerQuote).quote;
  if (quote.appFeeBps > input.maximumProviderFeeBps) {
    throw new ExecutionError("limit", "The quoted provider fee exceeds your reviewed fee allowance.");
  }
  const generated = generatedIntentSchema.parse(
    await oneClickJson(
      "/v0/generate-intent",
      {
        type: "swap_transfer",
        standard: "nep413",
        signerId: input.accountId,
        depositAddress: deposit.depositAddress,
      },
      signal,
      undefined,
    ),
  );
  const validated = validateGeneratedIntent(generated, {
    signerId: input.accountId,
    scope: "confidential",
    depositAddress: deposit.depositAddress,
    inputAssetId: input.inputAssetId,
    inputUnits: quote.inputUnits,
    providerDeadline: deposit.deadline,
    maximumValidityMs: MAX_PROVIDER_INTENT_VALIDITY_MS,
    now: Date.now(),
  });
  if (quote.expiresAt <= Date.now()) {
    throw new ExecutionError("not_ready", "The quote expired before its signing payload was ready.");
  }
  return {
    quote,
    providerQuote,
    depositAddress: deposit.depositAddress,
    generated: validated.intent,
    payloadHash: validated.payloadHash,
  };
}
