import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { positionLots } from "@/server/db/position-schema";
import { delegatedKeys, users } from "@/server/db/schema";
import { ExecutionError, type ExecutionScope } from "@/server/execution/contracts";
import { availableInventory, observedInventoryBalance } from "@/server/execution/inventory";
import { executionHash, type LedgerAction } from "@/server/execution/records";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { manualEnvelope, ownedManualTrade } from "./record";
import { requireManualSubject } from "./subject";

async function requireAllocatedInventory(
  db: AppDatabase,
  action: LedgerAction,
  scope: ExecutionScope,
  assetId: string,
  now: number,
): Promise<void> {
  const balance = await observedInventoryBalance(db, action.userId, scope, assetId, now);
  const [allocated] = await db
    .select({ units: sql<string>`coalesce(sum(${positionLots.remainingUnits}),0)::text` })
    .from(positionLots)
    .where(
      and(
        eq(positionLots.userId, action.userId),
        eq(positionLots.scope, scope),
        eq(positionLots.assetId, assetId),
      ),
    );
  if (balance < BigInt(allocated?.units ?? "0")) {
    throw new ExecutionError(
      "insufficient_funds",
      "The balance no longer covers all manual and agent allocations. Reconcile the shortfall before trading.",
    );
  }
}

export async function guardManualAction(
  db: AppDatabase,
  action: LedgerAction,
  now: number,
  submitting: boolean,
  payloadHash?: string,
): Promise<void> {
  if (action.origin !== "manual") {
    throw new ExecutionError("conflict", "This is not a manual order.");
  }
  const trade = await ownedManualTrade(db, action.userId, action.requestId),
    envelope = manualEnvelope(trade);
  await requireManualSubject(db, action.userId, action.agentId);
  if (
    trade.status !== "confirmed" ||
    trade.actionId !== action.id ||
    trade.confirmedAt === null ||
    action.approvedAt !== trade.confirmedAt ||
    action.policyHash !== trade.bindingHash ||
    action.planHash !== executionHash(envelope.plan) ||
    action.planJson !== JSON.stringify(envelope.plan) ||
    action.agentId !== trade.subjectId ||
    action.expiresAt !== trade.expiresAt ||
    now >= action.expiresAt
  ) {
    throw new ExecutionError(
      "conflict",
      "This order no longer matches its single-use confirmation. Review a fresh quote.",
    );
  }
  const expectedPayload =
    envelope.kind === "intents" || envelope.kind === "rhea"
      ? envelope.prepared.payloadHash
      : envelope.plan.payloadHash;
  if (payloadHash !== undefined && payloadHash !== expectedPayload) {
    throw new ExecutionError("conflict", "The signing payload differs from the confirmed trade.");
  }
  const [key] = await db
    .select()
    .from(delegatedKeys)
    .where(and(eq(delegatedKeys.userId, action.userId)))
    .limit(1);
  if (!key?.activatedAt || !key.activatedAtBlock) {
    throw new ExecutionError("not_ready", "Trading access has been revoked. Reconnect it before trading.");
  }
  if (envelope.kind === "intents") {
    if (
      action.scope !== "confidential" ||
      action.kind !== "swap" ||
      action.signingPublicKey !== key.publicKey
    ) {
      throw new ExecutionError("conflict", "The trading permission differs from this quote.");
    }
  } else if (envelope.kind === "rhea") {
    const root = await activeTradingAccount(db, action.userId);
    if (
      !root?.backupConfirmedAt ||
      root.id !== envelope.prepared.rootId ||
      root.nativePublicKey !== action.signingPublicKey ||
      action.scope !== "native_near" ||
      action.kind !== "swap"
    ) {
      throw new ExecutionError("not_ready", "The backed-up native trading account changed or was revoked.");
    }
  } else if (envelope.kind === "payment") {
    const intent = envelope.preview.intent;
    if (
      intent.kind !== "payment" ||
      action.scope !== "confidential" ||
      action.kind !== "defi" ||
      action.signingPublicKey !== key.publicKey ||
      envelope.plan.operation !== "transfer" ||
      envelope.prepared.recipient !== intent.recipient ||
      envelope.plan.recipient !== intent.recipient ||
      envelope.plan.cash[0]?.assetId !== intent.assetId ||
      envelope.prepared.destination !== "confidential"
    ) {
      throw new ExecutionError(
        "conflict",
        "The payment differs from its confirmed recipient, token or permission.",
      );
    }
  } else if (envelope.kind === "wallet_return") {
    // Only to the owner's own wallet, from the private balance, with the shared key the card was confirmed with.
    const [owner] = await db
      .select({ accountId: users.accountId })
      .from(users)
      .where(eq(users.id, action.userId))
      .limit(1);
    if (
      action.scope !== "confidential" ||
      action.kind !== "defi" ||
      action.signingPublicKey !== key.publicKey ||
      !envelope.plan.walletReturn ||
      owner?.accountId !== envelope.plan.recipient ||
      envelope.prepared.recipient !== envelope.plan.recipient ||
      envelope.prepared.payoutAssetId !== envelope.plan.payoutAssetId
    ) {
      throw new ExecutionError("conflict", "The return differs from its confirmed wallet or permission.");
    }
  } else if (envelope.kind === "perps_funding" || envelope.kind === "perps_return") {
    const root = await activeTradingAccount(db, action.userId),
      address = await readAgentTradingAccount(db, action.userId, action.agentId);
    const recipient =
      envelope.kind === "perps_funding" ? envelope.prepared.recipient : envelope.prepared.address;
    if (
      !root?.backupConfirmedAt ||
      root.backupVersion < 2 ||
      !address ||
      address.rootId !== root.id ||
      address.perpAddress !== recipient ||
      action.signingPublicKey !== key.publicKey
    ) {
      throw new ExecutionError("not_ready", "The manual funding address or permission changed.");
    }
  } else {
    const root = await activeTradingAccount(db, action.userId),
      address = await readAgentTradingAccount(db, action.userId, action.agentId);
    if (
      !root?.backupConfirmedAt ||
      !address ||
      address.rootId !== root.id ||
      root.backupVersion < 2 ||
      address.perpAddress !== action.signingPublicKey ||
      envelope.prepared.address !== address.perpAddress ||
      executionHash(envelope.instruction) !== envelope.prepared.instructionHash
    ) {
      throw new ExecutionError("not_ready", "The backed-up manual trading address changed or was revoked.");
    }
  }
  if (!submitting) {
    return;
  }
  if ("cash" in envelope.plan) {
    for (const cash of envelope.plan.cash) {
      if (BigInt(cash.maxDebitUnits) > 0n) {
        await requireAllocatedInventory(db, action, cash.scope ?? action.scope, cash.assetId, now);
      }
      if ((await availableInventory(db, action.userId, cash.scope ?? action.scope, cash.assetId, now)) < 0n) {
        throw new ExecutionError("insufficient_funds", "The balance no longer covers all reserved orders.");
      }
    }
  } else {
    await requireAllocatedInventory(db, action, action.scope, envelope.plan.inputAssetId, now);
    if ((await availableInventory(db, action.userId, action.scope, envelope.plan.inputAssetId, now)) < 0n) {
      throw new ExecutionError("insufficient_funds", "The balance no longer covers all reserved orders.");
    }
  }
}
