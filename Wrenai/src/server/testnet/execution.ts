import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { TestnetError, testnetCipher } from "./config";
import type { TestnetDatabase } from "./database";
import { openPlan } from "./orders";
import { changeBalance, poolTransaction } from "./pool";
import { reconcileStage, reconcileSwap } from "./reconcile";
import { testnetRpc } from "./rpc";
import { tnOrders, tnOwners, tnSubmissions } from "./schema";
import { signPoolStage } from "./signing";
export async function advanceTestnetOrder(db: TestnetDatabase, id: string): Promise<boolean> {
  const [order] = await db.select().from(tnOrders).where(eq(tnOrders.id, id));
  if (!order || ["review", "settled", "failed", "needs_review"].includes(order.state)) {
    return false;
  }
  const [owner] = await db.select().from(tnOwners).where(eq(tnOwners.id, order.ownerId));
  if (!owner) {
    return false;
  }
  if (order.step >= openPlan(order).calls.length) {
    if (order.kind === "swap") {
      await reconcileSwap(db, order);
    }
    return (await db.select().from(tnOrders).where(eq(tnOrders.id, id)))[0]?.state === "submitted";
  }
  if (order.txHash) {
    await reconcileStage(db, order);
    return true;
  }
  if (owner.kind === "wallet") {
    return false;
  }
  try {
    const prepared = await signPoolStage(db, id);
    if (prepared) {
      await testnetRpc("broadcast_tx_async", [prepared.bytes]);
      await db.update(tnOrders).set({ state: "submitted" }).where(eq(tnOrders.id, id));
    }
    return true;
  } catch (error) {
    if (
      error instanceof TestnetError &&
      (error.code === "limit" || error.code === "conflict" || error.code === "unauthorized")
    ) {
      await rejectUnsignedOrder(db, id, error.message);
      return false;
    }
    throw error;
  }
}

export async function rejectUnsignedOrder(db: TestnetDatabase, id: string, message: string): Promise<void> {
  await poolTransaction(db, async (tx) => {
    const [order] = await tx.select().from(tnOrders).where(eq(tnOrders.id, id));
    if (!order || ["settled", "failed"].includes(order.state)) {
      return;
    }
    const [unknown] = await tx
      .select()
      .from(tnSubmissions)
      .where(and(eq(tnSubmissions.orderId, id), isNull(tnSubmissions.finalizedAt)))
      .limit(1);
    if (unknown || order.step >= openPlan(order).calls.length) {
      await tx.update(tnOrders).set({ state: "needs_review", message }).where(eq(tnOrders.id, id));
      return;
    }
    const [owner] = await tx.select().from(tnOwners).where(eq(tnOwners.id, order.ownerId));
    if (owner?.kind === "guest" && order.confirmedAt) {
      await changeBalance(
        tx,
        order.ownerId,
        order.assetId,
        0n,
        -BigInt(order.inputUnits),
        order.bucket,
        order.location,
      );
    }
    await tx.update(tnOrders).set({ state: "failed", message }).where(eq(tnOrders.id, id));
  });
}
export async function resumeTestnetOrder(db: TestnetDatabase, owner: string, id: string): Promise<void> {
  const [order] = await db
    .select()
    .from(tnOrders)
    .where(and(eq(tnOrders.id, id), eq(tnOrders.ownerId, owner)));
  if (!order?.confirmedAt) {
    throw new TestnetError("unauthorized", "This order is not confirmed by this session.");
  }
  const [submission] = await db
    .select()
    .from(tnSubmissions)
    .where(and(eq(tnSubmissions.orderId, id), eq(tnSubmissions.step, order.step)));
  if (order.state === "prepared" && submission && !submission.finalizedAt) {
    const bytes = testnetCipher().open(owner, id, `signed:${order.step}`, submission.sealedBytes);
    await testnetRpc("broadcast_tx_async", [bytes]);
    await db.update(tnOrders).set({ state: "submitted" }).where(eq(tnOrders.id, id));
  }
  await advanceTestnetOrder(db, id);
}
