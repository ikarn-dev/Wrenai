import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { runtimeStrategyStateSchema } from "@/server/engine/strategy-state";
import { readPerpsCheckpoint } from "@/server/execution/hyperliquid/checkpoint";
import { hlUnits } from "@/server/execution/hyperliquid/decimal";
import { readHlOrder } from "@/server/execution/hyperliquid/order-record";
import { ownedLedgerAction } from "@/server/execution/records";
import type { Strategy } from "@/shared/agents";

/** A version change can close an owned Perps position; it cannot repurpose it for a different market or side. */
export async function canReplacePerpsVersion(
  db: AppDatabase,
  userId: string,
  agentId: string,
  previous: string,
  next: Strategy,
): Promise<boolean> {
  if (runtimeStrategyStateSchema.parse(JSON.parse(previous)).format !== 5) {
    return false;
  }
  const checkpoint = await readPerpsCheckpoint(db, userId, agentId);
  if (!checkpoint) {
    return false;
  }
  if (checkpoint.quantity === "0") {
    return true;
  }
  const action = await ownedLedgerAction(db, userId, checkpoint.entryActionId),
    record = await readHlOrder(db, action);
  if (
    next.kind !== "perps" ||
    next.action === "open" ||
    next.market !== record.market.name ||
    record.action.type !== "order" ||
    next.side !== (record.action.orders[0]?.b ? "long" : "short")
  ) {
    return false;
  }
  const quantity = hlUnits(next.quantity, record.market.sizeDecimals);
  return (
    quantity > 0n &&
    quantity <= BigInt(checkpoint.quantity) &&
    (next.action !== "close" || quantity === BigInt(checkpoint.quantity))
  );
}
