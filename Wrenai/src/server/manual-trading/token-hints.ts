import "server-only";
import type { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { intentTokens } from "@/server/research/intents";
import { chatQuoteRequestSchema } from "@/shared/chat-quote";
import { DEFAULT_SPOT_FEE_BPS, type manualQuoteInputSchema } from "@/shared/manual-trading";
import { exactToken, NATIVE_NEAR, NATIVE_NEAR_OUTPUT_UNAVAILABLE } from "./token-identity";

export async function resolveChatQuote(raw: unknown): Promise<z.infer<typeof manualQuoteInputSchema>> {
  const request = chatQuoteRequestSchema.parse(raw);
  const { tokens } = await intentTokens();
  const inputAssetId = exactToken(tokens, request.inputToken);
  const outputAssetId = exactToken(tokens, request.outputToken);
  if (outputAssetId === NATIVE_NEAR) {
    throw new ExecutionError("not_ready", NATIVE_NEAR_OUTPUT_UNAVAILABLE);
  }
  if (inputAssetId === NATIVE_NEAR) {
    throw new ExecutionError("not_ready", "Native NEAR must be paid from the connected wallet.");
  }
  return {
    requestId: request.requestId,
    source: "jarvis",
    intent: {
      kind: "spot",
      inputAssetId,
      outputAssetId,
      amount: request.amount,
      balance: "confidential",
      slippageBps: 50,
      maximumFeeBps: DEFAULT_SPOT_FEE_BPS,
    },
  };
}
