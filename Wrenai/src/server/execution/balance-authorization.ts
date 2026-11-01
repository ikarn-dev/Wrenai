import "server-only";
import { randomBytes, sign } from "node:crypto";
import { base58 } from "@scure/base";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { delegatedKeys, users } from "@/server/db/schema";
import { openAgentKey } from "@/server/delegation/agent-key";
import { readKeyRegistration } from "@/server/intents/verifier";
import { hashNep413Payload } from "@/server/near/nep413";
import { ExecutionError } from "./contracts";
import { oneClickJson } from "./oneclick-quote";

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
  const payload = {
    message: JSON.stringify({
      signer_id: owner.accountId,
      deadline: new Date(Date.now() + 300_000).toISOString(),
      intents: [],
    }),
    nonce: randomBytes(32),
    recipient: "intents.near",
  };
  const signature = sign(
    null,
    hashNep413Payload(payload),
    openAgentKey(delegation.sealedSecret, delegation.publicKey),
  );
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
