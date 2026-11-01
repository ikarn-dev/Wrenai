"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { clientAddress, consumeRateLimit } from "@/server/http/rate-limit";
import { nearAccountIdSchema } from "@/server/near/account-id";
import { issueSignInChallenge, type SignInChallenge } from "./challenge";
import { endSession, startSession } from "./session";
import { type SignInErrorCode, verifySignIn } from "./verify-sign-in";

const ATTEMPTS_PER_WINDOW = 10;
const WINDOW_MS = 60_000;

export type ActionErrorCode = SignInErrorCode | "rate_limited" | "unavailable" | "invalid_request";

export type ChallengeResult =
  | { readonly ok: true; readonly challenge: SignInChallenge }
  | { readonly ok: false; readonly code: "rate_limited" | "unavailable"; readonly message: string };

// Sign-in never requests trading authorization. Agents can be created before their first activation.
export type SignInResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ActionErrorCode; readonly message: string };

// Messages are one short line under the sign-in button: what happened, then what to do.
const RATE_LIMITED = "Too many attempts. Wait a minute.";

const signedSignInSchema = z.strictObject({
  accountId: nearAccountIdSchema,
  publicKey: z.string().min(1).max(128),
  signature: z.string().min(1).max(256),
  // 32 bytes as unpadded base64url.
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export async function requestSignInChallenge(): Promise<ChallengeResult> {
  const decision = await consumeRateLimit(
    `challenge:${await clientAddress()}`,
    ATTEMPTS_PER_WINDOW,
    WINDOW_MS,
  );
  if (decision !== "allowed") {
    return {
      ok: false,
      code: decision === "limited" ? "rate_limited" : "unavailable",
      message:
        decision === "limited" ? RATE_LIMITED : "Sign-in protection is unavailable. Try again shortly.",
    };
  }
  return { ok: true, challenge: await issueSignInChallenge() };
}

export async function completeSignIn(input: unknown): Promise<SignInResult> {
  const decision = await consumeRateLimit(`sign-in:${await clientAddress()}`, ATTEMPTS_PER_WINDOW, WINDOW_MS);
  if (decision !== "allowed") {
    return {
      ok: false,
      code: decision === "limited" ? "rate_limited" : "unavailable",
      message:
        decision === "limited" ? RATE_LIMITED : "Sign-in protection is unavailable. Try again shortly.",
    };
  }
  const parsed = signedSignInSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "invalid_request", message: "Wallet reply incomplete. Try again." };
  }
  const verification = await verifySignIn(parsed.data);
  if (!verification.ok) {
    return verification;
  }
  await startSession(verification.userId);
  return { ok: true };
}

export async function signOut(): Promise<void> {
  await endSession();
  redirect("/");
}
