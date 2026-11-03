import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { ownedAgent } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { signInChallenges } from "@/server/db/schema";
import { tradingAccounts } from "@/server/db/trading-account-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { serverEnv } from "@/server/env";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime } from "@/server/execution/records";
import { decodeSignature, parseEd25519PublicKey, verifyNep413Signature } from "@/server/near/nep413";
import { hasFullAccessKey } from "@/server/near/rpc";
import {
  type RecoveryChallenge,
  type RecoveryExport,
  recoveryConfirmationSchema,
  recoveryRequestSchema,
  recoverySignatureSchema,
} from "@/shared/trading-recovery";
import { ensureTradingAccount, tradingRecoveryPayload } from "./vault";

function recoveryMessage(accountId: string, agentId: string, expiresAt: number): string {
  return `Export Wrenai trading-account recovery for ${accountId}.\nAgent: ${agentId}\nOrigin: ${serverEnv().appOrigin}\nExpires: ${new Date(expiresAt).toISOString()}\nThis does not authorize a transaction.`;
}
function challengeId(userId: string, agentId: string, nonce: string): string {
  return `trading-recovery:${userId}:${agentId}:${nonce}`;
}

export async function issueRecoveryChallenge(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<RecoveryChallenge> {
  const { agentId } = recoveryRequestSchema.parse(raw);
  await ownedAgent(db, user.id, agentId);
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 300_000;
  await db.insert(signInChallenges).values({ nonce: challengeId(user.id, agentId, nonce), expiresAt });
  return {
    nonce,
    message: recoveryMessage(user.accountId, agentId, expiresAt),
    recipient: serverEnv().appHost,
  };
}

/** A session cookie alone can never export funded-account keys. Require a fresh full-access wallet proof. */
export async function exportTradingRecovery(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<RecoveryExport> {
  const input = recoverySignatureSchema.parse(raw);
  await ownedAgent(db, user.id, input.agentId);
  const id = challengeId(user.id, input.agentId, input.nonce);
  const [challenge] = await db.select().from(signInChallenges).where(eq(signInChallenges.nonce, id)).limit(1);
  const publicKey = parseEd25519PublicKey(input.publicKey);
  const signature = decodeSignature(input.signature);
  if (
    !challenge ||
    challenge.consumedAt !== null ||
    challenge.expiresAt <= Date.now() ||
    !publicKey ||
    !signature ||
    !verifyNep413Signature({
      publicKey,
      signature,
      payload: {
        message: recoveryMessage(user.accountId, input.agentId, challenge.expiresAt),
        recipient: serverEnv().appHost,
        nonce: Buffer.from(input.nonce, "base64url"),
      },
    }) ||
    !(await hasFullAccessKey(user.accountId, input.publicKey))
  ) {
    throw new ExecutionError(
      "not_ready",
      "A fresh ownership signature is required before exporting recovery keys.",
    );
  }
  return userTransaction(db, user.id, async (tx) => {
    await ownedAgent(tx, user.id, input.agentId);
    const now = await databaseTime(tx);
    const consumed = await tx
      .update(signInChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(signInChallenges.nonce, id),
          isNull(signInChallenges.consumedAt),
          gt(signInChallenges.expiresAt, now),
        ),
      )
      .returning({ nonce: signInChallenges.nonce });
    if (consumed.length !== 1) {
      throw new ExecutionError("conflict", "This recovery signature expired or was already used.");
    }
    const account = await ensureTradingAccount(tx, user.id);
    const token = randomBytes(32).toString("base64url");
    await tx.insert(signInChallenges).values({
      nonce: `trading-recovery-confirm:v2:${user.id}:${account.id}:${token}`,
      expiresAt: now + 600_000,
    });
    return { payload: tradingRecoveryPayload(account, user.accountId), confirmationToken: token };
  });
}

/** The hash records the user's encrypted file acknowledgement, not proof of storage on their device. */
export async function confirmTradingBackup(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const input = recoveryConfirmationSchema.parse(raw);
  await userTransaction(db, userId, async (tx) => {
    const now = await databaseTime(tx);
    const [account] = await tx
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.id, input.accountId),
          eq(tradingAccounts.userId, userId),
          isNull(tradingAccounts.revokedAt),
        ),
      )
      .limit(1);
    if (!account) {
      throw new ExecutionError("not_found", "This trading account is unavailable or revoked.");
    }
    const nonce = `trading-recovery-confirm:v2:${userId}:${input.accountId}:${input.token}`;
    const [challenge] = await tx
      .select()
      .from(signInChallenges)
      .where(eq(signInChallenges.nonce, nonce))
      .limit(1);
    if (challenge && typeof challenge.consumedAt === "number" && account.backupFileHash === input.fileHash) {
      return;
    }
    const consumed = await tx
      .update(signInChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(signInChallenges.nonce, nonce),
          isNull(signInChallenges.consumedAt),
          gt(signInChallenges.expiresAt, now),
        ),
      )
      .returning({ nonce: signInChallenges.nonce });
    if (consumed.length !== 1) {
      throw new ExecutionError("not_ready", "This backup confirmation expired or was already used.");
    }
    await tx
      .update(tradingAccounts)
      .set({ backupConfirmedAt: now, backupFileHash: input.fileHash, backupVersion: 2 })
      .where(eq(tradingAccounts.id, account.id));
  });
}
