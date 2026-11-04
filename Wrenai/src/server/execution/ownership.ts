import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { guardManualAction } from "@/server/manual-trading/guard";
import { recheckLedgerAction } from "./action-policy";
import { ExecutionError, executionPlanSchema, hashSchema } from "./contracts";
import { defiPlanSchema } from "./defi-contracts";
import { requireSwapGuard } from "./guard-swap";
import { markInventoryUncertain } from "./inventory-state";
import { databaseTime, executionEvent, ownedLedgerAction, requireLease } from "./records";

const LEASE_MS = 30_000;

export async function claimExecution(
  db: AppDatabase,
  userId: string,
  actionId: string,
): Promise<{ token: string; mode: "submit" | "reconcile" }> {
  return userTransaction(db, userId, async (tx) => {
    const action = await ownedLedgerAction(tx, userId, actionId);
    const now = await databaseTime(tx);
    if (action.status === "cancelled" || action.status === "settled") {
      throw new ExecutionError("conflict", "This action is already terminal.");
    }
    if (action.leaseExpiresAt !== null && action.leaseExpiresAt > now) {
      throw new ExecutionError("conflict", "Another worker currently owns this action.");
    }
    if (action.status === "reserved") {
      await recheckLedgerAction(tx, action, now, "claim");
    }
    const token = randomUUID();
    await tx
      .update(executionActions)
      .set({ leaseToken: token, leaseExpiresAt: now + LEASE_MS })
      .where(eq(executionActions.id, actionId));
    await executionEvent(tx, action, "worker_claimed", now, {
      mode: action.status === "reserved" ? "submit" : "reconcile",
    });
    return { token, mode: action.status === "reserved" ? "submit" : "reconcile" };
  });
}

/** Persist BEFORE external I/O. Once begun, every takeover is reconciliation-only, never a blind resend. */
export async function beginSubmission(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
  raw: unknown,
): Promise<void> {
  await commitSubmission(db, userId, actionId, token, raw, () => undefined);
}

/** The synchronous signer runs under the owner lock. Its result is returned only after submission state commits. */
export async function commitSignedExecution(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
  raw: unknown,
  sign: () => Buffer,
  validateState?: (tx: AppDatabase) => Promise<void>,
): Promise<Buffer> {
  const signature = await commitSubmission(db, userId, actionId, token, raw, sign, validateState);
  if (signature === undefined) {
    throw new Error("The execution signature was not produced.");
  }
  return signature;
}

async function commitSubmission(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
  raw: unknown,
  sign: () => Buffer | undefined,
  validateState?: (tx: AppDatabase) => Promise<void>,
): Promise<Buffer | undefined> {
  const submission = z.strictObject({ payloadHash: hashSchema, providerRequestId: z.uuid() }).parse(raw);
  return userTransaction(db, userId, async (tx) => {
    const action = await ownedLedgerAction(tx, userId, actionId);
    const now = await databaseTime(tx);
    requireLease(action, token, now);
    if (action.status !== "reserved") {
      throw new ExecutionError(
        "conflict",
        "This action may already have been sent. Reconcile its stored request ID.",
      );
    }
    await recheckLedgerAction(tx, action, now, "submit");
    if (action.origin === "manual") {
      await guardManualAction(tx, action, now, false, submission.payloadHash);
    }
    if (action.kind === "swap" && action.origin === "agent") {
      await requireSwapGuard(
        tx,
        userId,
        executionPlanSchema.parse(JSON.parse(action.planJson)),
        now,
        action.id,
        action.approvedAt !== null,
      );
    }
    if (
      action.kind === "defi" &&
      defiPlanSchema.parse(JSON.parse(action.planJson)).payloadHash !== submission.payloadHash
    ) {
      throw new ExecutionError("conflict", "The submission bytes differ from the reviewed DeFi payload.");
    }
    const beforeCommit = await databaseTime(tx);
    requireLease(action, token, beforeCommit);
    if (action.expiresAt <= beforeCommit) {
      throw new ExecutionError("not_ready", "The quote expired during validation. Create a new plan.");
    }
    await validateState?.(tx);
    const signed = sign();
    await tx
      .update(executionActions)
      .set({ status: "submitting", ...submission, startedAt: now, updatedAt: now })
      .where(eq(executionActions.id, action.id));
    await markInventoryUncertain(tx, action);
    await executionEvent(tx, action, "submission_started", now, submission);
    return signed;
  });
}

export async function recordSubmissionStatus(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
  rawStatus: unknown,
): Promise<void> {
  const status = z.enum(["submitted", "unknown"]).parse(rawStatus);
  await userTransaction(db, userId, async (tx) => {
    const action = await ownedLedgerAction(tx, userId, actionId);
    const now = await databaseTime(tx);
    requireLease(action, token, now);
    if (action.status !== "submitting" && action.status !== "submitted" && action.status !== "unknown") {
      throw new ExecutionError(
        "conflict",
        "Only a started submission can be acknowledged or marked unknown.",
      );
    }
    if (action.status === status) {
      return;
    }
    await tx
      .update(executionActions)
      .set({ status, updatedAt: now })
      .where(eq(executionActions.id, action.id));
    await executionEvent(tx, action, status, now);
  });
}

/** Release a completed bounded worker step so the next five-second status poll can claim immediately. */
export async function releaseExecutionLease(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    const action = await ownedLedgerAction(tx, userId, actionId);
    if (action.status === "settled" || action.status === "cancelled" || action.leaseToken !== token) {
      return;
    }
    // A slow completed read can outlive its lease. Clear only our own token; never clear a takeover's lease.
    await tx
      .update(executionActions)
      .set({ leaseToken: null, leaseExpiresAt: null })
      .where(eq(executionActions.id, actionId));
  });
}
