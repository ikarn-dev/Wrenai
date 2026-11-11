import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { delegatedKeys } from "@/server/db/schema";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError } from "@/server/execution/contracts";
import { executionHash } from "@/server/execution/records";
import { readKeyRegistration } from "@/server/intents/verifier";
import { NearRpcError } from "@/server/near/rpc";
import {
  preparePaymentTopUp,
  readPaymentTopUp,
  requireReviewAfterTopUp,
} from "@/server/wallet-swap/private-top-up";
import { readWalletSwap } from "@/server/wallet-swap/service";
import { type ManualPreview, manualPaymentIntentSchema } from "@/shared/manual-trading";
import type { WalletSwapView } from "@/shared/wallet-swap";
import { PaymentShortfall } from "./payment";
import { confirmManualTrade, quoteManualTrade } from "./service";

const reviewInput = z.strictObject({ requestId: z.uuid(), intent: manualPaymentIntentSchema });

async function paymentKey(db: AppDatabase, owner: string) {
  const [key] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, owner)).limit(1);
  return key?.activatedAt && key.activatedAtBlock ? key : null;
}

export async function reviewJarvisPrivatePayment(
  db: AppDatabase,
  owner: string,
  raw: unknown,
): Promise<{ private: ManualPreview | null; topUp: WalletSwapView | null }> {
  const input = reviewInput.parse(raw);
  const saved = await readPaymentTopUp(db, owner, input.requestId);
  if (saved) {
    if (executionHash(saved.quote.privateTopUp.intent) !== executionHash(input.intent)) {
      throw new ExecutionError("conflict", "This request already belongs to a different payment.");
    }
    return { private: null, topUp: saved };
  }
  const key = await paymentKey(db, owner);
  if (!key) {
    throw new ExecutionError("not_ready", "Set up trading access in Settings before sending privately.");
  }
  try {
    return { private: await quoteManualTrade(db, owner, { ...input, source: "jarvis" }), topUp: null };
  } catch (error) {
    if (!(error instanceof PaymentShortfall)) {
      throw error;
    }
    return {
      private: null,
      topUp: await preparePaymentTopUp(db, owner, input.requestId, input.intent, error, key.publicKey),
    };
  }
}

export async function checkPaymentTopUpApproval(db: AppDatabase, owner: string, id: string): Promise<void> {
  const [topUp, key, session] = await Promise.all([
    readPaymentTopUp(db, owner, id),
    paymentKey(db, owner),
    privateBalanceToken(db, owner),
  ]);
  if (topUp?.state !== "quoted") {
    throw new ExecutionError("conflict", "The wallet top-up expired or approval already started.");
  }
  if (!session || !key || key.publicKey !== topUp.quote.privateTopUp.signingPublicKey) {
    throw new ExecutionError("not_ready", "Connect your private balance and trading access before funding.");
  }
  const registration = await readKeyRegistration(topUp.quote.accountId, key.publicKey);
  if (!registration.registered || registration.blockHeight < (key.activatedAtBlock ?? 0)) {
    throw new ExecutionError("not_ready", "Trading access was revoked or could not be verified.");
  }
}

export async function advancePaymentTopUp(
  db: AppDatabase,
  owner: string,
  id: string,
): Promise<"waiting" | "confirmed" | "done"> {
  const topUp = await readPaymentTopUp(db, owner, id);
  if (!topUp || topUp.quote.privateTopUp.reviewRequired) {
    return "done";
  }
  const review = topUp.quote.privateTopUp;
  const deadline = Date.parse(review.requestDeadline);
  if (topUp.state === "quoted") {
    // The workflow can start just before the wallet request is released.
    return "waiting";
  }
  if (!["signing", "submitted", "settled"].includes(topUp.state)) {
    return "done";
  }
  let deposit: WalletSwapView = topUp;
  if (topUp.state !== "settled") {
    try {
      deposit = await readWalletSwap(db, owner, { id }, true);
    } catch (error) {
      if (
        !(
          error instanceof NearRpcError ||
          (error instanceof ExecutionError && error.code === "not_ready") ||
          (error instanceof DOMException && error.name === "TimeoutError")
        )
      ) {
        throw error;
      }
      return topUp.state === "submitted" || Date.now() < deadline ? "waiting" : "done";
    }
  }
  if (deposit.state !== "settled") {
    return deposit.state === "submitted" || (deposit.state === "signing" && Date.now() < deadline)
      ? "waiting"
      : "done";
  }
  return finishFundedPayment(db, owner, topUp);
}

async function finishFundedPayment(
  db: AppDatabase,
  owner: string,
  topUp: NonNullable<Awaited<ReturnType<typeof readPaymentTopUp>>>,
): Promise<"confirmed" | "done"> {
  const { id, quote } = topUp;
  const review = quote.privateTopUp;
  const key = await paymentKey(db, owner);
  if (Date.now() < Date.parse(review.requestDeadline) && key?.publicKey === review.signingPublicKey) {
    try {
      const registration = await readKeyRegistration(quote.accountId, key.publicKey);
      if (!registration.registered || registration.blockHeight < (key.activatedAtBlock ?? 0)) {
        await requireReviewAfterTopUp(db, owner, id);
        return "done";
      }
      const preview = await quoteManualTrade(
        db,
        owner,
        {
          requestId: id,
          source: "jarvis",
          intent: review.intent,
        },
        true,
      );
      if (preview.status === "quoted") {
        await confirmManualTrade(db, owner, {
          id,
          revision: preview.revision,
          bindingHash: preview.bindingHash,
        });
        return "confirmed";
      }
      if (preview.actionId) {
        return "confirmed";
      }
    } catch (error) {
      if (
        !(error instanceof ExecutionError) ||
        !["limit", "insufficient_funds", "conflict"].includes(error.code)
      ) {
        throw error;
      }
    }
  }
  await requireReviewAfterTopUp(db, owner, id);
  return "done";
}
