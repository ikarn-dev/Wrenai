import { start } from "workflow/api";
import { z } from "zod";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import {
  checkPaymentTopUpApproval,
  reviewJarvisPrivatePayment,
} from "@/server/manual-trading/payment-top-up";
import { tradingPost } from "@/server/manual-trading/trading-action";
import { beginWalletPayment, quoteWalletPayment, recordWalletPayment } from "@/server/wallet-swap/payment";
import { paymentTopUpView, readPaymentTopUp } from "@/server/wallet-swap/private-top-up";
import { beginWalletSwap, submitWalletSwap } from "@/server/wallet-swap/service";
import { walletSwapIdSchema, walletSwapProofSchema } from "@/shared/wallet-swap";
import { runManualTrade } from "@/workflows/manual-trading";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("review_public"), input: z.unknown() }),
  z.strictObject({ step: z.literal("approve_public"), input: z.unknown() }),
  z.strictObject({ step: z.literal("confirm_public"), input: z.unknown() }),
  z.strictObject({ step: z.literal("review_private"), input: z.unknown() }),
  z.strictObject({ step: z.literal("approve_top_up"), input: z.unknown() }),
  z.strictObject({ step: z.literal("record_top_up"), input: z.unknown() }),
  z.strictObject({ step: z.literal("resume_top_up"), input: z.unknown() }),
]);

/**
 * Jarvis payment card mutations, public wallet payments and privately funded top-ups. A route handler rather than
 * Server Actions, so a payment review or NEAR receipt check never holds the chat page's router.
 */
export async function POST(request: Request): Promise<Response> {
  return tradingPost(request, async (userId, _accountId, raw) => {
    const body = bodySchema.parse(raw);
    const db = database();
    switch (body.step) {
      case "review_public":
        return quoteWalletPayment(db, userId, body.input);
      case "approve_public":
        return beginWalletPayment(db, userId, body.input);
      case "confirm_public":
        return recordWalletPayment(db, userId, body.input);
      case "review_private": {
        const review = await reviewJarvisPrivatePayment(db, userId, body.input);
        return { private: review.private, topUp: review.topUp && paymentTopUpView(review.topUp) };
      }
      case "approve_top_up": {
        const { id } = walletSwapIdSchema.parse(body.input);
        await checkPaymentTopUpApproval(db, userId, id);
        // Queue before exposing wallet actions, so closing the tab doesn't interrupt the funded payment.
        await start(runManualTrade, [userId, id]);
        return paymentTopUpView(await beginWalletSwap(db, userId, { id }, true));
      }
      case "record_top_up": {
        const input = walletSwapProofSchema.parse(body.input);
        if (!(await readPaymentTopUp(db, userId, input.id))) {
          throw new ExecutionError("not_found", "This payment top-up could not be found.");
        }
        const deposit = await submitWalletSwap(db, userId, input, true);
        await start(runManualTrade, [userId, input.id]);
        return paymentTopUpView(deposit);
      }
      case "resume_top_up": {
        const { id } = walletSwapIdSchema.parse(body.input);
        const deposit = await readPaymentTopUp(db, userId, id);
        if (
          !deposit ||
          !["signing", "submitted", "settled"].includes(deposit.state) ||
          deposit.quote.privateTopUp.reviewRequired
        ) {
          throw new ExecutionError("not_ready", "This payment is no longer waiting for a deposit check.");
        }
        await start(runManualTrade, [userId, id]);
        return null;
      }
      default: {
        const unhandled: never = body;
        throw new Error(`Unhandled payment step: ${JSON.stringify(unhandled)}`);
      }
    }
  });
}
