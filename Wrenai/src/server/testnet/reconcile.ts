import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { testnetAsset } from "@/shared/testnet";
import { tokenUnitsSchema } from "@/shared/token-units";
import { TestnetError } from "./config";
import type { TestnetDatabase } from "./database";
import { openPlan, type TestnetOrder } from "./orders";
import { changeBalance, poolTransaction } from "./pool";
import { creditedIntents, creditedToken, proveCall, receiptSchema } from "./proof";
import { tidepool, VERIFIER } from "./provider";
import { testnetRpc } from "./rpc";
import { tnOrders, tnOwners, tnPayouts, tnSubmissions } from "./schema";
export async function reconcileStage(db: TestnetDatabase, order: TestnetOrder): Promise<boolean> {
  const plan = openPlan(order),
    call = plan.calls[order.step];
  if (!order.txHash || !call) {
    return false;
  }
  const raw = await testnetRpc("tx", {
    tx_hash: order.txHash,
    sender_account_id: plan.signer,
    wait_until: "FINAL",
  });
  const receipt = proveCall(raw, order.txHash, plan.signer, call);
  if (
    order.location === "intents" &&
    call.method === "mt_transfer" &&
    creditedIntents(receipt, VERIFIER, order.assetId, String(call.args["receiver_id"])) !==
      BigInt(order.inputUnits)
  ) {
    throw new TestnetError("conflict", "The public Intents deposit credit has not been proven.");
  }
  const feeUnits = (
    BigInt(receipt.transaction_outcome.outcome.tokens_burnt) +
    receipt.receipts_outcome.reduce((n, r) => n + BigInt(r.outcome.tokens_burnt), 0n)
  ).toString();
  await poolTransaction(db, async (tx) => {
    const [current] = await tx.select().from(tnOrders).where(eq(tnOrders.id, order.id));
    if (!current || current.step !== order.step || current.txHash !== order.txHash) {
      return;
    }
    await tx
      .update(tnSubmissions)
      .set({ finalizedAt: Date.now(), outcome: JSON.stringify({ feeUnits }) })
      .where(and(eq(tnSubmissions.orderId, order.id), eq(tnSubmissions.step, order.step)));
    const next = order.step + 1;
    await tx
      .update(tnOrders)
      .set({
        step: next,
        state: next < plan.calls.length ? "queued" : "submitted",
        txHash: next < plan.calls.length ? null : order.txHash,
      })
      .where(eq(tnOrders.id, order.id));
    if (next === plan.calls.length && order.kind === "payment") {
      await settle(tx, current, 0n, 0n);
    }
  });
  return true;
}
async function settle(
  db: TestnetDatabase,
  order: TestnetOrder,
  output: bigint,
  refund: bigint,
): Promise<void> {
  const [owner] = await db.select().from(tnOwners).where(eq(tnOwners.id, order.ownerId));
  if (owner?.kind === "guest") {
    await changeBalance(
      db,
      order.ownerId,
      order.assetId,
      -BigInt(order.inputUnits) + refund,
      -BigInt(order.inputUnits),
      order.bucket,
      order.location,
    );
    if (order.outputAssetId && output > 0n) {
      await changeBalance(
        db,
        order.ownerId,
        order.outputAssetId,
        output,
        0n,
        order.bucket,
        order.outputLocation,
      );
    }
  }
  await db
    .update(tnOrders)
    .set({
      state: refund > 0n ? "failed" : "settled",
      outputUnits: order.outputAssetId ? output.toString() : null,
      message:
        refund > 0n
          ? "Refund confirmed. Unspent input was returned."
          : order.kind === "payment"
            ? "Payment sent."
            : "Swap completed.",
    })
    .where(eq(tnOrders.id, order.id));
}
const hashes = z
  .array(z.object({ hash: z.string() }))
  .max(10)
  .nullish();
const statusSchema = z.object({
  status: z.string(),
  quoteResponse: z.object({
    quoteRequest: z.object({
      originAsset: z.string(),
      destinationAsset: z.string(),
      amount: z.string(),
      recipient: z.string(),
      refundTo: z.string(),
      depositType: z.string().optional(),
      refundType: z.string().optional(),
      recipientType: z.string().optional(),
    }),
    quote: z.object({ depositAddress: z.string() }),
  }),
  swapDetails: z.object({
    amountIn: tokenUnitsSchema.nullish(),
    amountOut: tokenUnitsSchema.nullish(),
    refundedAmount: tokenUnitsSchema.nullish(),
    destinationChainTxHashes: hashes,
    originChainTxHashes: hashes,
    nearTxHashes: z.array(z.string()).max(20).optional(),
  }),
});
export async function reconcileSwap(db: TestnetDatabase, order: TestnetOrder): Promise<boolean> {
  const plan = openPlan(order),
    q = plan.quote;
  if (!q?.quote.depositAddress || order.step < plan.calls.length) {
    return false;
  }
  const status = statusSchema.parse(await tidepool("/v0/status", undefined, q.quote.depositAddress)),
    r = status.quoteResponse.quoteRequest;
  if (
    status.quoteResponse.quote.depositAddress !== q.quote.depositAddress ||
    r.originAsset !== order.assetId ||
    r.destinationAsset !== order.outputAssetId ||
    r.amount !== order.inputUnits ||
    r.recipient !== plan.signer ||
    r.refundTo !== plan.signer ||
    (r.depositType ?? "ORIGIN_CHAIN") !== q.quoteRequest.depositType ||
    (r.refundType ?? "ORIGIN_CHAIN") !== q.quoteRequest.refundType ||
    (r.recipientType ?? "DESTINATION_CHAIN") !== q.quoteRequest.recipientType
  ) {
    throw new TestnetError("conflict", "Provider status does not match this exact order.");
  }
  if (!["SUCCESS", "REFUNDED"].includes(status.status)) {
    return false;
  }
  const detail = status.swapDetails,
    refund = BigInt(detail.refundedAmount ?? "0"),
    output = BigInt(detail.amountOut ?? "0");
  if (
    refund > BigInt(order.inputUnits) ||
    (status.status === "SUCCESS" &&
      (refund !== 0n || detail.amountIn !== order.inputUnits || output < BigInt(q.quote.minAmountOut)))
  ) {
    throw new TestnetError("conflict", "Provider amounts need reconciliation.");
  }
  const token = testnetAsset(status.status === "SUCCESS" ? (order.outputAssetId ?? "") : order.assetId);
  if (!token.contract) {
    throw new TestnetError("conflict", "This route cannot deliver native NEAR.");
  }
  const location = status.status === "SUCCESS" ? order.outputLocation : order.location;
  const published =
    status.status === "SUCCESS" ? detail.destinationChainTxHashes : detail.originChainTxHashes;
  const evidence =
    location === "intents"
      ? [...(published ?? []), ...(detail.nearTxHashes ?? []).map((hash) => ({ hash }))]
      : published;
  if (!evidence?.length) {
    throw new TestnetError("unavailable", "Waiting for a finalized payout receipt.");
  }
  let credit = 0n;
  for (const hash of new Set(evidence.map((h) => h.hash))) {
    const receipt = receiptSchema.parse(
      await testnetRpc("tx", {
        tx_hash: hash,
        sender_account_id: "maker.tidepool-sandbox.testnet",
        wait_until: "FINAL",
      }),
    );
    if (receipt.transaction.hash !== hash) {
      throw new TestnetError("conflict", "The payout transaction identity changed.");
    }
    credit +=
      (status.status === "SUCCESS" ? order.outputLocation : order.location) === "intents"
        ? creditedIntents(receipt, VERIFIER, token.id, plan.signer)
        : creditedToken(receipt, token.contract, plan.signer);
  }
  if (
    status.status === "SUCCESS" ? credit !== output : credit !== refund || refund !== BigInt(order.inputUnits)
  ) {
    throw new TestnetError("conflict", "The final token credit has not been proven. Funds stay reserved.");
  }
  await poolTransaction(db, async (tx) => {
    const [current] = await tx.select().from(tnOrders).where(eq(tnOrders.id, order.id));
    if (current && current.state !== "settled" && current.state !== "failed") {
      for (const hash of new Set(evidence.map((h) => h.hash))) {
        await tx
          .insert(tnPayouts)
          .values({
            hash,
            orderId: order.id,
            assetId: token.id,
            units: credit.toString(),
            createdAt: Date.now(),
          })
          .onConflictDoNothing();
        const [proof] = await tx.select().from(tnPayouts).where(eq(tnPayouts.hash, hash));
        if (proof?.orderId !== order.id) {
          throw new TestnetError("conflict", "This payout was already attributed to another order.");
        }
      }
      await settle(tx, current, output, refund);
    }
  });
  return true;
}
