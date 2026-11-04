import "server-only";
import type { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { type IntentToken, intentTokens } from "@/server/research/intents";
import { chatQuoteRequestSchema } from "@/shared/chat-quote";
import { DEFAULT_SPOT_FEE_BPS, type manualQuoteInputSchema } from "@/shared/manual-trading";

export function exactToken(tokens: readonly IntentToken[], hint: string): string {
  if (/^nep141:[a-z0-9._-]{2,64}$/.test(hint)) {
    return hint;
  }
  if (/^(?:w?near)$/i.test(hint)) {
    return "nep141:wrap.near";
  }
  const matches = tokens.filter(
    (t) =>
      t.assetId === hint ||
      (t.blockchain.toLowerCase() === "near" && t.symbol.toLowerCase() === hint.toLowerCase()),
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new ExecutionError(
      "not_ready",
      `Choose the exact ${hint.slice(0, 60)} token contract on the Spot page, then review the quote.`,
    );
  }
  return matches[0].assetId;
}

export async function resolveChatQuote(raw: unknown): Promise<z.infer<typeof manualQuoteInputSchema>> {
  const request = chatQuoteRequestSchema.parse(raw);
  const { tokens } = await intentTokens();
  return {
    requestId: request.requestId,
    source: "jarvis",
    intent: {
      kind: "spot",
      inputAssetId: exactToken(tokens, request.inputToken),
      outputAssetId: exactToken(tokens, request.outputToken),
      amount: request.amount,
      balance: "confidential",
      slippageBps: 50,
      maximumFeeBps: DEFAULT_SPOT_FEE_BPS,
    },
  };
}
