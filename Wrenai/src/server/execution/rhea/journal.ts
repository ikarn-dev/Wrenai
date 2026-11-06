import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { KeyType } from "@near-js/crypto";
import { actionCreators, createTransaction, Signature, SignedTransaction } from "@near-js/transactions";
import { base58 } from "@scure/base";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { chatCipher } from "@/server/chat/cipher";
import type { AppDatabase } from "@/server/db/client";
import { nativeSubmissions } from "@/server/db/native-schema";
import { positionLots } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { guardManualAction } from "@/server/manual-trading/guard";
import { callViewFunction, viewNearBudgetBalance } from "@/server/near/rpc";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { tokenUnitsSchema } from "@/shared/token-units";
import { currentAgentStrategy } from "../asset-review";
import { ExecutionError, executionPlanSchema } from "../contracts";
import { requireSwapGuard } from "../guard-swap";
import { instructionSubmissionCheck } from "../instruction-reference";
import { commitSignedExecution, recordSubmissionStatus } from "../ownership";
import { recheckExecution } from "../policy";
import { databaseTime, type ExecutionAction, executionEvent, ownedExecution, requireLease } from "../records";
import { nativeAuthority } from "./authority";
import {
  DCL_SWAP_GAS,
  MAX_NATIVE_GAS_UNITS,
  NATIVE_GAS_ASSET,
  type RheaPrepared,
  rheaSwapCall,
} from "./contracts";
import { quoteRhea, rheaTradeQuote } from "./quote";
import { nativeRpc, nativeSigningState } from "./rpc";

export async function readNativeSubmission(
  db: AppDatabase,
  actionId: string,
  role: "registration" | "swap",
): Promise<typeof nativeSubmissions.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(nativeSubmissions)
    .where(and(eq(nativeSubmissions.actionId, actionId), eq(nativeSubmissions.role, role)))
    .limit(1);
  return row ?? null;
}
export async function sendNativeCall(
  db: AppDatabase,
  action: ExecutionAction,
  token: string,
  prepared: RheaPrepared,
  role: "registration" | "swap",
): Promise<void> {
  if (await readNativeSubmission(db, action.id, role)) {
    return;
  }
  const key = await nativeAuthority(db, action.userId, prepared);
  const [state, gas, fresh, inputBalance] = await Promise.all([
    nativeSigningState(prepared.accountId, key.getPublicKey().toString()),
    viewNearBudgetBalance(prepared.accountId, false),
    quoteRhea(
      prepared.quote.input,
      prepared.quote.output,
      prepared.quote.inputUnits,
      prepared.quote.slippageBps,
      prepared.quote.poolId,
    ),
    callViewFunction(prepared.quote.input.assetId.slice(7), "ft_balance_of", {
      account_id: prepared.accountId,
    }).then((result) => BigInt(tokenUnitsSchema.parse(result.value))),
  ]);
  const registration = await readNativeSubmission(db, action.id, "registration");
  const registrationSpent = registration?.spentGasUnits ?? 0n;
  const maximumRemaining =
    MAX_NATIVE_GAS_UNITS -
    registrationSpent -
    (registration?.finalizedAt ? BigInt(prepared.registrationDeposit ?? "0") : 0n);
  const requiredGas = state.gasPrice * (role === "swap" ? DCL_SWAP_GAS : DCL_SWAP_GAS + 30000000000000n) * 2n;
  const requiredDeposit = role === "registration" ? BigInt(prepared.registrationDeposit ?? "0") : 1n;
  if (
    maximumRemaining <= 0n ||
    gas.spendable < maximumRemaining ||
    BigInt(fresh.minimumOutputUnits) < BigInt(prepared.quote.minimumOutputUnits) ||
    requiredGas + requiredDeposit > maximumRemaining
  ) {
    throw new ExecutionError(
      "not_ready",
      "The native fee reserve or current minimum output no longer covers this quote.",
    );
  }
  const current =
    action.origin === "agent"
      ? await currentAgentStrategy(db, action.userId, action.agentId, action.agentRevision)
      : null;
  const check = current
    ? await instructionSubmissionCheck(
        db,
        current,
        prepared.signal,
        rheaTradeQuote(fresh, prepared.accountId),
        action.id,
      )
    : null;
  const signed = await userTransaction(db, action.userId, async (tx) => {
    if (await readNativeSubmission(tx, action.id, role)) {
      return null;
    }
    const saved = await ownedExecution(tx, action.userId, action.id),
      now = await databaseTime(tx),
      root = await activeTradingAccount(tx, action.userId);
    requireLease(saved, token, now);
    // Registration can quarantine the common snapshot before the token swap. Recheck actual FT inventory independently for each stage.
    const allocations = await tx
      .select({
        assetId: positionLots.assetId,
        units: sql<string>`sum(${positionLots.remainingUnits})::text`,
      })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, saved.userId),
          eq(positionLots.scope, "native_near"),
          inArray(positionLots.assetId, [saved.inputAssetId, NATIVE_GAS_ASSET]),
        ),
      )
      .groupBy(positionLots.assetId);
    const allocated = (assetId: string): bigint =>
      BigInt(allocations.find((row) => row.assetId === assetId)?.units ?? "0");
    if (
      inputBalance < allocated(saved.inputAssetId) ||
      inputBalance < saved.inputUnits ||
      gas.spendable < allocated(NATIVE_GAS_ASSET) + maximumRemaining
    ) {
      throw new ExecutionError(
        "insufficient_funds",
        "The native balance no longer covers all manual and agent allocations.",
      );
    }
    if (
      !root?.backupConfirmedAt ||
      root.id !== prepared.rootId ||
      root.nativePublicKey !== saved.signingPublicKey ||
      now - state.observedAt >= 15000 ||
      now >= saved.expiresAt
    ) {
      throw new ExecutionError("not_ready", "The native account, signing observation or quote changed.");
    }
    if (saved.origin === "manual") {
      await guardManualAction(tx, saved, now, false);
    } else {
      const plan = executionPlanSchema.parse(JSON.parse(saved.planJson));
      await recheckExecution(tx, saved, plan, now);
      await requireSwapGuard(tx, saved.userId, plan, now, saved.id, true);
    }
    await check?.(tx);
    const prior = await readNativeSubmission(tx, action.id, "registration");
    if (role === "swap" && prepared.registrationDeposit !== null && prior?.finalizedAt == null) {
      throw new ExecutionError("not_ready", "Wait for token registration before submitting the swap.");
    }
    const [last] = await tx
      .select()
      .from(nativeSubmissions)
      .where(eq(nativeSubmissions.rootId, prepared.rootId))
      .orderBy(desc(nativeSubmissions.nonce))
      .limit(1);
    const nonce = state.nonce >= (last?.nonce ?? 0n) ? state.nonce + 1n : (last?.nonce ?? 0n) + 1n;
    const call =
      role === "swap"
        ? rheaSwapCall(prepared)
        : {
            receiverId: prepared.quote.output.assetId.slice(7),
            methodName: "storage_deposit",
            args: { account_id: prepared.accountId, registration_only: true },
            gas: "30000000000000",
            deposit: prepared.registrationDeposit ?? "0",
          };
    const transaction = createTransaction(
      prepared.accountId,
      key.getPublicKey(),
      call.receiverId,
      nonce,
      [actionCreators.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit))],
      base58.decode(state.blockHash),
    );
    const hash = createHash("sha256").update(transaction.encode()).digest();
    const bytes = Buffer.from(
      new SignedTransaction({
        transaction,
        signature: new Signature({ keyType: KeyType.ED25519, data: key.sign(hash).signature }),
      }).encode(),
    );
    await tx.insert(nativeSubmissions).values({
      actionId: saved.id,
      role,
      userId: saved.userId,
      rootId: root.id,
      accountId: root.nativeAccountId,
      publicKey: root.nativePublicKey,
      nonce,
      blockHash: state.blockHash,
      transactionHash: base58.encode(hash),
      sealedTransaction: chatCipher().seal(
        saved.userId,
        saved.id,
        `native:${role}`,
        bytes.toString("base64"),
      ),
      maximumGasUnits: MAX_NATIVE_GAS_UNITS,
      createdAt: now,
    });
    if (saved.status === "reserved") {
      await commitSignedExecution(
        tx,
        saved.userId,
        saved.id,
        token,
        { payloadHash: prepared.payloadHash, providerRequestId: randomUUID() },
        () => bytes,
      );
    } else if (!["submitting", "submitted", "unknown"].includes(saved.status)) {
      throw new ExecutionError("conflict", "The native action is no longer submittable.");
    }
    await executionEvent(tx, saved, "native_signed", now, {
      role,
      transactionHash: base58.encode(hash),
      nonce: nonce.toString(),
    });
    return bytes;
  });
  if (!signed) {
    return;
  }
  try {
    await nativeRpc("broadcast_tx_async", [signed.toString("base64")]);
    await recordSubmissionStatus(db, action.userId, action.id, token, "submitted");
  } catch {
    // An RPC timeout cannot prove rejection. Recovery only queries the recorded transaction hash.
    await recordSubmissionStatus(db, action.userId, action.id, token, "unknown");
  } finally {
    signed.fill(0);
  }
}
