import "server-only";
import { randomUUID } from "node:crypto";
import { base64urlnopad } from "@scure/base";
import { database } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { serverEnv } from "@/server/env";
import { isImplicitAccountId } from "@/server/near/account-id";
import {
  bytesToHex,
  decodeSignature,
  NEP413_NONCE_BYTES,
  parseEd25519PublicKey,
  verifyNep413Signature,
} from "@/server/near/nep413";
import { hasFullAccessKey, NearRpcError } from "@/server/near/rpc";
import { consumeSignInChallenge, SIGN_IN_MESSAGE } from "./challenge";

export interface SignedSignIn {
  readonly accountId: string;
  readonly publicKey: string;
  readonly signature: string;
  readonly nonce: string;
}

export type SignInErrorCode =
  | "challenge_invalid"
  | "signature_invalid"
  | "key_not_full_access"
  | "near_rpc_unavailable";

export type SignInVerification =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly code: SignInErrorCode; readonly message: string };

function failure(code: SignInErrorCode, message: string): SignInVerification {
  return { ok: false, code, message };
}

/** Implicit accounts are their own key; named accounts must hold the key as a full-access key on chain. */
async function ownsKey(accountId: string, publicKey: Uint8Array, publicKeyText: string): Promise<boolean> {
  if (isImplicitAccountId(accountId) && bytesToHex(publicKey) === accountId) {
    return true;
  }
  return hasFullAccessKey(accountId, publicKeyText);
}

async function upsertUser(accountId: string): Promise<string> {
  const now = Date.now();
  const [row] = await database()
    .insert(users)
    .values({ id: randomUUID(), accountId, createdAt: now, lastSignInAt: now })
    .onConflictDoUpdate({ target: users.accountId, set: { lastSignInAt: now } })
    .returning({ id: users.id });
  if (row === undefined) {
    throw new Error("The signed-in user could not be stored.");
  }
  return row.id;
}

/**
 * Verifies a NEP-413 sign-in. The challenge is consumed first, so every signature is checked at most once.
 */
export async function verifySignIn(input: SignedSignIn): Promise<SignInVerification> {
  // Messages are one short line under the sign-in button: what happened, then what to do.
  if (!(await consumeSignInChallenge(input.nonce))) {
    return failure("challenge_invalid", "Sign-in expired. Try again.");
  }
  const nonce = base64urlnopad.decode(input.nonce);
  const publicKey = parseEd25519PublicKey(input.publicKey);
  const signature = decodeSignature(input.signature);
  if (nonce.length !== NEP413_NONCE_BYTES || publicKey === null || signature === null) {
    return failure("signature_invalid", "Unsupported signature. Try another wallet.");
  }
  const payload = { message: SIGN_IN_MESSAGE, nonce, recipient: serverEnv().appHost };
  if (!verifyNep413Signature({ publicKey, signature, payload })) {
    return failure("signature_invalid", "Signature didn't match. Try again.");
  }
  try {
    if (!(await ownsKey(input.accountId, publicKey, input.publicKey))) {
      return failure("key_not_full_access", "Use a full-access key to sign in.");
    }
  } catch (error) {
    if (error instanceof NearRpcError) {
      return failure("near_rpc_unavailable", "Can't reach NEAR. Try again soon.");
    }
    throw error;
  }
  return { ok: true, userId: await upsertUser(input.accountId) };
}
