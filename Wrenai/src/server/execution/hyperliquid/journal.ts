import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { delegatedKeys, users } from "@/server/db/schema";
import { agentTradingAccounts } from "@/server/db/trading-account-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { readKeyRegistration } from "@/server/intents/verifier";
import { agentPerpsSigningWallet, readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { recheckLedgerAction } from "../action-policy";
import { ExecutionError } from "../contracts";
import { commitSignedExecution, recordSubmissionStatus } from "../ownership";
import {
  databaseTime,
  executionEvent,
  executionHash,
  type LedgerAction,
  ownedLedgerAction,
  requireLease,
} from "../records";
import { type HlAction, hlActionSchema } from "./contracts";
import { signHlAction } from "./signing";
import { hlExchange } from "./transport";

const requestSchema = z.strictObject({
  action: hlActionSchema,
  nonce: z.number().int().nonnegative().safe(),
  expiresAfter: z.number().int().positive().safe(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});
export type HlRequest = z.infer<typeof requestSchema>;
function kind(role: string): string {
  return `hl_signed_${z
    .string()
    .regex(/^(?:trade|leverage|protect:\d{1,8}|cancel:\d{1,8})$/)
    .parse(role)}`;
}
export async function readHlRequest(
  db: AppDatabase,
  action: LedgerAction,
  role: string,
): Promise<HlRequest | null> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, kind(role)),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new ExecutionError("conflict", "The venue request journal contains competing submissions.");
  }
  return rows[0] ? requestSchema.parse(JSON.parse(rows[0].detailJson)) : null;
}
export async function perpsAuthority(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<{
  readonly wallet: Awaited<ReturnType<typeof agentPerpsSigningWallet>>;
  readonly sharedPublicKey: string;
  readonly activatedAtBlock: number;
}> {
  const [key] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
  const [owner] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!key?.activatedAtBlock || !key.activatedAt || !owner) {
    throw new ExecutionError("not_ready", "The shared app authorization is unavailable or revoked.");
  }
  const registered = await readKeyRegistration(owner.accountId, key.publicKey);
  if (!registered.registered || registered.blockHeight < key.activatedAtBlock) {
    throw new ExecutionError(
      "not_ready",
      "The shared app authorization is revoked or could not be verified.",
    );
  }
  return {
    wallet: await agentPerpsSigningWallet(db, userId, agentId),
    sharedPublicKey: key.publicKey,
    activatedAtBlock: key.activatedAtBlock,
  };
}
/** This function never replays an existing request. Recovery reads cloids and final venue state instead. */
export async function sendHlRequest(
  db: AppDatabase,
  ledger: LedgerAction,
  token: string,
  role: string,
  raw: HlAction,
  validate: (tx: AppDatabase) => Promise<void>,
): Promise<void> {
  const action = hlActionSchema.parse(raw),
    authority = await perpsAuthority(db, ledger.userId, ledger.agentId),
    wallet = authority.wallet;
  const result = await userTransaction(db, ledger.userId, async (tx) => {
    const current = await ownedLedgerAction(tx, ledger.userId, ledger.id),
      now = await databaseTime(tx);
    const existing = await readHlRequest(tx, current, role);
    if (existing) {
      if (executionHash(existing.action) !== executionHash(action)) {
        throw new ExecutionError(
          "conflict",
          "This venue request identity already binds different signing bytes.",
        );
      }
      return null;
    }
    const account = await readAgentTradingAccount(tx, ledger.userId, ledger.agentId),
      root = await activeTradingAccount(tx, ledger.userId);
    const [key] = await tx
      .select()
      .from(delegatedKeys)
      .where(eq(delegatedKeys.userId, ledger.userId))
      .limit(1);
    if (
      !account ||
      !root ||
      account.rootId !== root.id ||
      root.backupVersion !== 2 ||
      root.backupConfirmedAt === null ||
      account.perpAddress !== wallet.address ||
      !key?.activatedAt ||
      key.publicKey !== authority.sharedPublicKey ||
      key.activatedAtBlock !== authority.activatedAtBlock
    ) {
      throw new ExecutionError("not_ready", "The backed-up trading address or shared authorization changed.");
    }
    if (role === "trade" || role === "leverage") {
      requireLease(current, token, now);
      await recheckLedgerAction(tx, current, now, "submit");
    }
    await validate(tx);
    const nonce = Math.max(now, account.lastNonce + 1),
      expiresAfter =
        role === "trade" || role === "leverage" ? Math.min(now + 15_000, current.expiresAt) : now + 15_000;
    if (expiresAfter <= now || nonce > now + 1000) {
      throw new ExecutionError("not_ready", "The venue submission window or nonce is unavailable.");
    }
    const request = requestSchema.parse({ action, nonce, expiresAfter, address: wallet.address });
    const sign = (): Buffer => Buffer.from(JSON.stringify(signHlAction(wallet, action, nonce, expiresAfter)));
    await tx
      .update(agentTradingAccounts)
      .set({ lastNonce: nonce })
      .where(eq(agentTradingAccounts.agentId, ledger.agentId));
    await executionEvent(tx, current, kind(role), now, request);
    const signature =
      role === "trade"
        ? await commitSignedExecution(
            tx,
            ledger.userId,
            ledger.id,
            token,
            { payloadHash: executionHash(action), providerRequestId: randomUUID() },
            sign,
          )
        : sign();
    return { request, signature };
  });
  if (!result) {
    return;
  }
  try {
    const signature = z
      .strictObject({
        r: z.string().regex(/^0x[a-f0-9]{64}$/),
        s: z.string().regex(/^0x[a-f0-9]{64}$/),
        v: z.union([z.literal(27), z.literal(28)]),
      })
      .parse(JSON.parse(result.signature.toString("utf8")));
    const response = await hlExchange(
      result.request.action,
      result.request.nonce,
      result.request.expiresAfter,
      signature,
    );
    await userTransaction(db, ledger.userId, async (tx) => {
      const current = await ownedLedgerAction(tx, ledger.userId, ledger.id);
      await executionEvent(tx, current, `hl_ack_${role}`, await databaseTime(tx), response);
    });
    if (role === "trade") {
      await recordSubmissionStatus(db, ledger.userId, ledger.id, token, "submitted");
    }
  } catch (error) {
    if (role === "trade") {
      await recordSubmissionStatus(db, ledger.userId, ledger.id, token, "unknown");
    } else {
      await userTransaction(db, ledger.userId, async (tx) => {
        const current = await ownedLedgerAction(tx, ledger.userId, ledger.id);
        await executionEvent(tx, current, `hl_unconfirmed_${role}`, await databaseTime(tx), {
          code: error instanceof ExecutionError ? error.code : "unconfirmed",
        });
      });
    }
  } finally {
    result.signature.fill(0);
  }
}
