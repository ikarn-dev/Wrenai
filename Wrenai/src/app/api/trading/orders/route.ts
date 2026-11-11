import { start } from "workflow/api";
import { z } from "zod";
import { database } from "@/server/db/client";
import { confirmManualTrade, dismissManualTrade, quoteManualTrade } from "@/server/manual-trading/service";
import { resolveChatQuote } from "@/server/manual-trading/token-hints";
import { tradingPost } from "@/server/manual-trading/trading-action";
import { runManualTrade } from "@/workflows/manual-trading";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("quote"), input: z.unknown() }),
  z.strictObject({ step: z.literal("chat_quote"), input: z.unknown() }),
  z.strictObject({ step: z.literal("confirm"), input: z.unknown() }),
  z.strictObject({ step: z.literal("dismiss"), input: z.unknown() }),
]);
const IN_FLIGHT = new Set(["reserved", "submitting", "submitted", "unknown"]);

/**
 * Manual order mutations (Spot, Perps and Jarvis quote cards). A route handler rather than Server Actions: Next runs
 * Server Actions one at a time per client and holds the router meanwhile, so a slow quote froze the whole page.
 */
export async function POST(request: Request): Promise<Response> {
  return tradingPost(request, async (userId, _accountId, raw) => {
    const body = bodySchema.parse(raw);
    const db = database();
    switch (body.step) {
      case "quote":
        return quoteManualTrade(db, userId, body.input);
      case "chat_quote":
        return quoteManualTrade(db, userId, await resolveChatQuote(body.input));
      case "confirm": {
        const result = await confirmManualTrade(db, userId, body.input);
        if (IN_FLIGHT.has(result.status)) {
          await start(runManualTrade, [userId, result.id]);
        }
        return result;
      }
      case "dismiss":
        await dismissManualTrade(db, userId, body.input);
        return null;
      default: {
        const unhandled: never = body;
        throw new Error(`Unhandled order step: ${JSON.stringify(unhandled)}`);
      }
    }
  });
}
