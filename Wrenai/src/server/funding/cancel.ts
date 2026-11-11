import "server-only";
import { and, eq } from "drizzle-orm";
import { auditAgent } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { walletFundings } from "@/server/db/funding-schema";
import { nativeDeposits } from "@/server/db/native-funding-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime } from "@/server/execution/records";
import { directNativeFunding, fundingIdInputSchema } from "@/shared/wallet-funding";
import { proveNativeFunding } from "./native-lifecycle";
import { activeNativeFunding, ownedNativeFunding } from "./native-records";
import { advanceFundingRecord, keepFundingPublic } from "./progress";
import { openWalletFunding, ownedWalletFunding, walletFundingView } from "./records";

/**
 * The wallet reported that the owner declined the deposit. Close the request so a fresh review can replace it.
 * Deposits go only to the owner's own accounts, so a transaction that was sent anyway stays the owner's.
 */
export async function releaseWalletAttempt(db: AppDatabase, owner: string, raw: unknown): Promise<void> {
  const { fundingId } = fundingIdInputSchema.parse(raw);
  await userTransaction(db, owner, async (tx) => {
    const row = await ownedWalletFunding(tx, owner, fundingId);
    if (row.state === "abandoned") {
      return;
    }
    if (row.state !== "wallet_pending" || row.transactionHash !== null) {
      throw new ExecutionError("conflict", "This deposit already has a transaction. Check it instead.");
    }
    await tx
      .update(walletFundings)
      .set({ state: "abandoned", updatedAt: await databaseTime(tx) })
      .where(eq(walletFundings.id, row.id));
    await auditAgent(tx, owner, row.agentId, "wallet_funding_declined", "The wallet deposit was cancelled.", {
      fundingId: row.id,
    });
  });
}

/** The same for a public-route deposit step: the declined step can be retried, earlier proven steps stay. */
export async function releaseNativeAttempt(
  db: AppDatabase,
  owner: string,
  id: string,
  snapshotHash: string,
): Promise<void> {
  await userTransaction(db, owner, async (tx) => {
    const row = await ownedNativeFunding(tx, owner, id);
    if (row.snapshotHash !== snapshotHash) {
      throw new ExecutionError("conflict", "The deposit review changed.");
    }
    const previous =
      row.state === "gas_pending" && row.gasHash === null
        ? "prepared"
        : row.state === "token_pending" && row.tokenHash === null
          ? "gas_confirmed"
          : null;
    if (previous === null) {
      if (row.state === "prepared" || row.state === "gas_confirmed") {
        return;
      }
      throw new ExecutionError("conflict", "This deposit step already has a transaction. Check it instead.");
    }
    // The attempt time stays; the next approval records a fresh one, and older transactions can't prove it.
    await tx
      .update(nativeDeposits)
      .set({ state: previous })
      .where(and(eq(nativeDeposits.id, row.id), eq(nativeDeposits.userId, owner)));
  });
}

/**
 * Settles an agent's unfinished funding before delete. Unsent or declined deposits are discarded; a confirmed
 * deposit stays assigned so it is returned with the agent's other funds. Returns false while one is still moving.
 */
export async function settleAgentFunding(
  db: AppDatabase,
  user: SessionUser,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(walletFundings)
    .where(and(eq(walletFundings.userId, user.id), eq(walletFundings.agentId, agentId), openWalletFunding()))
    .limit(1);
  if (row?.state === "converting") {
    await advanceFundingRecord(db, user.id, row.id);
    return false;
  }
  if (row?.state === "deposited" && directNativeFunding(walletFundingView(row).snapshot)) {
    // The NEAR is on its way to the private balance: wait for it, then it's returned with the rest.
    await advanceFundingRecord(db, user.id, row.id);
    return false;
  }
  if (row?.state === "deposited") {
    await keepFundingPublic(db, user.id, row.id);
  } else if (row) {
    await userTransaction(db, user.id, async (tx) => {
      const current = await ownedWalletFunding(tx, user.id, row.id);
      if (
        current.transactionHash !== null ||
        (current.state !== "prepared" && current.state !== "wallet_pending")
      ) {
        throw new ExecutionError("conflict", "The deposit changed. Try deleting again.");
      }
      // An unopened review is removed; an opened wallet request is kept as abandoned history.
      if (current.state === "prepared") {
        await tx.delete(walletFundings).where(eq(walletFundings.id, current.id));
      } else {
        await tx
          .update(walletFundings)
          .set({ state: "abandoned", updatedAt: await databaseTime(tx) })
          .where(eq(walletFundings.id, current.id));
      }
      await auditAgent(tx, user.id, agentId, "wallet_funding_discarded", "Unfinished deposit discarded.", {
        fundingId: current.id,
        state: current.state,
      });
    });
  }
  const native = await activeNativeFunding(db, user.id);
  if (native?.snapshot.agentId !== agentId) {
    return true;
  }
  const saved = await ownedNativeFunding(db, user.id, native.snapshot.id);
  if (saved.state === "token_pending" && saved.tokenHash !== null) {
    // The token transfer is already verified on chain: finish crediting it so it can be returned.
    await proveNativeFunding(db, user, {
      id: saved.id,
      snapshotHash: saved.snapshotHash,
      role: "token",
      transactionHash: saved.tokenHash,
    });
    return false;
  }
  await userTransaction(db, user.id, async (tx) => {
    const current = await ownedNativeFunding(tx, user.id, saved.id);
    if (current.state === "complete" || current.state === "cancelled") {
      return;
    }
    await tx
      .update(nativeDeposits)
      .set({ state: "cancelled" })
      .where(and(eq(nativeDeposits.id, current.id), eq(nativeDeposits.userId, user.id)));
    await auditAgent(tx, user.id, agentId, "native_funding_discarded", "Unfinished deposit discarded.", {
      fundingId: current.id,
      state: current.state,
    });
  });
  return true;
}
