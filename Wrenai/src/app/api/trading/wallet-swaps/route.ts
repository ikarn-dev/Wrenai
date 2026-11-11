import { z } from "zod";
import { database } from "@/server/db/client";
import { tradingPost } from "@/server/manual-trading/trading-action";
import {
  beginWalletSwap,
  cancelWalletSwap,
  prepareWalletSwap,
  submitWalletSwap,
} from "@/server/wallet-swap/service";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("request"), input: z.unknown() }),
  z.strictObject({ step: z.literal("start"), input: z.unknown() }),
  z.strictObject({ step: z.literal("record"), input: z.unknown() }),
  z.strictObject({ step: z.literal("dismiss"), input: z.unknown() }),
]);

/** Swaps paid from the wallet: the wallet signs; Wrenai only quotes, verifies and tracks. Never holds the router. */
export async function POST(request: Request): Promise<Response> {
  return tradingPost(request, async (userId, _accountId, raw) => {
    const body = bodySchema.parse(raw);
    const db = database();
    switch (body.step) {
      case "request":
        return prepareWalletSwap(db, userId, body.input);
      case "start":
        return beginWalletSwap(db, userId, body.input);
      case "record":
        return submitWalletSwap(db, userId, body.input);
      case "dismiss":
        await cancelWalletSwap(db, userId, body.input);
        return null;
      default: {
        const unhandled: never = body;
        throw new Error(`Unhandled wallet swap step: ${JSON.stringify(unhandled)}`);
      }
    }
  });
}
