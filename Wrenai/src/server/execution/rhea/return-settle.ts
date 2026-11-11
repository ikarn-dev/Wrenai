import "server-only";
import { base64 } from "@scure/base";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { chatCipher } from "@/server/chat/cipher";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { nativeSubmissions } from "@/server/db/native-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { finalBlockTime, NearRpcError, readFinalTransaction } from "@/server/near/rpc";
import { previewFifoLots } from "@/server/positions/lots";
import { tokenUnitsSchema } from "@/shared/token-units";
import { ExecutionError } from "../contracts";
import { settleDefiExecution } from "../defi-accounting";
import { claimExecution, releaseExecutionLease } from "../ownership";
import { databaseTime, executionEvent, executionHash, ownedLedgerAction, requireLease } from "../records";
import { cancelReservedExecution } from "../reservations";
import { MAX_NATIVE_GAS_UNITS, NATIVE_GAS_ASSET } from "./contracts";
import { synchronizeNativeInventory } from "./inventory";
import {
  type NativeReturnRecord,
  nativeReturnCall,
  nativeReturnRecord,
  sendNativeReturn,
} from "./return-order";
import { nativeRpc } from "./rpc";

const status = z.union([
  z.object({ SuccessValue: z.string().max(10000) }),
  z.object({ SuccessReceiptId: z.string() }),
  z.object({ Failure: z.unknown() }),
]);
const outcome = z.object({
  id: z.string(),
  outcome: z.object({
    executor_id: z.string(),
    receipt_ids: z.array(z.string()).max(100),
    logs: z.array(z.string().max(16000)).max(500),
    tokens_burnt: tokenUnitsSchema,
    status,
  }),
});
const transferEvent = z.object({
  standard: z.literal("nep141"),
  event: z.literal("ft_transfer"),
  data: z
    .array(z.object({ old_owner_id: z.string(), new_owner_id: z.string(), amount: tokenUnitsSchema }))
    .min(1)
    .max(200),
});
const actionSchema = z.union([
  z.object({ Transfer: z.object({ deposit: tokenUnitsSchema }) }),
  z.object({
    FunctionCall: z.object({
      method_name: z.string(),
      args: z.string().max(12000),
      gas: z.union([z.number().int().safe(), z.string().regex(/^\d+$/)]),
      deposit: tokenUnitsSchema,
    }),
  }),
]);

/** Proves the final transaction is exactly the saved return and reports how much reached the owner. */
export function verifyNativeReturn(
  raw: unknown,
  record: NativeReturnRecord,
  hash: string,
): { delivered: bigint; gas: bigint; blockHash: string } {
  const value = z
    .object({
      final_execution_status: z.literal("FINAL"),
      transaction: z.object({
        hash: z.literal(hash),
        signer_id: z.literal(record.accountId),
        receiver_id: z.string(),
        actions: z.array(actionSchema).min(1).max(2),
      }),
      transaction_outcome: outcome.extend({ block_hash: z.string() }),
      receipts_outcome: z.array(outcome).max(500),
      status,
    })
    .parse(raw);
  const call = nativeReturnCall(record);
  const expected =
    call.kind === "near"
      ? [{ Transfer: { deposit: call.amount } }]
      : call.calls.map((c) => ({ method: c.methodName, args: c.args, gas: c.gas, deposit: c.deposit }));
  const actual = value.transaction.actions.map((action) =>
    "Transfer" in action
      ? { Transfer: { deposit: action.Transfer.deposit } }
      : {
          method: action.FunctionCall.method_name,
          args: JSON.parse(new TextDecoder().decode(base64.decode(action.FunctionCall.args))),
          gas: BigInt(action.FunctionCall.gas).toString(),
          deposit: action.FunctionCall.deposit,
        },
  );
  if (
    value.transaction.receiver_id !== call.receiverId ||
    executionHash(actual) !== executionHash(expected)
  ) {
    throw new ExecutionError(
      "conflict",
      "The return transaction differs from its saved token, amount or recipient.",
    );
  }
  const all = [value.transaction_outcome, ...value.receipts_outcome];
  const gas = all.reduce((sum, item) => sum + BigInt(item.outcome.tokens_burnt), 0n);
  const succeeded = !("Failure" in value.status);
  if (call.kind === "near") {
    return {
      delivered: succeeded ? BigInt(call.amount) : 0n,
      gas,
      blockHash: value.transaction_outcome.block_hash,
    };
  }
  let delivered = 0n;
  for (const item of value.receipts_outcome) {
    if (item.outcome.executor_id !== call.receiverId || "Failure" in item.outcome.status) {
      continue;
    }
    for (const log of item.outcome.logs) {
      const event = log.startsWith("EVENT_JSON:") ? transferEvent.safeParse(JSON.parse(log.slice(11))) : null;
      for (const t of event?.success ? event.data.data : []) {
        if (t.old_owner_id === record.accountId) {
          if (t.new_owner_id !== record.recipient) {
            throw new ExecutionError("conflict", "The return moved tokens to an unexpected account.");
          }
          delivered += BigInt(t.amount);
        }
      }
    }
  }
  if (delivered !== (succeeded ? BigInt(record.units) : 0n)) {
    throw new ExecutionError("conflict", "The final token transfer does not match the saved return amount.");
  }
  return { delivered, gas, blockHash: value.transaction_outcome.block_hash };
}

async function finalReturn(hash: string, accountId: string): Promise<unknown | null> {
  try {
    return await readFinalTransaction(hash, accountId);
  } catch (error) {
    if (error instanceof NearRpcError) {
      return null;
    }
    throw error;
  }
}

async function reconcileNativeReturn(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<void> {
  const action = await ownedLedgerAction(db, userId, actionId),
    record = await nativeReturnRecord(db, action);
  const [journal] = await db
    .select()
    .from(nativeSubmissions)
    .where(and(eq(nativeSubmissions.actionId, actionId), eq(nativeSubmissions.role, "transfer")))
    .limit(1);
  if (!journal) {
    throw new ExecutionError("not_ready", "The signed return journal is unavailable.");
  }
  const raw = await finalReturn(journal.transactionHash, record.accountId);
  if (raw === null) {
    // Same signed bytes, same hash: rebroadcasting cannot create a second transfer.
    const bytes = chatCipher().open(userId, actionId, "native:transfer", journal.sealedTransaction);
    try {
      await nativeRpc("broadcast_tx_async", [bytes]);
    } catch (error) {
      // An RPC refusal proves nothing either way; the next step reads the same hash again.
      if (!(error instanceof ExecutionError)) {
        throw error;
      }
    }
    return;
  }
  const proof = verifyNativeReturn(raw, record, journal.transactionHash);
  if (proof.gas > journal.maximumGasUnits || proof.gas > MAX_NATIVE_GAS_UNITS) {
    throw new ExecutionError("limit", "The return used more network fee than its recorded allowance.");
  }
  const occurredAt = await finalBlockTime(proof.blockHash);
  await userTransaction(db, userId, async (tx) => {
    const row = await ownedLedgerAction(tx, userId, actionId),
      now = await databaseTime(tx);
    requireLease(row, token, now);
    await tx
      .update(nativeSubmissions)
      .set({ spentGasUnits: proof.gas, finalizedAt: now })
      .where(and(eq(nativeSubmissions.actionId, actionId), eq(nativeSubmissions.role, "transfer")));
    await executionEvent(tx, row, "native_return_terminal", now, {
      transactionHash: journal.transactionHash,
      deliveredUnits: proof.delivered.toString(),
      gasUnits: proof.gas.toString(),
    });
    if (proof.delivered === 0n) {
      await tx
        .update(executionActions)
        .set({
          status: "settled",
          settlementHash: executionHash({ hash: journal.transactionHash, delivered: "0" }),
          settlementReceiptId: `near:${journal.transactionHash}`,
          settledAt: now,
          updatedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(executionActions.id, actionId));
      return;
    }
    const lots = await previewFifoLots(
      tx,
      userId,
      action.agentId,
      "native_near",
      record.assetId,
      proof.delivered,
    );
    await settleDefiExecution(tx, userId, actionId, token, {
      providerEventId: `near:${journal.transactionHash}`,
      riskDebitMicroUsd: action.notionalMicroUsd.toString(),
      feeMicroUsd: null,
      cash: [
        {
          assetId: record.assetId,
          debitUnits: proof.delivered.toString(),
          creditUnits: "0",
          creditValueMicroUsd: null,
          creditPrincipalMicroUsd: "0",
        },
      ],
      positions: [],
      retiredPrincipalMicroUsd: lots.principalMicroUsd.toString(),
      borrowedCapitalMicroUsd: "0",
      occurredAt,
    });
  });
  await synchronizeNativeInventory(db, userId, [record.assetId]);
}

/** One bounded step for a trading-account return: sign once, then read the final transaction. */
export async function advanceNativeReturn(
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
    if (action.reservationReleasedAt === null) {
      const record = await nativeReturnRecord(db, action);
      await synchronizeNativeInventory(db, userId, [record.assetId, NATIVE_GAS_ASSET]);
    }
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
  const worker = await claimExecution(db, userId, actionId);
  try {
    if (worker.mode === "submit") {
      await sendNativeReturn(db, action, worker.token);
    }
    await reconcileNativeReturn(db, userId, actionId, worker.token);
  } catch (error) {
    if (
      (await ownedLedgerAction(db, userId, actionId)).status === "reserved" &&
      error instanceof ExecutionError
    ) {
      await cancelReservedExecution(db, userId, actionId);
    }
    throw error;
  } finally {
    await releaseExecutionLease(db, userId, actionId, worker.token);
  }
  return 5;
}
