import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ownedAgent } from "@/server/agents/records";
import { fulfilSetupBudget } from "@/server/agents/setup-binding";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { walletFundings } from "@/server/db/funding-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime, executionHash } from "@/server/execution/records";
import { verifyWalletDeposit } from "@/server/execution/wallet-deposit-proof";
import { readFinalTransaction } from "@/server/near/rpc";
import { assignInventory } from "@/server/positions/attribution";
import { setAgentCapitalLimit } from "@/server/positions/capital-limits";
import { parseUsd, policySchema } from "@/shared/agents";
import {
  fundingIdInputSchema,
  fundingTransactionInputSchema,
  type WalletFundingView,
} from "@/shared/wallet-funding";
import { synchronizePublicToken } from "./public-inventory";
import { ownedWalletFunding, walletFundingView } from "./records";

export function fundingRequestPart(id: string, label: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["wallet-funding:v1", id, label]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function markWalletFundingAttempt(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<WalletFundingView> {
  const { fundingId } = fundingIdInputSchema.parse(raw);
  return userTransaction(db, user.id, async (tx) => {
    const row = await ownedWalletFunding(tx, user.id, fundingId),
      agent = await ownedAgent(tx, user.id, row.agentId),
      now = await databaseTime(tx);
    if (row.state !== "prepared") {
      throw new ExecutionError(
        "conflict",
        "This wallet request may already be open. Recover its transaction instead of sending twice.",
      );
    }
    if (now >= row.expiresAt || agent.status === "running" || agent.version !== row.strategyVersion) {
      throw new ExecutionError("conflict", "Refresh the funding review before opening your wallet.");
    }
    await tx
      .update(walletFundings)
      .set({ state: "wallet_pending", walletAttemptAt: now, updatedAt: now })
      .where(eq(walletFundings.id, row.id));
    return walletFundingView({ ...row, state: "wallet_pending", walletAttemptAt: now, updatedAt: now });
  });
}

export async function confirmWalletDeposit(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<WalletFundingView> {
  const input = fundingTransactionInputSchema.parse(raw),
    saved = await ownedWalletFunding(db, user.id, input.fundingId);
  if (saved.transactionHash !== null) {
    if (saved.transactionHash !== input.transactionHash) {
      throw new ExecutionError(
        "conflict",
        "This funding request already belongs to another wallet transaction.",
      );
    }
    return walletFundingView(saved);
  }
  if (saved.state !== "wallet_pending" || saved.walletAttemptAt === null) {
    throw new ExecutionError(
      "not_ready",
      "Confirm the wallet funding review before submitting a transaction hash.",
    );
  }
  const snapshot = walletFundingView(saved).snapshot;
  verifyWalletDeposit(
    await readFinalTransaction(input.transactionHash, user.accountId),
    snapshot,
    input.transactionHash,
  );
  await synchronizePublicToken(db, user.id, user.accountId, snapshot.assetId);
  return userTransaction(db, user.id, async (tx) => {
    const row = await ownedWalletFunding(tx, user.id, input.fundingId),
      now = await databaseTime(tx);
    if (row.transactionHash !== null) {
      if (row.transactionHash !== input.transactionHash) {
        throw new ExecutionError("conflict", "The deposit proof changed.");
      }
      return walletFundingView(row);
    }
    const agent = await ownedAgent(tx, user.id, row.agentId),
      policy = policySchema.parse(JSON.parse(agent.policyJson));
    if (agent.version !== row.strategyVersion) {
      throw new ExecutionError(
        "conflict",
        "The agent changed during wallet funding. Keep the deposit receipt for recovery.",
      );
    }
    await setAgentCapitalLimit(tx, user.id, {
      requestId: fundingRequestPart(row.id, "limit"),
      agentId: row.agentId,
      amountMicroUsd: parseUsd(policy.budgetUsd).toString(),
    });
    await assignInventory(tx, user.id, {
      requestId: fundingRequestPart(row.id, "deposit"),
      agentId: row.agentId,
      scope: "intents",
      assetId: snapshot.assetId,
      quantityUnits: snapshot.units,
      capitalMicroUsd: snapshot.principalMicroUsd,
      costBasisMicroUsd: null,
      sourceReference: `near:${input.transactionHash}`,
      evidenceHash: executionHash({ snapshot, transactionHash: input.transactionHash }),
    });
    await fulfilSetupBudget(tx, user.id, row.agentId, snapshot.assetId, snapshot.units);
    await tx
      .update(walletFundings)
      .set({ state: "deposited", transactionHash: input.transactionHash, confirmedAt: now, updatedAt: now })
      .where(eq(walletFundings.id, row.id));
    return walletFundingView({
      ...row,
      state: "deposited",
      transactionHash: input.transactionHash,
      confirmedAt: now,
      updatedAt: now,
    });
  });
}
