import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { auditAgent, ownedAgent, ownedAgentSummary } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { executionReceipts } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { walletFundings } from "@/server/db/funding-schema";
import { positionLots } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime, ownedLedgerAction } from "@/server/execution/records";
import { instructionFundingAsset } from "@/shared/agent-instructions";
import { type AgentFundingState, directNativeFunding } from "@/shared/wallet-funding";
import { settleDirectFunding } from "./direct-funding";
import { linkedAgentBudget, openWalletFunding, ownedWalletFunding, walletFundingView } from "./records";

export async function readFundingState(
  db: AppDatabase,
  user: SessionUser,
  agentId: string,
): Promise<AgentFundingState> {
  const agent = await ownedAgentSummary(db, user.id, agentId);
  const [setup, key, rows, lots] = await Promise.all([
    linkedAgentBudget(db, user.id, agentId),
    readDelegatedKey(user),
    db
      .select()
      .from(walletFundings)
      .where(
        and(eq(walletFundings.userId, user.id), eq(walletFundings.agentId, agentId), openWalletFunding()),
      )
      .limit(1),
    db
      .select({ scope: positionLots.scope, units: sql<string>`sum(${positionLots.remainingUnits})::text` })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, user.id),
          eq(positionLots.agentId, agentId),
          eq(
            positionLots.assetId,
            "format" in agent.strategy ? (instructionFundingAsset(agent.strategy) ?? "") : "",
          ),
          gt(positionLots.remainingUnits, 0n),
        ),
      )
      .groupBy(positionLots.scope),
  ]);
  return {
    authorized: key.checked && key.state.kind === "active",
    budget: setup.budget ?? null,
    funding: rows[0] ? walletFundingView(rows[0]) : null,
    allocatedPrivateUnits: lots.find((row) => row.scope === "confidential")?.units ?? "0",
    allocatedPublicUnits: lots.find((row) => row.scope === "intents")?.units ?? "0",
  };
}

/** Bounded workflow step. A confirmed submission is never retried as a new external transfer. */
export async function advanceFundingRecord(
  db: AppDatabase,
  owner: string,
  fundingId: string,
): Promise<boolean> {
  const row = await ownedWalletFunding(db, owner, fundingId);
  if (row.state === "deposited" && directNativeFunding(walletFundingView(row).snapshot)) {
    return settleDirectFunding(db, owner, fundingId);
  }
  if (row.state !== "converting" || !row.actionId) {
    return false;
  }
  await advanceLedgerAction(db, owner, row.actionId);
  const action = await ownedLedgerAction(db, owner, row.actionId);
  if (action.reservationReleasedAt === null) {
    return true;
  }
  await userTransaction(db, owner, async (tx) => {
    const latest = await ownedWalletFunding(tx, owner, fundingId);
    if (latest.actionId !== action.id || latest.state !== "converting") {
      return;
    }
    const now = await databaseTime(tx);
    const [receipt] = await tx
      .select({ id: executionReceipts.id })
      .from(executionReceipts)
      .where(and(eq(executionReceipts.userId, owner), eq(executionReceipts.actionId, action.id)))
      .limit(1);
    const complete = action.status === "settled" && receipt !== undefined;
    await tx
      .update(walletFundings)
      .set({ state: complete ? "complete" : "deposited", updatedAt: now })
      .where(eq(walletFundings.id, row.id));
  });
  return false;
}
export async function discardFundingReview(db: AppDatabase, owner: string, fundingId: string): Promise<void> {
  await userTransaction(db, owner, async (tx) => {
    const row = await ownedWalletFunding(tx, owner, fundingId);
    if (row.state !== "prepared" || row.walletAttemptAt !== null) {
      throw new ExecutionError(
        "not_ready",
        "A wallet transfer may already be pending. Recover its transaction instead of sending again.",
      );
    }
    await tx.delete(walletFundings).where(eq(walletFundings.id, row.id));
  });
}

/** Close only an unsent/reconciled conversion. Public funds retain their ownership and can be released in allocations. */
export async function keepFundingPublic(db: AppDatabase, owner: string, fundingId: string): Promise<void> {
  await userTransaction(db, owner, async (tx) => {
    const row = await ownedWalletFunding(tx, owner, fundingId),
      agent = await ownedAgent(tx, owner, row.agentId);
    if (row.state === "complete") {
      return;
    }
    const [pending] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, owner),
          eq(executionActions.agentId, row.agentId),
          isNull(executionActions.reservationReleasedAt),
        ),
      )
      .limit(1);
    if (directNativeFunding(walletFundingView(row).snapshot)) {
      throw new ExecutionError(
        "not_ready",
        "This deposit goes straight to the private balance. Wait for it to arrive.",
      );
    }
    if (row.state !== "deposited" || !row.confirmedAt || agent.status === "running" || pending) {
      throw new ExecutionError(
        "not_ready",
        "Reconcile the funding transfer before keeping its funds public.",
      );
    }
    const now = await databaseTime(tx);
    await tx
      .update(walletFundings)
      .set({ state: "complete", updatedAt: now })
      .where(eq(walletFundings.id, row.id));
    await auditAgent(
      tx,
      owner,
      row.agentId,
      "wallet_funding_kept_public",
      "Stopped private funding. Funds remain assigned in the public Intents balance.",
      { fundingId: row.id, transactionHash: row.transactionHash },
    );
  });
}
