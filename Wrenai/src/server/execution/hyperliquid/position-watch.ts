import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "../contracts";
import { defiPlanSchema } from "../defi-contracts";
import { databaseTime, executionEvent, executionHash, ownedLedgerAction } from "../records";
import { readHlAccount, synchronizePerpsInventory } from "./account-state";
import { type PerpsCheckpoint, readPerpsCheckpoint } from "./checkpoint";
import { accountPerpsFills } from "./fill-accounting";
import { fundingOnlyAccounting, observedIsolatedCollateral, readHlFunding } from "./funding-observation";
import { corroboratePerpsLiquidations } from "./liquidation";
import { settleNativePerpsExit } from "./native-exit";
import { readHlFills, readHlOpenOrders, readHlTransfers } from "./observations";
import { perpsOrderIdentities } from "./order-identities";
import { hlOrderRecordSchema, readHlOrder } from "./order-record";
import { maintainPerpsProtection } from "./protection";

/** Native order facts are reconciled even while the agent is paused. Read-only mode never signs. */
export async function watchPerpsPosition(
  db: AppDatabase,
  userId: string,
  agentId: string,
  repair: boolean,
): Promise<PerpsCheckpoint | null> {
  const checkpoint = await readPerpsCheckpoint(db, userId, agentId);
  if (!checkpoint || checkpoint.quantity === "0") {
    return checkpoint;
  }
  const entry = await ownedLedgerAction(db, userId, checkpoint.entryActionId),
    original = await readHlOrder(db, entry);
  const identities = await perpsOrderIdentities(db, entry, original, checkpoint),
    observed = await readHlAccount(original.address);
  if (observed.time <= checkpoint.time) {
    return checkpoint;
  }
  const fills = await readHlFills(original.address, checkpoint.time + 1, observed.time);
  const liquidations = await readHlTransfers(original.address, checkpoint.time + 1, observed.time);
  const identified = corroboratePerpsLiquidations(original, fills, liquidations, identities.known);
  const open = await readHlOpenOrders(original.address),
    openIds = new Set(open.map((order) => order.oid));
  if (open.some((order) => !identities.known.has(order.oid))) {
    throw new ExecutionError(
      "not_ready",
      "An unmanaged venue order requires review before continuing this agent.",
    );
  }
  const first = fills[0]
    ? identified.known.get(fills[0].oid)
    : [...identified.known.values()].find((order) => order.r);
  if (!first) {
    throw new ExecutionError("not_ready", "The owned position has no recoverable protective order identity.");
  }
  const saved = hlOrderRecordSchema.parse({
    ...original,
    role: "exit",
    exitReason: "stop_loss",
    action: { type: "order", orders: [first], grouping: "na" },
    leverage: null,
    beforeExposureUnits: checkpoint.quantity,
    beforeCollateralUnits: checkpoint.collateral,
    beforeCollateralPrincipal: checkpoint.collateralPrincipal,
    beforeCashUnits: checkpoint.cash,
    requestedUnits: checkpoint.quantity,
    account: { ...original.account, time: checkpoint.time },
  });
  const plan = defiPlanSchema.parse(JSON.parse(entry.planJson));
  const result = accountPerpsFills(
    saved,
    observed,
    fills,
    identified.known,
    plan.providerFeeBps,
    identified.forced,
  );
  if (!result) {
    return checkpoint;
  }
  if (
    fills.length === 0 &&
    (result.cashAfter.toString() !== checkpoint.cash ||
      observedIsolatedCollateral(observed).toString() !== checkpoint.collateral)
  ) {
    const funding = await readHlFunding(original.address, checkpoint.time + 1, observed.time);
    const accounting = fundingOnlyAccounting(saved, checkpoint, observed, result, funding);
    await settleNativePerpsExit(
      db,
      entry,
      saved,
      checkpoint,
      accounting,
      observed,
      [],
      openIds,
      identified.known,
      funding,
    );
    await synchronizePerpsInventory(db, userId, agentId);
    return readPerpsCheckpoint(db, userId, agentId);
  }
  if (fills.length > 0) {
    await settleNativePerpsExit(
      db,
      entry,
      saved,
      checkpoint,
      result,
      observed,
      fills,
      openIds,
      identified.known,
    );
    await synchronizePerpsInventory(db, userId, agentId);
    return readPerpsCheckpoint(db, userId, agentId);
  }
  if (result.quantity.toString() !== checkpoint.quantity || result.cashAfter.toString() !== checkpoint.cash) {
    throw new ExecutionError(
      "not_ready",
      "The venue changed without a complete owned fill or transfer record.",
    );
  }
  if (!repair) {
    return checkpoint;
  }
  const protection = await maintainPerpsProtection(db, entry, original, result.quantity, checkpoint);
  const next = {
    ...checkpoint,
    time: observed.time,
    sequence: checkpoint.sequence + 1,
    watermark: protection.watermark,
    stop: protection.protected ? protection.stop : checkpoint.stop,
    orders: [...identities.known.entries()]
      .filter(([oid]) => openIds.has(oid))
      .map(([oid, wire]) => ({ oid, wire })),
  };
  if (
    next.watermark !== checkpoint.watermark ||
    next.stop !== checkpoint.stop ||
    executionHash(next.orders) !== executionHash(checkpoint.orders)
  ) {
    await userTransaction(db, userId, async (tx) => {
      const previous = await readPerpsCheckpoint(tx, userId, agentId);
      if (executionHash(previous) !== executionHash(checkpoint)) {
        throw new ExecutionError("conflict", "Another worker reconciled or tightened this position.");
      }
      await executionEvent(tx, entry, "hl_checkpoint", await databaseTime(tx), next);
    });
    return next;
  }
  return checkpoint;
}
