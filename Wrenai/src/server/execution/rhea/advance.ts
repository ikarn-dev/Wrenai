import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { nativeSubmissions } from "@/server/db/native-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { finalBlockTime, NearRpcError, readFinalTransaction } from "@/server/near/rpc";
import { recordExecutionFill, settleExecution } from "../accounting";
import { ExecutionError } from "../contracts";
import { claimExecution, releaseExecutionLease } from "../ownership";
import { databaseTime, executionEvent, ownedExecution, requireLease } from "../records";
import { cancelReservedExecution } from "../reservations";
import { MAX_NATIVE_GAS_UNITS, type RheaPrepared } from "./contracts";
import { synchronizeNativeInventory } from "./inventory";
import { readNativeSubmission, sendNativeCall } from "./journal";
import { readRheaPrepared } from "./order";
import { verifyNativeOutcome } from "./proof";

async function readFinal(hash: string, account: string): Promise<unknown | null> {
  try {
    return await readFinalTransaction(hash, account);
  } catch (error) {
    if (error instanceof NearRpcError) {
      return null;
    }
    throw error;
  }
}
async function recordNativeFee(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
  role: "registration" | "swap",
  gas: bigint,
): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    const action = await ownedExecution(tx, userId, actionId),
      now = await databaseTime(tx);
    requireLease(action, token, now);
    const row = await readNativeSubmission(tx, actionId, role);
    if (!row || (row.spentGasUnits !== null && row.spentGasUnits !== gas)) {
      throw new ExecutionError("conflict", "The native fee receipt differs from its saved transaction.");
    }
    if (row.finalizedAt !== null) {
      return;
    }
    await tx
      .update(nativeSubmissions)
      .set({ spentGasUnits: gas, finalizedAt: now })
      .where(and(eq(nativeSubmissions.actionId, actionId), eq(nativeSubmissions.role, role)));
    await executionEvent(tx, action, "native_fee_recorded", now, {
      role,
      transactionHash: row.transactionHash,
      gasUnits: gas.toString(),
    });
  });
}
async function settleNative(
  db: AppDatabase,
  userId: string,
  id: string,
  token: string,
  prepared: RheaPrepared,
  raw: unknown | null,
): Promise<void> {
  const action = await ownedExecution(db, userId, id),
    swap = await readNativeSubmission(db, id, "swap");
  if (swap && raw === null) {
    throw new ExecutionError("not_ready", "The signed swap must be reconciled before releasing funds.");
  }
  const proof =
    swap && raw
      ? verifyNativeOutcome(raw, prepared, swap.transactionHash, "swap")
      : { used: 0n, output: 0n, gas: 0n };
  const registration = await readNativeSubmission(db, id, "registration");
  if (
    proof.gas + (registration?.spentGasUnits ?? 0n) + BigInt(prepared.registrationDeposit ?? "0") >
    MAX_NATIVE_GAS_UNITS
  ) {
    throw new ExecutionError(
      "limit",
      "The final native fee exceeded its recorded allowance. Review the transaction before releasing holds.",
    );
  }
  if (proof.used > 0n && raw && swap) {
    const block = z.object({ transaction_outcome: z.object({ block_hash: z.string() }) }).parse(raw);
    const occurredAt = await finalBlockTime(block.transaction_outcome.block_hash);
    await recordExecutionFill(db, userId, id, token, {
      providerEventId: `near:${swap.transactionHash}:swap`,
      inputUnits: proof.used.toString(),
      outputUnits: proof.output.toString(),
      inputValueMicroUsd: (
        (action.notionalMicroUsd * proof.used + action.inputUnits - 1n) /
        action.inputUnits
      ).toString(),
      feeMicroUsd: null,
      occurredAt,
    });
  }
  if (swap) {
    await recordNativeFee(db, userId, id, token, "swap", proof.gas);
  }
  await settleExecution(db, userId, id, token, {
    providerReceiptId: `near:${swap?.transactionHash ?? registration?.transactionHash ?? id}:final`,
    refundedInputUnits: (action.inputUnits - proof.used).toString(),
  });
  await synchronizeNativeInventory(db, userId, [action.inputAssetId, action.outputAssetId]);
}

export async function advanceRheaAction(
  db: AppDatabase,
  userId: string,
  id: string,
  mode: "execute" | "reconcile_only",
): Promise<number> {
  const action = await ownedExecution(db, userId, id);
  if (action.status === "cancelled") {
    return 60;
  }
  if (action.status === "settled") {
    if (action.reservationReleasedAt === null) {
      await synchronizeNativeInventory(db, userId, [action.inputAssetId, action.outputAssetId]);
    }
    return 5;
  }
  const now = await databaseTime(db);
  if (action.status === "reserved" && (mode === "reconcile_only" || now >= action.expiresAt)) {
    await cancelReservedExecution(db, userId, id);
    return 5;
  }
  if (action.approvedAt === null || (action.leaseExpiresAt !== null && action.leaseExpiresAt > now)) {
    return 5;
  }
  const worker = await claimExecution(db, userId, id),
    prepared = await readRheaPrepared(db, action);
  try {
    const swap = await readNativeSubmission(db, id, "swap");
    if (swap) {
      const raw = await readFinal(swap.transactionHash, prepared.accountId);
      if (raw) {
        await settleNative(db, userId, id, worker.token, prepared, raw);
      }
      return 5;
    }
    const registration = await readNativeSubmission(db, id, "registration");
    if (registration) {
      const raw = await readFinal(registration.transactionHash, prepared.accountId);
      if (!raw) {
        return 5;
      }
      const proof = verifyNativeOutcome(raw, prepared, registration.transactionHash, "registration");
      await recordNativeFee(db, userId, id, worker.token, "registration", proof.gas);
      if (!proof.succeeded || mode === "reconcile_only" || Date.now() >= action.expiresAt) {
        await settleNative(db, userId, id, worker.token, prepared, null);
        return 5;
      }
    } else if (prepared.registrationDeposit !== null) {
      if (mode === "execute") {
        await sendNativeCall(db, action, worker.token, prepared, "registration");
      }
      return 5;
    }
    if (mode === "execute") {
      await sendNativeCall(db, action, worker.token, prepared, "swap");
    }
  } catch (error) {
    const latest = await ownedExecution(db, userId, id);
    if (latest.status === "reserved" && error instanceof ExecutionError) {
      await cancelReservedExecution(db, userId, id);
    } else if (
      error instanceof ExecutionError &&
      ["not_ready", "insufficient_funds", "limit"].includes(error.code) &&
      !(await readNativeSubmission(db, id, "swap"))
    ) {
      const registration = await readNativeSubmission(db, id, "registration");
      if (registration?.finalizedAt !== null && registration !== null) {
        await settleNative(db, userId, id, worker.token, prepared, null);
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  } finally {
    await releaseExecutionLease(db, userId, id, worker.token);
  }
  return 5;
}
