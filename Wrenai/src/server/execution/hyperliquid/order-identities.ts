import "server-only";
import { and, desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { ExecutionError } from "../contracts";
import type { LedgerAction } from "../records";
import type { PerpsCheckpoint } from "./checkpoint";
import { type HlOrder, hlActionSchema } from "./contracts";
import { hlUnits } from "./decimal";
import { readHlOrderStatus } from "./observations";
import type { HlOrderRecord } from "./order-record";

const terminalStatuses = new Set([
  "filled",
  "canceled",
  "rejected",
  "marginCanceled",
  "vaultWithdrawalCanceled",
  "openInterestCapCanceled",
  "selfTradeCanceled",
  "reduceOnlyCanceled",
  "siblingFilledCanceled",
  "delistedCanceled",
  "liquidatedCanceled",
  "scheduledCancel",
  "tickRejected",
  "minTradeNtlRejected",
  "perpMarginRejected",
  "reduceOnlyRejected",
  "badAloPxRejected",
  "iocCancelRejected",
  "triggerRejected",
  "marketOrderNoLiquidityRejected",
  "positionIncreaseAtOpenInterestCapRejected",
  "positionFlipAtOpenInterestCapRejected",
  "tooAggressiveAtOpenInterestCapRejected",
  "openInterestIncreaseRejected",
  "insufficientSpotBalanceRejected",
  "oracleRejected",
  "perpMaxPositionRejected",
]);
export async function perpsOrderIdentities(
  db: AppDatabase,
  action: LedgerAction,
  saved: HlOrderRecord,
  checkpoint?: PerpsCheckpoint,
): Promise<{
  readonly known: ReadonlyMap<number, HlOrder>;
  readonly parentTerminal: boolean;
  readonly parentUnknown: boolean;
}> {
  if (saved.action.type !== "order") {
    throw new ExecutionError("conflict", "The parent venue action is not an order.");
  }
  const extra = await db
    .select({ detail: executionEvents.detailJson })
    .from(executionEvents)
    .where(and(eq(executionEvents.actionId, action.id), like(executionEvents.kind, "hl_signed_protect:%")))
    .orderBy(desc(executionEvents.createdAt))
    .limit(3);
  const additional = extra.flatMap((row) => {
    const parsed = z.object({ action: hlActionSchema }).parse(JSON.parse(row.detail)).action;
    return parsed.type === "order" ? parsed.orders : [];
  });
  const wires = [...saved.action.orders, ...additional],
    parent = saved.action.orders[0];
  const known = new Map(checkpoint?.orders.map((order) => [order.oid, order.wire]) ?? []);
  const results = await Promise.allSettled(
    wires.map(async (wire) => {
      if (!wire.c) {
        throw new ExecutionError("conflict", "Every managed venue order requires a stable cloid.");
      }
      return { wire, status: await readHlOrderStatus(saved.address, wire.c) };
    }),
  );
  let parentTerminal = false,
    parentUnknown = true;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      throw new ExecutionError(
        "not_ready",
        "A complete venue order-status lookup is required before reconciliation.",
      );
    }
    const { wire, status } = result.value;
    if (status.status === "order") {
      const order = status.order.order;
      if (
        order.coin !== saved.market.name ||
        order.side !== (wire.b ? "B" : "A") ||
        hlUnits(order.origSz, saved.market.sizeDecimals) > hlUnits(wire.s, saved.market.sizeDecimals) ||
        hlUnits(order.limitPx, 18) !== hlUnits(wire.p, 18)
      ) {
        throw new ExecutionError("conflict", "The venue order identity differs from its signed wire.");
      }
      known.set(order.oid, wire);
      if (wire.c === parent?.c) {
        parentUnknown = false;
        parentTerminal = terminalStatuses.has(status.order.status);
      }
    }
  }
  if (known.size > 20) {
    throw new ExecutionError(
      "not_ready",
      "Reconcile older protective orders before retaining more venue identities.",
    );
  }
  return { known, parentTerminal, parentUnknown };
}
