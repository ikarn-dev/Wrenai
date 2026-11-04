import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionReceipts } from "@/server/db/defi-schema";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { manualTrades } from "@/server/db/manual-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { synchronizePerpsInventory } from "@/server/execution/hyperliquid/account-state";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { databaseTime, executionHash } from "@/server/execution/records";
import { synchronizeNativeInventory } from "@/server/execution/rhea/inventory";
import {
  type ManualPreview,
  manualConfirmationSchema,
  manualQuoteInputSchema,
} from "@/shared/manual-trading";
import { prepareManualPerps } from "./perps";
import { prepareManualPerpsDeposit } from "./perps-funding";
import { prepareManualPerpsReturn } from "./perps-return";
import { manualEnvelope, manualEnvelopeSchema, ownedManualTrade } from "./record";
import { reserveManualTrade } from "./reserve";
import { prepareManualRhea } from "./rhea";
import { prepareManualSpot } from "./spot";
import { manualSubject } from "./subject";

export async function readManualPreview(db: AppDatabase, userId: string, id: string): Promise<ManualPreview> {
  const row = await ownedManualTrade(db, userId, id),
    envelope = manualEnvelope(row);
  if (row.actionId) {
    const [action] = await db
      .select({
        status: executionActions.status,
        kind: executionActions.kind,
        inputUnits: executionActions.inputUnits,
      })
      .from(executionActions)
      .where(and(eq(executionActions.id, row.actionId), eq(executionActions.userId, userId)))
      .limit(1);
    if (!action) {
      throw new ExecutionError("conflict", "The confirmed order is unavailable.");
    }
    if (action.status === "settled" && action.kind === "swap") {
      const [filled] = await db
        .select({
          input: sql<string>`coalesce(sum(${executionFills.inputUnits}),0)::text`,
          output: sql<string>`coalesce(sum(${executionFills.outputUnits}),0)::text`,
        })
        .from(executionFills)
        .where(and(eq(executionFills.actionId, row.actionId), eq(executionFills.userId, userId)));
      const spent = filled?.input ?? "0",
        received = filled?.output ?? "0";
      return {
        ...envelope.preview,
        status: spent === "0" ? "refunded" : "settled",
        actionId: row.actionId,
        execution: {
          spentUnits: spent,
          receivedUnits: received,
          refundedUnits: ((action.inputUnits ?? 0n) - BigInt(spent)).toString(),
        },
      };
    }
    if (action.status === "settled" && action.kind === "defi") {
      const [receipt] = await db
        .select({ id: executionReceipts.id })
        .from(executionReceipts)
        .where(and(eq(executionReceipts.actionId, row.actionId), eq(executionReceipts.userId, userId)))
        .limit(1);
      if (!receipt) {
        return {
          ...envelope.preview,
          status: envelope.kind === "perps" ? "no_fill" : "refunded",
          actionId: row.actionId,
        };
      }
    }
    return { ...envelope.preview, status: action.status, actionId: row.actionId };
  }
  return {
    ...envelope.preview,
    status: row.status === "cancelled" ? "cancelled" : row.expiresAt <= Date.now() ? "expired" : "quoted",
  };
}
export async function quoteManualTrade(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<ManualPreview> {
  const input = manualQuoteInputSchema.parse(raw),
    intentHash = executionHash(input.intent);
  if (
    input.source !== "jarvis" &&
    input.source !== (input.intent.kind === "perps_funding" ? "perps" : input.intent.kind)
  ) {
    throw new ExecutionError("conflict", "Choose the matching trading page.");
  }
  const [repeated] = await db
    .select()
    .from(manualTrades)
    .where(and(eq(manualTrades.userId, userId), eq(manualTrades.requestId, input.requestId)))
    .limit(1);
  if (repeated) {
    if (repeated.intentHash !== intentHash) {
      throw new ExecutionError("conflict", "This request already belongs to a different trade.");
    }
    return readManualPreview(db, userId, repeated.id);
  }
  const subjectId = await manualSubject(db, userId);
  const envelope =
    input.intent.kind === "spot"
      ? input.intent.balance === "native_near"
        ? await prepareManualRhea(db, userId, input.requestId, subjectId, input.intent)
        : await prepareManualSpot(db, userId, input.requestId, subjectId, input.intent)
      : input.intent.kind === "perps_funding"
        ? input.intent.direction === "deposit"
          ? await prepareManualPerpsDeposit(db, userId, input.requestId, subjectId, input.intent)
          : await prepareManualPerpsReturn(db, userId, input.requestId, subjectId, input.intent)
        : await prepareManualPerps(db, userId, input.requestId, subjectId, input.intent);
  const { bindingHash: _binding, ...bound } = envelope.preview;
  const bindingHash = executionHash({ preview: bound, plan: envelope.plan, prepared: envelope.prepared });
  const saved = manualEnvelopeSchema.parse({ ...envelope, preview: { ...envelope.preview, bindingHash } });
  await userTransaction(db, userId, async (tx) => {
    const now = await databaseTime(tx);
    if (saved.plan.expiresAt <= now || saved.plan.expiresAt > now + 300_000) {
      throw new ExecutionError("not_ready", "The quote expired while preparing. Request a fresh quote.");
    }
    const [existing] = await tx
      .select()
      .from(manualTrades)
      .where(and(eq(manualTrades.userId, userId), eq(manualTrades.requestId, input.requestId)))
      .limit(1);
    if (existing) {
      if (existing.intentHash !== intentHash) {
        throw new ExecutionError("conflict", "This request belongs to another trade.");
      }
      return;
    }
    await tx.insert(manualTrades).values({
      id: input.requestId,
      userId,
      subjectId,
      requestId: input.requestId,
      intentHash,
      intentJson: JSON.stringify(input.intent),
      previewJson: JSON.stringify(saved),
      bindingHash,
      source: input.source,
      status: "quoted",
      revision: 1,
      expiresAt: saved.plan.expiresAt,
      createdAt: now,
    });
  });
  return readManualPreview(db, userId, input.requestId);
}
export async function confirmManualTrade(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<ManualPreview> {
  const input = manualConfirmationSchema.parse(raw),
    initial = await ownedManualTrade(db, userId, input.id);
  if (initial.bindingHash !== input.bindingHash || initial.revision !== input.revision) {
    throw new ExecutionError("conflict", "Review the current quote before confirming.");
  }
  if (initial.status === "confirmed") {
    return readManualPreview(db, userId, initial.id);
  }
  const envelope = manualEnvelope(initial);
  if (initial.status !== "quoted" || initial.expiresAt <= Date.now()) {
    throw new ExecutionError("not_ready", "This quote expired or was dismissed. Review a fresh quote.");
  }
  if (envelope.kind === "intents") {
    await synchronizePrivateInventory(db, userId);
  } else if (envelope.kind === "rhea") {
    await synchronizeNativeInventory(db, userId, [envelope.plan.inputAssetId, envelope.plan.outputAssetId]);
  } else {
    await synchronizePerpsInventory(db, userId, initial.subjectId);
    if (envelope.kind !== "perps") {
      await synchronizePrivateInventory(db, userId);
    }
  }
  await userTransaction(db, userId, async (tx) => {
    const row = await ownedManualTrade(tx, userId, input.id),
      now = await databaseTime(tx);
    if (row.status === "confirmed") {
      return;
    }
    if (
      row.status !== "quoted" ||
      row.expiresAt <= now ||
      row.bindingHash !== input.bindingHash ||
      row.revision !== input.revision
    ) {
      throw new ExecutionError("conflict", "The quote expired or changed. Review it again.");
    }
    const action = await reserveManualTrade(tx, row, manualEnvelope(row), now);
    const consumed = await tx
      .update(manualTrades)
      .set({ status: "confirmed", actionId: action.id, confirmedAt: now })
      .where(
        and(
          eq(manualTrades.id, row.id),
          eq(manualTrades.userId, userId),
          eq(manualTrades.status, "quoted"),
          eq(manualTrades.revision, input.revision),
          eq(manualTrades.bindingHash, input.bindingHash),
        ),
      )
      .returning({ id: manualTrades.id });
    if (consumed.length !== 1) {
      throw new ExecutionError("conflict", "This confirmation was already consumed.");
    }
  });
  return readManualPreview(db, userId, input.id);
}
export async function dismissManualTrade(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const input = manualConfirmationSchema.parse(raw);
  await userTransaction(db, userId, async (tx) => {
    const row = await ownedManualTrade(tx, userId, input.id);
    if (
      row.status === "cancelled" &&
      row.bindingHash === input.bindingHash &&
      row.revision === input.revision
    ) {
      return;
    }
    if (
      row.bindingHash !== input.bindingHash ||
      row.revision !== input.revision ||
      row.status === "confirmed"
    ) {
      throw new ExecutionError("conflict", "A confirmed trade cannot be dismissed or undone.");
    }
    await tx
      .update(manualTrades)
      .set({ status: "cancelled" })
      .where(and(eq(manualTrades.id, row.id), eq(manualTrades.userId, userId)));
  });
}
