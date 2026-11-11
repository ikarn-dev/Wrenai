import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { defiPositionClaims } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { positionReservations } from "@/server/db/position-schema";
import { delegatedKeys } from "@/server/db/schema";
import { ExecutionError } from "@/server/execution/contracts";
import {
  executionEvent,
  executionHash,
  invalidateInventory,
  type LedgerAction,
  swapAction,
} from "@/server/execution/records";
import { reserveOwnedInput } from "@/server/positions/execution";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { adoptManualInput, manualAvailableUnits } from "./balances";
import type { ManualEnvelope, ManualTrade } from "./record";

/** Runs only inside the single-use confirmation's owner transaction. No provider I/O. */
export async function reserveManualTrade(
  db: AppDatabase,
  row: ManualTrade,
  envelope: ManualEnvelope,
  now: number,
  expectedSigningKey?: string,
): Promise<LedgerAction> {
  const plan = envelope.plan;
  const swap = envelope.kind === "intents" || envelope.kind === "rhea";
  const [pending] = await db
    .select({ id: executionActions.id })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, row.userId),
        envelope.kind === "rhea"
          ? eq(executionActions.scope, "native_near")
          : eq(executionActions.agentId, row.subjectId),
        isNull(executionActions.reservationReleasedAt),
      ),
    )
    .limit(1);
  if (pending) {
    throw new ExecutionError(
      "conflict",
      "Wait for your previous manual trade to finish before confirming another.",
    );
  }
  const [key] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, row.userId)).limit(1);
  if (!key?.activatedAt || !key.activatedAtBlock) {
    throw new ExecutionError("not_ready", "Connect trading access before confirming this trade.");
  }
  if (expectedSigningKey !== undefined && key.publicKey !== expectedSigningKey) {
    throw new ExecutionError("not_ready", "Trading access changed. Review this payment again.");
  }
  const debits = swap
    ? [{ assetId: envelope.plan.inputAssetId, maxDebitUnits: envelope.plan.inputUnits }]
    : envelope.plan.cash;
  for (const cash of debits) {
    const units =
      envelope.kind === "perps"
        ? await manualAvailableUnits(db, row.userId, row.subjectId, plan.scope, cash.assetId, now)
        : BigInt(cash.maxDebitUnits);
    await adoptManualInput(
      db,
      row.userId,
      row.subjectId,
      plan.scope,
      cash.assetId,
      units,
      envelope.kind === "perps" ? units : BigInt(plan.notionalMicroUsd),
      now,
    );
  }
  const root = envelope.kind === "rhea" ? await activeTradingAccount(db, row.userId) : null;
  if (envelope.kind === "rhea" && (!root?.backupConfirmedAt || root.id !== envelope.prepared.rootId)) {
    throw new ExecutionError("not_ready", "The native trading account changed.");
  }
  const [action] = await db
    .insert(executionActions)
    .values({
      id: randomUUID(),
      userId: row.userId,
      agentId: row.subjectId,
      origin: "manual",
      requestId: row.id,
      planHash: executionHash(plan),
      planJson: JSON.stringify(plan),
      agentRevision: 1,
      strategyVersion: 1,
      policyHash: row.bindingHash,
      scope: plan.scope,
      kind: swap ? "swap" : "defi",
      ...(swap
        ? {
            inputAssetId: envelope.plan.inputAssetId,
            outputAssetId: envelope.plan.outputAssetId,
            inputUnits: BigInt(envelope.plan.inputUnits),
            minOutputUnits: BigInt(envelope.plan.minOutputUnits),
          }
        : {}),
      notionalMicroUsd: BigInt(plan.notionalMicroUsd),
      expiresAt: plan.expiresAt,
      status: "reserved",
      approvedAt: now,
      signingPublicKey:
        envelope.kind === "perps"
          ? envelope.prepared.address
          : envelope.kind === "rhea"
            ? (root?.nativePublicKey ?? "")
            : key.publicKey,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!action) {
    throw new Error("The manual order could not be recorded.");
  }
  if (swap) {
    await reserveOwnedInput(db, swapAction(action));
  } else {
    const positive = debits.filter((cash) => BigInt(cash.maxDebitUnits) > 0n);
    if (positive.length) {
      await db.insert(positionReservations).values(
        positive.map((cash) => ({
          actionId: action.id,
          userId: row.userId,
          agentId: row.subjectId,
          scope: plan.scope,
          assetId: cash.assetId,
          initialUnits: BigInt(cash.maxDebitUnits),
          heldUnits: BigInt(cash.maxDebitUnits),
        })),
      );
    }
    if (envelope.plan.positions.length) {
      await db.insert(defiPositionClaims).values(
        envelope.plan.positions.map((p) => ({
          userId: row.userId,
          scope: plan.scope,
          actionId: action.id,
          positionId: p.positionId,
          venueId: envelope.plan.venueId,
          kind: p.kind,
          instrumentId: p.instrumentId,
        })),
      );
    }
  }
  await executionEvent(
    db,
    action,
    envelope.kind === "intents"
      ? "intents_prepared"
      : envelope.kind === "rhea"
        ? "rhea_prepared"
        : envelope.kind === "perps_funding"
          ? "perps_funding_prepared"
          : envelope.kind === "perps_return"
            ? "perps_return_prepared"
            : envelope.kind === "wallet_return"
              ? "wallet_return_prepared"
              : envelope.kind === "payment"
                ? "payment_prepared"
                : "hl_prepared",
    now,
    envelope.prepared,
  );
  await executionEvent(db, action, "manual_confirmed", now, {
    tradeId: row.id,
    bindingHash: row.bindingHash,
  });
  await invalidateInventory(db, row.userId, plan.scope);
  return action;
}
