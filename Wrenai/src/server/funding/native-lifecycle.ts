import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ownedAgent } from "@/server/agents/records";
import { fulfilSetupBudget } from "@/server/agents/setup-binding";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { nativeDeposits } from "@/server/db/native-funding-schema";
import { positionLots } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { assetUsdPrice } from "@/server/engine/instruction-price";
import { ExecutionError } from "@/server/execution/contracts";
import { observedInventoryBalance } from "@/server/execution/inventory";
import { databaseTime } from "@/server/execution/records";
import { synchronizeNativeInventory } from "@/server/execution/rhea/inventory";
import { finalBlockTime, readFinalTransaction } from "@/server/near/rpc";
import { assignInventory } from "@/server/positions/attribution";
import { setAgentCapitalLimit } from "@/server/positions/capital-limits";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { parseUsd, policySchema } from "@/shared/agents";
import { type NativeFundingView, nativeFundingCommandSchema } from "@/shared/native-funding";
import { fundingRequestPart } from "./deposit";
import { verifyNativeFunding } from "./native-proof";
import { nativeFundingView, ownedNativeFunding } from "./native-records";

export async function beginNativeFunding(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<NativeFundingView> {
  const input = nativeFundingCommandSchema.parse(raw);
  if (input.transactionHash) {
    throw new ExecutionError("conflict", "A new wallet attempt cannot contain a completed transaction.");
  }
  return userTransaction(db, user.id, async (tx) => {
    const row = await ownedNativeFunding(tx, user.id, input.id),
      view = nativeFundingView(row),
      now = await databaseTime(tx),
      root = await activeTradingAccount(tx, user.id);
    if (
      row.snapshotHash !== input.snapshotHash ||
      root?.id !== view.snapshot.rootId ||
      !root.backupConfirmedAt ||
      view.snapshot.accountId !== user.accountId
    ) {
      throw new ExecutionError("conflict", "The wallet or funding review changed.");
    }
    if (
      input.role === "gas" ? row.state !== "prepared" || now >= row.expiresAt : row.state !== "gas_confirmed"
    ) {
      throw new ExecutionError(
        "conflict",
        "This step was already attempted. Verify its transaction hash before continuing.",
      );
    }
    const [saved] = await tx
      .update(nativeDeposits)
      .set({ state: input.role === "gas" ? "gas_pending" : "token_pending", attemptedAt: now })
      .where(and(eq(nativeDeposits.id, row.id), eq(nativeDeposits.state, row.state)))
      .returning();
    if (!saved) {
      throw new ExecutionError("conflict", "The funding step changed.");
    }
    return nativeFundingView(saved);
  });
}
export async function proveNativeFunding(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<NativeFundingView> {
  const input = nativeFundingCommandSchema.parse(raw),
    row = await ownedNativeFunding(db, user.id, input.id),
    view = nativeFundingView(row);
  if (!input.transactionHash || input.snapshotHash !== row.snapshotHash) {
    throw new ExecutionError("conflict", "Supply this funding step's transaction hash.");
  }
  const pendingState = input.role === "gas" ? "gas_pending" : "token_pending";
  const knownHash = input.role === "gas" ? row.gasHash : row.tokenHash;
  if (knownHash && knownHash !== input.transactionHash) {
    throw new ExecutionError("conflict", "This funding step already has a different transaction.");
  }
  if (knownHash && row.state !== pendingState) {
    return view;
  }
  if (row.state !== pendingState) {
    throw new ExecutionError("conflict", "This transaction does not belong to the pending funding step.");
  }
  const rawReceipt = await readFinalTransaction(input.transactionHash, user.accountId),
    block = verifyNativeFunding(rawReceipt, view.snapshot, input.transactionHash, input.role),
    at = await finalBlockTime(block);
  if (row.attemptedAt === null || at < row.attemptedAt - 1000) {
    throw new ExecutionError("conflict", "This transaction predates the reviewed funding step.");
  }
  if (input.role === "token" && knownHash === null) {
    await recordVerifiedTokenHash(db, user.id, row.id, input.transactionHash);
  }
  const fundingValue =
    input.role === "token" && view.snapshot.agentId ? await nativeFundingValue(view.snapshot) : null;
  if (input.role === "token") {
    await synchronizeNativeInventory(db, user.id, [view.snapshot.assetId]);
  }
  return userTransaction(db, user.id, async (tx) => {
    const current = await ownedNativeFunding(tx, user.id, input.id),
      snapshot = nativeFundingView(current).snapshot,
      now = await databaseTime(tx);
    if (
      current.state !== pendingState &&
      (input.role === "gas" ? current.gasHash : current.tokenHash) === input.transactionHash
    ) {
      return nativeFundingView(current);
    }
    if (current.state !== row.state || current.snapshotHash !== input.snapshotHash) {
      throw new ExecutionError("conflict", "The funding step changed before its proof was saved.");
    }
    if (input.role === "token") {
      if (snapshot.agentId) {
        if (!fundingValue || (fundingValue.observedAt !== null && now - fundingValue.observedAt >= 15000)) {
          throw new ExecutionError(
            "not_ready",
            "Refresh the funding valuation before assigning the native budget.",
          );
        }
        const agent = await ownedAgent(tx, user.id, snapshot.agentId);
        const policy = policySchema.parse(JSON.parse(agent.policyJson));
        await setAgentCapitalLimit(tx, user.id, {
          requestId: fundingRequestPart(snapshot.id, "native-limit"),
          agentId: snapshot.agentId,
          amountMicroUsd: parseUsd(policy.budgetUsd).toString(),
        });
        await assignInventory(tx, user.id, {
          requestId: snapshot.id,
          agentId: snapshot.agentId,
          scope: "native_near",
          assetId: snapshot.assetId,
          quantityUnits: snapshot.units,
          costBasisMicroUsd: null,
          capitalMicroUsd: fundingValue.microUsd,
          evidenceHash: current.snapshotHash,
          sourceReference: `near:${input.transactionHash}`,
        });
        await fulfilSetupBudget(tx, user.id, snapshot.agentId, snapshot.assetId, snapshot.units);
      } else {
        const balance = await observedInventoryBalance(tx, user.id, "native_near", snapshot.assetId, now);
        const [owned] = await tx
          .select({ units: sql<string>`coalesce(sum(${positionLots.remainingUnits}), 0)::text` })
          .from(positionLots)
          .where(
            and(
              eq(positionLots.userId, user.id),
              eq(positionLots.scope, "native_near"),
              eq(positionLots.assetId, snapshot.assetId),
            ),
          );
        if (balance < BigInt(snapshot.units) + BigInt(owned?.units ?? "0")) {
          throw new ExecutionError(
            "not_ready",
            "Reconcile the native balance before crediting this deposit.",
          );
        }
        await tx.insert(positionLots).values({
          id: randomUUID(),
          userId: user.id,
          agentId: snapshot.subjectId,
          scope: "native_near",
          assetId: snapshot.assetId,
          sourceId: snapshot.id,
          sourceKind: "allocation",
          initialUnits: BigInt(snapshot.units),
          remainingUnits: BigInt(snapshot.units),
          initialBasisMicroUsd: null,
          remainingBasisMicroUsd: null,
          initialPrincipalMicroUsd: 0n,
          remainingPrincipalMicroUsd: 0n,
          openedAt: now,
        });
      }
    }
    const [saved] = await tx
      .update(nativeDeposits)
      .set(
        input.role === "gas"
          ? { gasHash: input.transactionHash, state: "gas_confirmed" }
          : { tokenHash: input.transactionHash, state: "complete", completedAt: now },
      )
      .where(eq(nativeDeposits.id, input.id))
      .returning();
    if (!saved) {
      throw new Error("The native funding proof could not be saved.");
    }
    return nativeFundingView(saved);
  });
}

async function recordVerifiedTokenHash(
  db: AppDatabase,
  owner: string,
  id: string,
  hash: string,
): Promise<void> {
  await userTransaction(db, owner, async (tx) => {
    const row = await ownedNativeFunding(tx, owner, id);
    if (row.tokenHash === hash) {
      return;
    }
    if (row.state !== "token_pending" || row.tokenHash !== null) {
      throw new ExecutionError("conflict", "The pending token transfer changed.");
    }
    await tx.update(nativeDeposits).set({ tokenHash: hash }).where(eq(nativeDeposits.id, id));
  });
}

async function nativeFundingValue(
  snapshot: NativeFundingView["snapshot"],
): Promise<{ microUsd: string; observedAt: number | null }> {
  if (snapshot.principalMicroUsd) {
    return { microUsd: snapshot.principalMicroUsd, observedAt: null };
  }
  const price = await assetUsdPrice(snapshot.assetId);
  const denominator = 10n ** BigInt(snapshot.decimals) * price.d;
  const principal = (BigInt(snapshot.units) * price.n * 1_000_000n + denominator - 1n) / denominator;
  return { microUsd: principal.toString(), observedAt: price.observedAt };
}
