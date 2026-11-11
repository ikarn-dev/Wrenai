import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { KeyType } from "@near-js/crypto";
import {
  type Action,
  actionCreators,
  createTransaction,
  Signature,
  SignedTransaction,
} from "@near-js/transactions";
import { base58 } from "@scure/base";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ownedAgent } from "@/server/agents/records";
import { chatCipher } from "@/server/chat/cipher";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { nativeSubmissions } from "@/server/db/native-schema";
import { positionLots } from "@/server/db/position-schema";
import { users } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { callViewFunction, viewNearBudgetBalance } from "@/server/near/rpc";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { activeTradingAccount, tradingAccountSigningKeys } from "@/server/trading-accounts/vault";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "@/shared/token-units";
import { ExecutionError, hashSchema } from "../contracts";
import { defiPlanSchema, WALLET_RETURN_VENUES } from "../defi-contracts";
import { reserveDefiExecution } from "../defi-reservations";
import { commitSignedExecution, recordSubmissionStatus } from "../ownership";
import { confirmExecutionPermission } from "../permissions";
import {
  databaseTime,
  executionEvent,
  executionHash,
  type LedgerAction,
  ownedLedgerAction,
  requireLease,
} from "../records";
import { MAX_NATIVE_GAS_UNITS, NATIVE_GAS_ASSET } from "./contracts";
import { synchronizeNativeInventory } from "./inventory";
import { nativeRpc, nativeSigningState } from "./rpc";

const FT_TRANSFER_GAS = 30_000_000_000_000n;
const NEAR_TRANSFER_GAS = 5_000_000_000_000n;
// Token storage registration for the owner's wallet: 0.0125 NEAR covers every standard NEP-145 token.
const MAX_REGISTRATION_DEPOSIT = 12_500_000_000_000_000_000_000n;

export const nativeReturnRecordSchema = z.strictObject({
  format: z.literal(1),
  rootId: z.uuid(),
  accountId: z.string().regex(/^[a-f0-9]{64}$/),
  publicKey: z.string().min(10).max(120),
  recipient: z.string().min(2).max(64),
  assetId: z.string().min(3).max(180),
  units: positiveTokenUnitsSchema,
  registrationDeposit: positiveTokenUnitsSchema.nullable(),
  payloadHash: hashSchema,
});
export type NativeReturnRecord = z.infer<typeof nativeReturnRecordSchema>;
type ReturnCall =
  | { readonly kind: "near"; readonly receiverId: string; readonly amount: string }
  | {
      readonly kind: "ft";
      readonly receiverId: string;
      readonly calls: readonly {
        readonly methodName: string;
        readonly args: Readonly<Record<string, string | boolean>>;
        readonly gas: string;
        readonly deposit: string;
      }[];
    };

/** The exact transaction a native return signs: a NEAR transfer, or an optional registration plus ft_transfer. */
export function nativeReturnCall(
  record: Omit<NativeReturnRecord, "payloadHash"> | NativeReturnRecord,
): ReturnCall {
  if (record.assetId === NATIVE_GAS_ASSET) {
    return { kind: "near", receiverId: record.recipient, amount: record.units };
  }
  return {
    kind: "ft",
    receiverId: record.assetId.slice(7),
    calls: [
      ...(record.registrationDeposit === null
        ? []
        : [
            {
              methodName: "storage_deposit",
              args: { account_id: record.recipient, registration_only: true },
              gas: FT_TRANSFER_GAS.toString(),
              deposit: record.registrationDeposit,
            },
          ]),
      {
        methodName: "ft_transfer",
        args: { receiver_id: record.recipient, amount: record.units, memo: "Wrenai agent return" },
        gas: FT_TRANSFER_GAS.toString(),
        deposit: "1",
      },
    ],
  };
}
function transactionActions(call: ReturnCall): Action[] {
  return call.kind === "near"
    ? [actionCreators.transfer(BigInt(call.amount))]
    : call.calls.map((c) =>
        actionCreators.functionCall(c.methodName, c.args, BigInt(c.gas), BigInt(c.deposit)),
      );
}
function attachedGas(call: ReturnCall): bigint {
  return call.kind === "near" ? NEAR_TRANSFER_GAS : call.calls.reduce((sum, c) => sum + BigInt(c.gas), 0n);
}

async function registrationDeposit(contract: string, recipient: string): Promise<string | null> {
  const balance = z
    .object({ total: tokenUnitsSchema })
    .nullable()
    .parse((await callViewFunction(contract, "storage_balance_of", { account_id: recipient })).value);
  if (balance !== null) {
    return null;
  }
  const bounds = z
    .object({ min: tokenUnitsSchema })
    .parse((await callViewFunction(contract, "storage_balance_bounds", {})).value);
  if (BigInt(bounds.min) <= 0n || BigInt(bounds.min) > MAX_REGISTRATION_DEPOSIT) {
    throw new ExecutionError(
      "not_ready",
      "This token needs an unusual storage deposit to reach your wallet.",
    );
  }
  return bounds.min;
}

export async function nativeReturnRecord(db: AppDatabase, action: LedgerAction): Promise<NativeReturnRecord> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "native_return_prepared"),
      ),
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new ExecutionError("not_ready", "The return has no unique preparation record.");
  }
  const record = nativeReturnRecordSchema.parse(JSON.parse(rows[0].detailJson));
  const { payloadHash, ...unsigned } = record;
  if (executionHash(nativeReturnCall(unsigned)) !== payloadHash) {
    throw new ExecutionError("conflict", "The saved return transaction changed.");
  }
  return record;
}

/** Reserves one held token in the public trading account for return to the owner's own NEAR wallet. */
export async function prepareNativeReturn(
  db: AppDatabase,
  userId: string,
  agentId: string,
  assetId: string,
  requestId: string,
): Promise<LedgerAction> {
  const [existing] = await db
    .select()
    .from(executionActions)
    .where(and(eq(executionActions.userId, userId), eq(executionActions.requestId, requestId)))
    .limit(1);
  if (existing) {
    if (existing.agentId !== agentId || existing.kind !== "defi") {
      throw new ExecutionError("conflict", "This return request belongs to another action.");
    }
    await nativeReturnRecord(db, existing);
    return existing;
  }
  const agent = await ownedAgent(db, userId, agentId),
    root = await activeTradingAccount(db, userId);
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (agent.claimRequestedAt === null || agent.status === "running" || !owner) {
    throw new ExecutionError("not_ready", "Claim the agent's funds before returning them to your wallet.");
  }
  if (!root?.backupConfirmedAt) {
    throw new ExecutionError(
      "not_ready",
      "Confirm your trading account backup before returning these funds.",
    );
  }
  await synchronizeNativeInventory(db, userId, [assetId]);
  const units = await unreservedOwnedUnits(db, userId, agentId, "native_near", assetId);
  if (units <= 0n) {
    throw new ExecutionError("conflict", "This token has no unreserved balance left to return.");
  }
  const unsigned = {
    format: 1 as const,
    rootId: root.id,
    accountId: root.nativeAccountId,
    publicKey: root.nativePublicKey,
    recipient: owner.accountId,
    assetId,
    units: units.toString(),
    registrationDeposit:
      assetId === NATIVE_GAS_ASSET ? null : await registrationDeposit(assetId.slice(7), owner.accountId),
  };
  const record = nativeReturnRecordSchema.parse({
    ...unsigned,
    payloadHash: executionHash(nativeReturnCall(unsigned)),
  });
  return userTransaction(db, userId, async (tx) => {
    const current = await ownedAgent(tx, userId, agentId);
    const [pending] = await tx
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(
        and(
          eq(executionActions.userId, userId),
          eq(executionActions.scope, "native_near"),
          isNull(executionActions.reservationReleasedAt),
        ),
      )
      .limit(1);
    if (current.revision !== agent.revision || current.claimRequestedAt === null || pending) {
      throw new ExecutionError("not_ready", "Wait for the trading account's current transaction to finish.");
    }
    const permissionHash = await confirmExecutionPermission(tx, userId, {
      agentId,
      agentRevision: agent.revision,
      strategyVersion: agent.version,
      scope: "native_near",
      venueId: WALLET_RETURN_VENUES.native_near,
      signingPublicKey: root.nativePublicKey,
      operations: ["transfer"],
      assetIds: [assetId],
      instruments: [],
      recipients: [owner.accountId],
      expiresAt: null,
    });
    const now = await databaseTime(tx);
    const [principal] = await tx
      .select({ units: sql<string>`coalesce(sum(${positionLots.remainingPrincipalMicroUsd}), 0)::text` })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, userId),
          eq(positionLots.agentId, agentId),
          eq(positionLots.scope, "native_near"),
          eq(positionLots.assetId, assetId),
        ),
      );
    const notional = BigInt(principal?.units ?? "0");
    const action = await reserveDefiExecution(
      tx,
      userId,
      defiPlanSchema.parse({
        format: 2,
        requestId,
        agentId,
        agentRevision: agent.revision,
        strategyVersion: agent.version,
        riskPolicyRevision: 0,
        budgetMode: "per_agent",
        walletReturn: true,
        scope: "native_near",
        operation: "transfer",
        venueId: WALLET_RETURN_VENUES.native_near,
        permissionHash,
        cash: [{ assetId, maxDebitUnits: record.units, minCreditUnits: "0" }],
        positions: [],
        notionalMicroUsd: (notional > 0n ? notional : 1n).toString(),
        slippageBps: 0,
        providerFeeBps: 0,
        quoteId: requestId,
        quoteHash: record.payloadHash,
        payloadHash: record.payloadHash,
        recipient: owner.accountId,
        expiresAt: now + 120_000,
      }),
    );
    await executionEvent(tx, action, "native_return_prepared", now, record);
    return action;
  });
}

/** Signs and broadcasts the saved return once. A repeat call finds the journal row and sends nothing new. */
export async function sendNativeReturn(db: AppDatabase, action: LedgerAction, token: string): Promise<void> {
  const [journal] = await db
    .select({ id: nativeSubmissions.actionId })
    .from(nativeSubmissions)
    .where(and(eq(nativeSubmissions.actionId, action.id), eq(nativeSubmissions.role, "transfer")))
    .limit(1);
  if (journal) {
    return;
  }
  const record = await nativeReturnRecord(db, action),
    call = nativeReturnCall(record);
  const key = (await tradingAccountSigningKeys(db, action.userId, record.rootId)).native;
  if (key.getPublicKey().toString() !== record.publicKey) {
    throw new ExecutionError("conflict", "The trading account key changed.");
  }
  const [state, gas] = await Promise.all([
    nativeSigningState(record.accountId, record.publicKey),
    viewNearBudgetBalance(record.accountId, false),
    synchronizeNativeInventory(db, action.userId, [record.assetId]),
  ]);
  const gasCeiling = state.gasPrice * attachedGas(call) * 2n;
  if (gasCeiling > MAX_NATIVE_GAS_UNITS) {
    throw new ExecutionError("not_ready", "Network fees are unusually high. The return will try again.");
  }
  const signed = await userTransaction(db, action.userId, async (tx) => {
    const saved = await ownedLedgerAction(tx, action.userId, action.id),
      now = await databaseTime(tx),
      root = await activeTradingAccount(tx, action.userId);
    requireLease(saved, token, now);
    const [nearLots] = await tx
      .select({ units: sql<string>`coalesce(sum(${positionLots.remainingUnits}), 0)::text` })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, action.userId),
          eq(positionLots.scope, "native_near"),
          eq(positionLots.assetId, NATIVE_GAS_ASSET),
        ),
      );
    // Every agent's NEAR stays covered; fees and registration come from the account's unassigned gas reserve.
    if (
      gas.spendable <
      BigInt(nearLots?.units ?? "0") + BigInt(record.registrationDeposit ?? "0") + gasCeiling
    ) {
      throw new ExecutionError(
        "insufficient_funds",
        "Your trading account needs a little more NEAR for network fees before it can return these funds.",
      );
    }
    if (
      !root?.backupConfirmedAt ||
      root.id !== record.rootId ||
      root.nativeAccountId !== record.accountId ||
      root.nativePublicKey !== saved.signingPublicKey ||
      now - state.observedAt >= 15_000
    ) {
      throw new ExecutionError("not_ready", "The trading account or its signing observation changed.");
    }
    const [last] = await tx
      .select({ nonce: nativeSubmissions.nonce })
      .from(nativeSubmissions)
      .where(eq(nativeSubmissions.rootId, record.rootId))
      .orderBy(desc(nativeSubmissions.nonce))
      .limit(1);
    const nonce = state.nonce >= (last?.nonce ?? 0n) ? state.nonce + 1n : (last?.nonce ?? 0n) + 1n;
    const transaction = createTransaction(
      record.accountId,
      key.getPublicKey(),
      call.receiverId,
      nonce,
      transactionActions(call),
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
      role: "transfer",
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
        "native:transfer",
        bytes.toString("base64"),
      ),
      maximumGasUnits: gasCeiling,
      createdAt: now,
    });
    await commitSignedExecution(
      tx,
      saved.userId,
      saved.id,
      token,
      { payloadHash: record.payloadHash, providerRequestId: randomUUID() },
      () => bytes,
    );
    await executionEvent(tx, saved, "native_signed", now, {
      role: "transfer",
      transactionHash: base58.encode(hash),
      nonce: nonce.toString(),
    });
    return bytes;
  });
  try {
    await nativeRpc("broadcast_tx_async", [signed.toString("base64")]);
    await recordSubmissionStatus(db, action.userId, action.id, token, "submitted");
  } catch {
    // A timeout cannot prove rejection. Reconciliation rebroadcasts the same signed bytes and reads its hash.
    await recordSubmissionStatus(db, action.userId, action.id, token, "unknown");
  } finally {
    signed.fill(0);
  }
}
