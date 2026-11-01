import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { database } from "@/server/db/client";
import { signInChallenges } from "@/server/db/schema";
import { serverEnv } from "@/server/env";
import { NEP413_NONCE_BYTES } from "@/server/near/nep413";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Shown in the wallet when the user signs in. */
export const SIGN_IN_MESSAGE = "Sign in to Wrenai";

export interface SignInChallenge {
  /** base64url of the 32-byte NEP-413 nonce. */
  readonly nonce: string;
  readonly message: string;
  readonly recipient: string;
}

export async function issueSignInChallenge(): Promise<SignInChallenge> {
  const now = Date.now();
  const db = database();
  await db.delete(signInChallenges).where(lt(signInChallenges.expiresAt, now));
  const nonce = randomBytes(NEP413_NONCE_BYTES).toString("base64url");
  await db.insert(signInChallenges).values({ nonce, expiresAt: now + CHALLENGE_TTL_MS, consumedAt: null });
  return { nonce, message: SIGN_IN_MESSAGE, recipient: serverEnv().appHost };
}

/**
 * Marks the challenge used in one statement, so it can be redeemed once even under concurrent requests.
 * Returns false if it doesn't exist, has expired or was already used.
 */
export async function consumeSignInChallenge(nonce: string): Promise<boolean> {
  const now = Date.now();
  const consumed = await database()
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
  return consumed.length === 1;
}
