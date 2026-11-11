import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "@/server/auth/session";
import { agents } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { walletFundings } from "@/server/db/funding-schema";
import { positionLots } from "@/server/db/position-schema";
import { users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { preparePerpsReturn } from "@/server/execution/hyperliquid/return-prepare";
import { createPerpsReturnPreview } from "@/server/execution/hyperliquid/return-preview";
import { databaseTime } from "@/server/execution/records";
import { prepareNativeReturn } from "@/server/execution/rhea/return-order";
import { prepareWalletReturn } from "@/server/execution/wallet-return";
import { settleAgentFunding } from "@/server/funding/cancel";
import { activeNativeFunding } from "@/server/funding/native-records";
import { openWalletFunding } from "@/server/funding/records";
import { releaseInventory } from "@/server/positions/attribution";
import { setAgentCapitalLimit } from "@/server/positions/capital-limits";
import { assignedCapitalLimit } from "@/server/positions/capital-records";
import { CLAIMING_REASON } from "@/shared/claims";
import { AgentError } from "./errors";
import { auditAgent, killSwitchEngaged } from "./records";
import { releaseSetupWalletReservation } from "./setup-binding";

// A settled return that delivered at least one smallest unit (amounts are decimal strings of smallest units).
const returnedUnits = z.object({ amountOut: z.string().regex(/^0*[1-9]\d*$/) });

// Each held token gets a few fresh quotes before the owner is asked to try again.
const MAX_RETURN_ATTEMPTS = 4;
export const DELETED_REASON = "Deleted. Its funds wait in Claims.";

function returnRequestId(...parts: readonly (string | number)[]): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["agent-return:v1", ...parts]))
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What an agent still holds, summed per balance location and token. */
async function heldLots(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<{ scope: (typeof positionLots.$inferSelect)["scope"]; assetId: string; units: string }[]> {
  return db
    .select({
      scope: positionLots.scope,
      assetId: positionLots.assetId,
      units: sql<string>`sum(${positionLots.remainingUnits})::text`,
    })
    .from(positionLots)
    .where(
      and(
        eq(positionLots.userId, userId),
        eq(positionLots.agentId, agentId),
        gt(positionLots.remainingUnits, 0n),
      ),
    )
    .groupBy(positionLots.scope, positionLots.assetId)
    .limit(50);
}
async function pendingAction(db: AppDatabase, userId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        isNull(executionActions.reservationReleasedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
/** An open Perps position can't be returned as a token; its exits keep running on the venue. */
export async function hasOpenPerpsPosition(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: defiPositions.id })
    .from(defiPositions)
    .where(
      and(
        eq(defiPositions.userId, userId),
        eq(defiPositions.agentId, agentId),
        gt(defiPositions.quantityUnits, 0n),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Wallet returns since the claim that settled with funds delivered (a full refund doesn't count). */
async function walletReturnsSince(
  db: AppDatabase,
  userId: string,
  agentId: string,
  since: number,
): Promise<number> {
  // Only wallet returns write this terminal event, so it identifies them without decoding plans.
  const rows = await db
    .select({ detailJson: executionEvents.detailJson })
    .from(executionActions)
    .innerJoin(
      executionEvents,
      and(
        eq(executionEvents.userId, executionActions.userId),
        eq(executionEvents.actionId, executionActions.id),
        eq(executionEvents.kind, "wallet_return_terminal"),
      ),
    )
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        eq(executionActions.status, "settled"),
        gte(executionActions.createdAt, since),
      ),
    )
    .limit(50);
  return rows.filter((row) => returnedUnits.safeParse(JSON.parse(row.detailJson)).success).length;
}

/** Soft-deletes the agent once nothing is held, reserved or still arriving. Returns false otherwise. */
export async function finishAgentDelete(db: AppDatabase, userId: string, agentId: string): Promise<boolean> {
  return userTransaction(db, userId, async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.id, agentId)))
      .limit(1);
    if (!agent || agent.deletedAt !== null) {
      return true;
    }
    const [funding] = await tx
      .select({ id: walletFundings.id })
      .from(walletFundings)
      .where(and(eq(walletFundings.userId, userId), eq(walletFundings.agentId, agentId), openWalletFunding()))
      .limit(1);
    if (
      agent.deleteRequestedAt === null ||
      agent.claimRequestedAt !== null ||
      funding ||
      (await activeNativeFunding(tx, userId))?.snapshot.agentId === agentId ||
      (await heldLots(tx, userId, agentId)).length > 0 ||
      (await pendingAction(tx, userId, agentId)) ||
      (await hasOpenPerpsPosition(tx, userId, agentId))
    ) {
      return false;
    }
    if ((await assignedCapitalLimit(tx, userId, agentId)) > 0n) {
      await setAgentCapitalLimit(tx, userId, {
        requestId: returnRequestId(agentId, agent.deleteRequestedAt, "limit"),
        agentId,
        amountMicroUsd: "0",
      });
    }
    await releaseSetupWalletReservation(tx, userId, agentId);
    const now = await databaseTime(tx);
    await tx
      .update(agents)
      .set({ status: "stopped", revision: agent.revision + 1, updatedAt: now, deletedAt: now })
      .where(eq(agents.id, agentId));
    await auditAgent(
      tx,
      userId,
      agentId,
      "delete",
      "Nothing left to claim. Agent deleted, history retained.",
    );
    return true;
  });
}
/** Ends a claim once nothing is held, reserved or still arriving. Says only what the ledger shows. */
async function finishAgentClaim(db: AppDatabase, userId: string, agentId: string): Promise<boolean> {
  return userTransaction(db, userId, async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.id, agentId)))
      .limit(1);
    if (!agent || agent.claimRequestedAt === null) {
      return true;
    }
    if ((await heldLots(tx, userId, agentId)).length > 0 || (await pendingAction(tx, userId, agentId))) {
      return false;
    }
    const returned = await walletReturnsSince(tx, userId, agentId, agent.claimRequestedAt);
    const reason = returned > 0 ? "Funds claimed to your wallet." : "Nothing left to claim.";
    await tx
      .update(agents)
      .set({ claimRequestedAt: null, reason, updatedAt: await databaseTime(tx) })
      .where(eq(agents.id, agentId));
    await auditAgent(tx, userId, agentId, "claim", reason, { returnedActions: returned });
    return true;
  });
}

async function recordReturnReason(
  db: AppDatabase,
  userId: string,
  agentId: string,
  reason: string,
): Promise<void> {
  await db
    .update(agents)
    .set({ reason: reason.slice(0, 400), updatedAt: Date.now() })
    .where(and(eq(agents.userId, userId), eq(agents.id, agentId), isNull(agents.deletedAt)));
}

/** Prior return attempts for one token since the owner last pressed Claim. */
async function returnAttempts(
  db: AppDatabase,
  userId: string,
  agentId: string,
  since: number,
  scope: string,
  assetId: string,
): Promise<number> {
  const rows = await db
    .select({ planJson: executionActions.planJson })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        eq(executionActions.kind, "defi"),
        gte(executionActions.createdAt, since),
      ),
    )
    .limit(200);
  return rows.filter((row) => {
    const plan = defiPlanSchema.parse(JSON.parse(row.planJson));
    return (
      (plan.walletReturn || plan.returnFunds) &&
      plan.scope === scope &&
      plan.cash.some((c) => c.assetId === assetId)
    );
  }).length;
}

/** Perps venue cash goes back through the reviewed Perps return first; it then returns like private funds. */
async function returnPerpsCash(
  db: AppDatabase,
  user: SessionUser,
  agent: typeof agents.$inferSelect,
  assetId: string,
  units: string,
  requestId: string,
): Promise<string> {
  try {
    const preview = await createPerpsReturnPreview(db, user, {
      agentId: agent.id,
      expectedRevision: agent.revision,
      requestId,
    });
    return (await preparePerpsReturn(db, user, { previewId: preview.id, evidenceHash: preview.evidenceHash }))
      .id;
  } catch (error) {
    if (!(error instanceof ExecutionError) || error.code !== "insufficient_funds") {
      throw error;
    }
    // Below the route minimum. The remainder stays on the agent's venue address, recoverable with the backup.
    await releaseInventory(db, user.id, {
      requestId: returnRequestId(requestId, "dust"),
      agentId: agent.id,
      scope: "hyperliquid",
      assetId,
      quantityUnits: units,
    });
    await auditAgent(
      db,
      user.id,
      agent.id,
      "return_dust_released",
      "Left an amount below the Perps return minimum on the venue.",
      {
        units,
      },
    );
    return "";
  }
}

/** Deletes at once when the agent holds nothing, such as a setup cancelled before funding. */
export async function deleteIfNothingHeld(
  db: AppDatabase,
  user: SessionUser,
  agentId: string,
): Promise<boolean> {
  if (
    (await heldLots(db, user.id, agentId)).length > 0 ||
    (await pendingAction(db, user.id, agentId)) ||
    !(await settleAgentFunding(db, user, agentId))
  ) {
    return false;
  }
  return finishAgentDelete(db, user.id, agentId);
}

export type AgentReturnStep =
  | { readonly kind: "done" }
  | { readonly kind: "wait"; readonly seconds: number }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * One bounded step of a claim or a delete. Both settle pending orders and funding first. A claim then sends each
 * held token to the owner's wallet and ends; a delete finishes once the agent holds nothing, and otherwise leaves
 * its funds waiting in Claims. Safe to repeat: every request ID is deterministic.
 */
export async function advanceAgentReturn(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<AgentReturnStep> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.id, agentId)))
    .limit(1);
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!agent || agent.deletedAt !== null || !owner) {
    return { kind: "done" };
  }
  const since = agent.claimRequestedAt;
  if (since === null && agent.deleteRequestedAt === null) {
    return { kind: "done" };
  }
  const user = { id: userId, accountId: owner.accountId };
  if (since !== null && (await killSwitchEngaged(db, userId))) {
    return {
      kind: "blocked",
      reason: "The global stop is on. Clear it, then press Claim again to send the funds.",
    };
  }
  try {
    const pending = await pendingAction(db, userId, agentId);
    if (pending) {
      const plan = pending.kind === "defi" ? defiPlanSchema.parse(JSON.parse(pending.planJson)) : null;
      // Unsent trades are cancelled; anything already sent is reconciled before its funds can move again.
      const returning = since !== null && (plan?.walletReturn === true || plan?.returnFunds === true);
      await advanceLedgerAction(db, userId, pending.id, returning ? "execute" : "reconcile_only");
      return { kind: "wait", seconds: 5 };
    }
    if (!(await settleAgentFunding(db, user, agentId))) {
      return { kind: "wait", seconds: 5 };
    }
    const lot = (await heldLots(db, userId, agentId))[0];
    if (since === null) {
      // A delete alone never sends funds: with something held, the agent waits in Claims.
      return lot || (await finishAgentDelete(db, userId, agentId))
        ? { kind: "done" }
        : { kind: "wait", seconds: 5 };
    }
    if (await hasOpenPerpsPosition(db, userId, agentId)) {
      return { kind: "blocked", reason: "Close this agent's open Perps position, then press Claim again." };
    }
    if (!lot) {
      if (!(await finishAgentClaim(db, userId, agentId))) {
        return { kind: "wait", seconds: 5 };
      }
      return agent.deleteRequestedAt === null || (await finishAgentDelete(db, userId, agentId))
        ? { kind: "done" }
        : { kind: "wait", seconds: 5 };
    }
    const attempt = await returnAttempts(db, userId, agentId, since, lot.scope, lot.assetId);
    if (attempt >= MAX_RETURN_ATTEMPTS) {
      return { kind: "blocked", reason: "Some funds couldn't be sent yet. Press Claim to try again." };
    }
    // A chosen payout token is part of the request, so changing it never reuses a quote for the old token.
    const payout = lot.scope === "confidential" || lot.scope === "intents" ? agent.returnAssetId : null;
    const requestId =
      payout === null
        ? returnRequestId(agentId, since, lot.scope, lot.assetId, attempt)
        : returnRequestId(agentId, since, lot.scope, lot.assetId, attempt, payout);
    if (attempt === 0) {
      await recordReturnReason(db, userId, agentId, CLAIMING_REASON);
    }
    const actionId =
      lot.scope === "hyperliquid"
        ? // A Perps preview lives 15 seconds; a new minute gets a fresh one if the last one expired unused.
          await returnPerpsCash(
            db,
            user,
            agent,
            lot.assetId,
            lot.units,
            returnRequestId(requestId, Math.floor(Date.now() / 60_000)),
          )
        : lot.scope === "native_near"
          ? (await prepareNativeReturn(db, userId, agentId, lot.assetId, requestId)).id
          : (await prepareWalletReturn(db, userId, agentId, lot.scope, lot.assetId, requestId, payout)).id;
    if (actionId) {
      await advanceLedgerAction(db, userId, actionId, "execute");
    }
    return { kind: "wait", seconds: 5 };
  } catch (error) {
    if (error instanceof ExecutionError || error instanceof AgentError || error instanceof z.ZodError) {
      await recordReturnReason(
        db,
        userId,
        agentId,
        `${since === null ? "Deleting" : "Claiming funds"}: ${error instanceof z.ZodError ? "a provider reply could not be checked." : error.message}`,
      );
      return { kind: "wait", seconds: 15 };
    }
    throw error;
  }
}
