import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { readHlAccount } from "@/server/execution/hyperliquid/account-state";
import { type PerpsCheckpoint, readPerpsCheckpoint } from "@/server/execution/hyperliquid/checkpoint";
import { hlUnits } from "@/server/execution/hyperliquid/decimal";
import { sendHlRequest } from "@/server/execution/hyperliquid/journal";
import { readHlOpenOrders } from "@/server/execution/hyperliquid/observations";
import { perpsOrderIdentities } from "@/server/execution/hyperliquid/order-identities";
import { readHlOrder } from "@/server/execution/hyperliquid/order-record";
import { executionHash, type LedgerAction } from "@/server/execution/records";
import { manualPerpsContext } from "./perps-context";

/** The opening confirmation also owns cleanup of its reduce-only children after its position is closed. */
export async function cleanClosedManualOrders(
  db: AppDatabase,
  entry: LedgerAction,
  checkpoint: PerpsCheckpoint,
): Promise<boolean> {
  if (checkpoint.entryActionId !== entry.id || checkpoint.quantity !== "0") {
    return false;
  }
  const saved = await readHlOrder(db, entry),
    account = await readHlAccount(saved.address);
  if (account.assetPositions.some((p) => hlUnits(p.position.szi, 18) !== 0n)) {
    return false;
  }
  const orders = await readHlOpenOrders(saved.address);
  if (!orders.length) {
    return true;
  }
  const identity = await perpsOrderIdentities(db, entry, saved, checkpoint);
  const cancels = orders.map((order) => {
    const wire = identity.known.get(order.oid);
    if (!wire?.c || !wire.r || !order.reduceOnly) {
      throw new ExecutionError("not_ready", "Review unmanaged venue orders before returning funds.");
    }
    return { asset: wire.a, cloid: wire.c };
  });
  if (cancels.length > 3) {
    throw new ExecutionError("not_ready", "Review extra venue orders before returning funds.");
  }
  const role = `cancel:${Number.parseInt(executionHash(cancels).slice(0, 6), 16)}`;
  await sendHlRequest(db, entry, "", role, { type: "cancelByCloid", cancels }, async (tx) => {
    await manualPerpsContext(tx, entry);
    const current = await readPerpsCheckpoint(tx, entry.userId, entry.agentId);
    const [pending] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, entry.userId),
          eq(executionActions.agentId, entry.agentId),
          isNull(executionActions.reservationReleasedAt),
        ),
      )
      .limit(1);
    if (current?.quantity !== "0" || current.time !== checkpoint.time || pending) {
      throw new ExecutionError("conflict", "The manual position changed before order cleanup.");
    }
  });
  return false;
}
