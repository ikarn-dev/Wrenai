import "server-only";
import { base58 } from "@scure/base";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "@/server/auth/session";
import { chatCipher } from "@/server/chat/cipher";
import type { AppDatabase } from "@/server/db/client";
import { intentsSessions } from "@/server/db/preview-schema";
import { signInChallenges } from "@/server/db/schema";
import { intentsLoginNonce } from "@/server/intents/auth-nonce";
import { decodeSignature, parseEd25519PublicKey, verifyNep413Signature } from "@/server/near/nep413";
import { hasFullAccessKey } from "@/server/near/rpc";
import { authenticateDelegatedBalance } from "./balance-authorization";
import { ExecutionError } from "./contracts";
import { oneClickJson } from "./oneclick-quote";

const tokensSchema = z.object({
  accessToken: z.string().min(1).max(16000),
  refreshToken: z.string().min(1).max(16000),
  expiresIn: z.number().int().positive().max(31_536_000),
  refreshExpiresIn: z.number().int().positive().max(31_536_000),
});
const refreshSchema = tokensSchema.pick({ accessToken: true, expiresIn: true });
const cipherNamespace = "provider-session:oneclick";
function message(accountId: string, expiresAt: number): string {
  return JSON.stringify({ signer_id: accountId, deadline: new Date(expiresAt).toISOString(), intents: [] });
}
export interface BalanceChallenge {
  readonly nonce: string;
  readonly message: string;
  readonly recipient: "intents.near";
}
export async function issueBalanceChallenge(db: AppDatabase, user: SessionUser): Promise<BalanceChallenge> {
  // The nonce's deadline is the challenge's expiry, so the wallet signs one deadline in both places.
  const expiresAt = Date.now() + 300_000;
  const nonce = (await intentsLoginNonce(expiresAt)).toString("base64url");
  await db.insert(signInChallenges).values({ nonce: `intents-auth:${user.id}:${nonce}`, expiresAt });
  return { nonce, message: message(user.accountId, expiresAt), recipient: "intents.near" };
}
export const balanceSignatureSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  publicKey: z.string().max(128),
  signature: z.string().max(256),
  accountId: z.string().min(2).max(64),
});
export async function storeBalanceSession(db: AppDatabase, userId: string, raw: unknown): Promise<void> {
  const tokens = tokensSchema.parse(raw);
  const now = Date.now();
  // A non-UUID namespace cannot collide with any valid chat conversation's encryption context.
  const sealedTokens = chatCipher().seal(userId, cipherNamespace, "tokens", JSON.stringify(tokens));
  await db
    .insert(intentsSessions)
    .values({
      userId,
      sealedTokens,
      accessExpiresAt: now + tokens.expiresIn * 1000,
      refreshExpiresAt: now + tokens.refreshExpiresIn * 1000,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: intentsSessions.userId,
      set: {
        sealedTokens,
        accessExpiresAt: now + tokens.expiresIn * 1000,
        refreshExpiresAt: now + tokens.refreshExpiresIn * 1000,
        updatedAt: now,
      },
    });
}
export async function completeBalanceSession(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<void> {
  const input = balanceSignatureSchema.parse(raw);
  const key = parseEd25519PublicKey(input.publicKey);
  const signature = decodeSignature(input.signature);
  const challengeId = `intents-auth:${user.id}:${input.nonce}`;
  const [challenge] = await db
    .select()
    .from(signInChallenges)
    .where(eq(signInChallenges.nonce, challengeId))
    .limit(1);
  if (
    !challenge ||
    challenge.consumedAt !== null ||
    challenge.expiresAt <= Date.now() ||
    input.accountId !== user.accountId ||
    key === null ||
    signature === null
  ) {
    throw new ExecutionError("not_ready", "The balance connection expired or belongs to another wallet.");
  }
  const payload = {
    message: message(user.accountId, challenge.expiresAt),
    nonce: Buffer.from(input.nonce, "base64url"),
    recipient: "intents.near",
  };
  if (
    !verifyNep413Signature({ publicKey: key, signature, payload }) ||
    !(await hasFullAccessKey(user.accountId, input.publicKey))
  ) {
    throw new ExecutionError("not_ready", "The wallet signature or account ownership check failed.");
  }
  const consumed = await db
    .update(signInChallenges)
    .set({ consumedAt: Date.now() })
    .where(
      and(
        eq(signInChallenges.nonce, challengeId),
        isNull(signInChallenges.consumedAt),
        gt(signInChallenges.expiresAt, Date.now()),
      ),
    )
    .returning({ nonce: signInChallenges.nonce });
  if (consumed.length !== 1) {
    throw new ExecutionError("conflict", "This balance connection was already used. Connect again.");
  }
  const tokens = await oneClickJson("/v0/auth/authenticate", {
    signedData: {
      standard: "nep413",
      payload: {
        message: payload.message,
        nonce: payload.nonce.toString("base64"),
        recipient: payload.recipient,
      },
      public_key: input.publicKey,
      signature: `ed25519:${base58.encode(signature)}`,
    },
  });
  await storeBalanceSession(db, user.id, tokens);
}
export async function privateBalanceToken(db: AppDatabase, userId: string): Promise<string | null> {
  const [session] = await db
    .select()
    .from(intentsSessions)
    .where(eq(intentsSessions.userId, userId))
    .limit(1);
  if (!session || session.refreshExpiresAt <= Date.now()) {
    const authenticated = await authenticateDelegatedBalance(db, userId);
    if (authenticated === null) {
      return null;
    }
    const tokens = tokensSchema.parse(authenticated);
    await storeBalanceSession(db, userId, tokens);
    return tokens.accessToken;
  }
  const tokens = tokensSchema.parse(
    JSON.parse(chatCipher().open(userId, cipherNamespace, "tokens", session.sealedTokens)),
  );
  if (session.accessExpiresAt > Date.now() + 10_000) {
    return tokens.accessToken;
  }
  // 1Click's refresh returns only a new access token and its lifetime (SDK RefreshResponseDto); the refresh
  // token and its expiry carry over unchanged.
  const access = refreshSchema.parse(
    await oneClickJson("/v0/auth/refresh", { refreshToken: tokens.refreshToken }),
  );
  const refreshed = { ...tokens, accessToken: access.accessToken, expiresIn: access.expiresIn };
  const now = Date.now();
  const updated = await db
    .update(intentsSessions)
    .set({
      sealedTokens: chatCipher().seal(userId, cipherNamespace, "tokens", JSON.stringify(refreshed)),
      accessExpiresAt: now + access.expiresIn * 1000,
      updatedAt: now,
    })
    .where(and(eq(intentsSessions.userId, userId), eq(intentsSessions.sealedTokens, session.sealedTokens)))
    .returning({ userId: intentsSessions.userId });
  if (updated.length !== 1) {
    throw new ExecutionError("conflict", "The balance connection changed. Refresh the preview.");
  }
  return refreshed.accessToken;
}

/** Display-only reads must not silently authenticate with the user's trading key. */
export async function connectedBalanceToken(db: AppDatabase, userId: string): Promise<string | null> {
  const [session] = await db
    .select()
    .from(intentsSessions)
    .where(eq(intentsSessions.userId, userId))
    .limit(1);
  if (!session || session.accessExpiresAt <= Date.now() + 10_000 || session.refreshExpiresAt <= Date.now()) {
    return null;
  }
  return tokensSchema.parse(
    JSON.parse(chatCipher().open(userId, cipherNamespace, "tokens", session.sealedTokens)),
  ).accessToken;
}
