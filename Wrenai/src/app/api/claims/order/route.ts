import { start } from "workflow/api";
import { z } from "zod";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import {
  checkManualWalletReturn,
  confirmManualTrade,
  quoteManualTrade,
  recoverManualWalletReturns,
} from "@/server/manual-trading/service";
import { tradingPost } from "@/server/manual-trading/trading-action";
import { manualQuoteInputSchema } from "@/shared/manual-trading";
import { runManualTrade } from "@/workflows/manual-trading";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("quote"), input: z.unknown() }),
  z.strictObject({ step: z.literal("confirm"), input: z.unknown() }),
  z.strictObject({ step: z.literal("check"), input: z.unknown() }),
  z.strictObject({ step: z.literal("recover") }),
]);
const IN_FLIGHT = new Set(["reserved", "submitting", "submitted", "unknown"]);

/** Quote, confirm, check or recover private-balance claims. Only a portfolio wallet-return intent can be quoted. */
export async function POST(request: Request): Promise<Response> {
  return tradingPost(request, async (userId, _accountId, raw) => {
    const body = bodySchema.parse(raw);
    if (body.step === "recover") {
      return recoverManualWalletReturns(database(), userId);
    }
    if (body.step === "quote") {
      const input = manualQuoteInputSchema.parse(body.input);
      if (input.source !== "portfolio" || input.intent.kind !== "wallet_return") {
        throw new ExecutionError("conflict", "Claims quote only wallet returns.");
      }
      return quoteManualTrade(database(), userId, input);
    }
    if (body.step === "check") {
      const result = await checkManualWalletReturn(database(), userId, body.input);
      if (IN_FLIGHT.has(result.status)) {
        await start(runManualTrade, [userId, result.id]);
      }
      return result;
    }
    const result = await confirmManualTrade(database(), userId, body.input);
    if (IN_FLIGHT.has(result.status)) {
      await start(runManualTrade, [userId, result.id]);
    }
    return result;
  });
}
