import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { previewFifoLots } from "@/server/positions/lots";
import { NEAR_TX_HASH } from "@/shared/manual-trading";
import { submitConfidentialTransfer } from "./confidential-transfer";
import { ExecutionError } from "./contracts";
import { settleDefiExecution } from "./defi-accounting";
import { defiPlanSchema } from "./defi-contracts";
import {
  confirmedStatusQuote,
  intentsStatusSchema,
  readIntentsProviderStatus,
} from "./intents-reconciliation";
import { quoteMicroUsd } from "./oneclick-quote";
import { claimExecution, releaseExecutionLease } from "./ownership";
import {
  databaseTime,
  executionEvent,
  executionHash,
  type LedgerAction,
  ownedLedgerAction,
  requireLease,
} from "./records";
import { cancelReservedExecution } from "./reservations";
import { syncReturnBalance, verifiedWalletReturnQuote, walletReturnRecord } from "./wallet-return";

async function ownerAccount(db: AppDatabase, userId: string): Promise<string> {
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!owner) {
    throw new ExecutionError("not_found", "The account for this return is unavailable.");
  }
  return owner.accountId;
}
function returnScope(action: LedgerAction): "confidential" | "intents" {
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson));
  if (!plan.walletReturn || (plan.scope !== "confidential" && plan.scope !== "intents")) {
    throw new ExecutionError("conflict", "This action is not a private or Intents wallet return.");
  }
  return plan.scope;
}

async function executeWalletReturn(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<void> {
  const action = await ownedLedgerAction(db, userId, actionId);
  if (action.kind !== "defi" || action.status !== "reserved") {
    throw new ExecutionError("not_ready", "Only an unsent reserved return may be signed.");
  }
  returnScope(action);
  const saved = await walletReturnRecord(db, action);
  await submitConfidentialTransfer(
    db,
    action,
    token,
    saved.order,
    (accountId) => verifiedWalletReturnQuote(action, saved, accountId, Date.now()),
    // The commit recheck already requires the owner's pending delete, the owner recipient and the exact plan.
    async () => {},
    "wallet_return_submitted",
  );
}

const terminalSchema = z.strictObject({
  amountIn: z.string(),
  amountOut: z.string(),
  refundedAmount: z.string(),
  status: z.enum(["SUCCESS", "REFUNDED"]),
  destinationTxHashes: z.array(NEAR_TX_HASH).max(20),
  intentHashes: z.array(z.string()).min(1).max(100),
  occurredAt: z.number().int().positive(),
});

/** Settles only on the provider's final accounting. Funds stay reserved while delivery is unproven. */
async function reconcileWalletReturn(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<"pending" | "settled"> {
  const action = await ownedLedgerAction(db, userId, actionId),
    scope = returnScope(action),
    accountId = await ownerAccount(db, userId);
  const plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
    cash = plan.cash[0];
  if (!cash) {
    throw new ExecutionError("conflict", "The return input is missing.");
  }
  if (action.status === "settled") {
    if (action.reservationReleasedAt === null) {
      await syncReturnBalance(db, userId, accountId, scope, cash.assetId);
    }
    return "settled";
  }
  requireLease(action, token, await databaseTime(db));
  if (!["submitting", "submitted", "unknown"].includes(action.status)) {
    throw new ExecutionError("not_ready", "Only a submitted return can be reconciled.");
  }
  const saved = await walletReturnRecord(db, action);
  const status = intentsStatusSchema.parse(await readIntentsProviderStatus(saved.order.depositAddress));
  const quote = verifiedWalletReturnQuote(
    action,
    {
      ...saved,
      order: {
        ...saved.order,
        providerQuote: confirmedStatusQuote(saved.order.providerQuote, status.quoteResponse),
      },
    },
    accountId,
    null,
  );
  if (status.status !== "SUCCESS" && status.status !== "REFUNDED") {
    return "pending";
  }
  const details = status.swapDetails,
    occurredAt = Date.parse(status.updatedAt);
  const hashes = details.destinationChainTxHashes?.map((tx) => tx.hash) ?? [];
  if (details.amountOut !== undefined && BigInt(details.amountOut) > 0n && hashes.length === 0) {
    // Final status can arrive before the public payout reference. Keep the funds reserved and check again.
    return "pending";
  }
  if (
    occurredAt > Date.now() + 1000 ||
    details.amountIn === undefined ||
    details.amountOut === undefined ||
    details.refundedAmount === undefined ||
    details.depositedAmount !== cash.maxDebitUnits ||
    BigInt(details.amountIn) + BigInt(details.refundedAmount) !== BigInt(cash.maxDebitUnits) ||
    details.intentHashes.length === 0 ||
    (BigInt(details.amountIn) === 0n) !== (BigInt(details.amountOut) === 0n) ||
    (status.status === "SUCCESS" &&
      (details.refundedAmount !== "0" || BigInt(details.amountOut) < BigInt(quote.minOutputUnits))) ||
    (BigInt(details.amountOut) > 0n && (hashes.length === 0 || new Set(hashes).size !== hashes.length))
  ) {
    throw new ExecutionError(
      "not_ready",
      "The provider has not fully accounted for this return and its wallet delivery yet. Funds stay reserved.",
    );
  }
  const evidence = terminalSchema.parse({
    amountIn: details.amountIn,
    amountOut: details.amountOut,
    refundedAmount: details.refundedAmount,
    status: status.status,
    destinationTxHashes: hashes.toSorted(),
    intentHashes: details.intentHashes.toSorted(),
    occurredAt,
  });
  await userTransaction(db, userId, async (tx) => {
    const row = await ownedLedgerAction(tx, userId, actionId),
      now = await databaseTime(tx);
    requireLease(row, token, now);
    const [previous] = await tx
      .select()
      .from(executionEvents)
      .where(and(eq(executionEvents.actionId, actionId), eq(executionEvents.kind, "wallet_return_terminal")))
      .limit(1);
    if (previous && executionHash(JSON.parse(previous.detailJson)) !== executionHash(evidence)) {
      throw new ExecutionError("conflict", "A different final return receipt was already recorded.");
    }
    if (!previous) {
      await executionEvent(tx, row, "wallet_return_terminal", now, evidence);
    }
    const debit = BigInt(evidence.amountIn);
    if (debit === 0n) {
      // A full refund leaves the funds where they were; the delete flow prepares a fresh return.
      await tx
        .update(executionActions)
        .set({
          status: "settled",
          settlementHash: executionHash(evidence),
          settlementReceiptId: `oneclick:${saved.order.depositAddress}`,
          settledAt: now,
          updatedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(executionActions.id, actionId));
      return;
    }
    const lots = await previewFifoLots(tx, userId, action.agentId, scope, cash.assetId, debit);
    const value = details.amountInUsd ? quoteMicroUsd(details.amountInUsd, true) : 0n;
    await settleDefiExecution(tx, userId, actionId, token, {
      providerEventId: `oneclick:${saved.order.depositAddress}`,
      riskDebitMicroUsd: (value > 0n ? value : action.notionalMicroUsd).toString(),
      feeMicroUsd: null,
      cash: [
        {
          assetId: cash.assetId,
          debitUnits: evidence.amountIn,
          creditUnits: "0",
          creditValueMicroUsd: null,
          creditPrincipalMicroUsd: "0",
        },
      ],
      positions: [],
      // The principal leaves the agent with the funds; the owner holds them again.
      retiredPrincipalMicroUsd: lots.principalMicroUsd.toString(),
      borrowedCapitalMicroUsd: "0",
      occurredAt,
    });
  });
  await syncReturnBalance(db, userId, accountId, scope, cash.assetId);
  return "settled";
}

/** One bounded step for a private or Intents wallet return: sign once, then reconcile until final. */
export async function advanceWalletReturn(
  db: AppDatabase,
  userId: string,
  actionId: string,
  mode: "execute" | "reconcile_only",
): Promise<number> {
  const action = await ownedLedgerAction(db, userId, actionId);
  if (action.status === "cancelled") {
    return 60;
  }
  if (action.status === "settled") {
    await reconcileWalletReturn(db, userId, actionId, "");
    return 5;
  }
  const now = await databaseTime(db);
  if (action.status === "reserved" && (action.expiresAt <= now || mode === "reconcile_only")) {
    await cancelReservedExecution(db, userId, actionId);
    return 5;
  }
  if (action.leaseExpiresAt !== null && action.leaseExpiresAt > now) {
    return 5;
  }
  let worker: Awaited<ReturnType<typeof claimExecution>> | null = null;
  try {
    worker = await claimExecution(db, userId, actionId);
    if (worker.mode === "submit") {
      await executeWalletReturn(db, userId, actionId, worker.token);
    }
    await reconcileWalletReturn(db, userId, actionId, worker.token);
  } catch (error) {
    // An unsent return is released so a fresh quote can replace it. A submitted one stays reserved.
    if (
      (await ownedLedgerAction(db, userId, actionId)).status === "reserved" &&
      error instanceof ExecutionError
    ) {
      await cancelReservedExecution(db, userId, actionId);
    }
    throw error;
  } finally {
    if (worker) {
      await releaseExecutionLease(db, userId, actionId, worker.token);
    }
  }
  return 5;
}
