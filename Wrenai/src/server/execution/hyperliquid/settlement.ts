import "server-only";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { previewFifoLots } from "@/server/positions/lots";
import { minimumUnits } from "@/shared/token-units";
import { ExecutionError } from "../contracts";
import { settleDefiExecution } from "../defi-accounting";
import { defiPlanSchema } from "../defi-contracts";
import { markInventoryUncertain } from "../inventory-state";
import {
  databaseTime,
  executionEvent,
  executionHash,
  type LedgerAction,
  ownedLedgerAction,
  requireLease,
} from "../records";
import type { HlAccountState } from "./account-state";
import { type PerpsCheckpoint, perpsCheckpointSchema } from "./checkpoint";
import type { HlOrder } from "./contracts";
import type { PerpsFillAccounting } from "./fill-accounting";
import type { HlFill } from "./observations";
import type { HlOrderRecord } from "./order-record";

export async function settlePerpsFills(
  db: AppDatabase,
  action: LedgerAction,
  token: string,
  saved: HlOrderRecord,
  result: PerpsFillAccounting,
  state: HlAccountState,
  fills: readonly HlFill[],
  openOrderIds: ReadonlySet<number>,
  known: ReadonlyMap<number, HlOrder>,
  previous?: PerpsCheckpoint,
): Promise<void> {
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
    cash = plan.cash[0],
    exposure = plan.positions.find((p) => p.kind === "perp_long" || p.kind === "perp_short"),
    collateral = plan.positions.find((p) => p.kind === "collateral");
  if (
    !cash ||
    !exposure ||
    !collateral ||
    result.risk <= 0n ||
    fills.length === 0 ||
    result.debit > BigInt(cash.maxDebitUnits)
  ) {
    throw new ExecutionError(
      "not_ready",
      "The venue cash debit or complete position receipt exceeds its held resources.",
    );
  }
  await userTransaction(db, action.userId, async (tx) => {
    const row = await ownedLedgerAction(tx, action.userId, action.id);
    requireLease(row, token, await databaseTime(tx));
    const debitedPrincipal =
      result.debit === 0n
        ? 0n
        : (
            await previewFifoLots(
              tx,
              action.userId,
              action.agentId,
              "hyperliquid",
              cash.assetId,
              result.debit,
            )
          ).principalMicroUsd;
    const total = debitedPrincipal + BigInt(saved.beforeCollateralPrincipal);
    const continuingPrincipal =
      saved.role === "entry"
        ? result.debit === 0n
          ? 0n
          : (debitedPrincipal * minimumUnits(result.collateral, result.debit)) / result.debit
        : BigInt(saved.beforeExposureUnits) === 0n
          ? 0n
          : (BigInt(saved.beforeCollateralPrincipal) * result.quantity) / BigInt(saved.beforeExposureUnits);
    const releasedPrincipal = total - continuingPrincipal,
      creditPrincipal = minimumUnits(releasedPrincipal, result.credit);
    const evidence = {
      address: saved.address,
      stateTime: state.time,
      fills: fills.map((fill) => ({ ...fill })),
      orderIds: [...known.keys()].sort((a, b) => a - b),
    };
    await settleDefiExecution(tx, action.userId, action.id, token, {
      providerEventId: `hl:${saved.address.toLowerCase()}:${action.requestId}`,
      riskDebitMicroUsd: result.risk.toString(),
      feeMicroUsd: result.fee < 0n ? null : result.fee.toString(),
      cash: [
        {
          assetId: cash.assetId,
          debitUnits: result.debit.toString(),
          creditUnits: result.credit.toString(),
          creditValueMicroUsd: result.credit.toString(),
          creditPrincipalMicroUsd: creditPrincipal.toString(),
        },
      ],
      positions: [
        { positionId: exposure.positionId, afterUnits: result.quantity.toString(), principalMicroUsd: "0" },
        {
          positionId: collateral.positionId,
          afterUnits: result.collateral.toString(),
          principalMicroUsd: continuingPrincipal.toString(),
        },
      ],
      retiredPrincipalMicroUsd: (total - continuingPrincipal - creditPrincipal).toString(),
      borrowedCapitalMicroUsd: "0",
      occurredAt: state.time,
    });
    const stopOrder =
      saved.action.type === "order"
        ? saved.action.orders.find((order) => "trigger" in order.t && order.t.trigger.tpsl === "sl")
        : undefined;
    const originalStop = stopOrder && "trigger" in stopOrder.t ? stopOrder.t.trigger.triggerPx : "0";
    const checkpoint = perpsCheckpointSchema.parse({
      entryActionId: previous?.entryActionId ?? action.id,
      time: state.time,
      cash: result.cashAfter.toString(),
      quantity: result.quantity.toString(),
      collateral: result.collateral.toString(),
      collateralPrincipal: continuingPrincipal.toString(),
      sequence: previous?.sequence ?? 0,
      watermark: previous?.watermark ?? saved.market.mark,
      stop: previous?.stop ?? originalStop,
      orders: [...known.entries()]
        .filter(([oid]) => openOrderIds.has(oid))
        .map(([oid, wire]) => ({ oid, wire })),
    });
    await executionEvent(tx, row, "hl_verified_fills", await databaseTime(tx), evidence);
    await executionEvent(tx, row, "hl_checkpoint", await databaseTime(tx), checkpoint);
  });
}
/** A rejected or expired zero-fill IOC is terminal only after venue history, cash and exposure prove no effect. */
export async function settlePerpsNoEffect(
  db: AppDatabase,
  action: LedgerAction,
  token: string,
  evidence: unknown,
): Promise<void> {
  await userTransaction(db, action.userId, async (tx) => {
    const row = await ownedLedgerAction(tx, action.userId, action.id),
      now = await databaseTime(tx);
    requireLease(row, token, now);
    if (!["submitting", "submitted", "unknown"].includes(row.status)) {
      throw new ExecutionError("conflict", "The no-fill proof belongs to a different execution state.");
    }
    await tx
      .update(executionActions)
      .set({
        status: "settled",
        settledAt: now,
        updatedAt: now,
        settlementHash: executionHash(evidence),
        settlementReceiptId: `hl-no-fill:${action.id}`,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(and(eq(executionActions.id, action.id), eq(executionActions.userId, action.userId)));
    await markInventoryUncertain(tx, row);
    await executionEvent(tx, row, "hl_no_fill", now, evidence);
  });
}
