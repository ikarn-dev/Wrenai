import "server-only";
import { type KeyObject, sign } from "node:crypto";
import { base58 } from "@scure/base";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { delegatedKeys, users } from "@/server/db/schema";
import { openAgentKey } from "@/server/delegation/agent-key";
import { intentsLoginNonce } from "@/server/intents/auth-nonce";
import { readKeyRegistration } from "@/server/intents/verifier";
import { hashNep413Payload } from "@/server/near/nep413";
import { ExecutionError } from "./contracts";
import { oneClickJson } from "./oneclick-quote";

/**
 * Opens the stored agent key for the read-session login. A key that won't open (sealed under a different
 * KEY_ENCRYPTION_KEY, or not matching its registered public key) can't be repaired by retrying, so it becomes
 * a typed error the user can act on instead of an untyped crypto failure behind "temporarily unavailable".
 */
function openRegisteredKey(delegation: {
  readonly sealedSecret: Buffer;
  readonly publicKey: string;
}): KeyObject {
  try {
    return openAgentKey(delegation.sealedSecret, delegation.publicKey);
  } catch {
    throw new ExecutionError(
      "not_ready",
      "Trading access can't be used on this server: its stored key doesn't open here. Revoke it and set up trading access again in Settings.",
    );
  }
}

/** Renew a read session using the existing registered key, never a new spending authorization. */
export async function authenticateDelegatedBalance(db: AppDatabase, userId: string): Promise<unknown | null> {
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [delegation] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
  if (!owner || !delegation || delegation.activatedAt === null || delegation.activatedAtBlock === null) {
    return null;
  }
  const registration = await readKeyRegistration(owner.accountId, delegation.publicKey);
  if (!registration.registered || registration.blockHeight < delegation.activatedAtBlock) {
    throw new ExecutionError(
      "not_ready",
      "The shared agent authorization was revoked or cannot be verified.",
    );
  }
  const deadline = Date.now() + 300_000;
  const payload = {
    message: JSON.stringify({
      signer_id: owner.accountId,
      deadline: new Date(deadline).toISOString(),
      intents: [],
    }),
    nonce: await intentsLoginNonce(deadline),
    recipient: "intents.near",
  };
  const signature = sign(null, hashNep413Payload(payload), openRegisteredKey(delegation));
  try {
    return await oneClickJson("/v0/auth/authenticate", {
      signedData: {
        standard: "nep413",
        payload: { ...payload, nonce: payload.nonce.toString("base64") },
        public_key: delegation.publicKey,
        signature: `ed25519:${base58.encode(signature)}`,
      },
    });
  } finally {
    signature.fill(0);
  }
}
