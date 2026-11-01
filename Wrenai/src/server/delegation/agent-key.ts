import "server-only";
import { createCipheriv, createDecipheriv, type KeyObject, randomBytes } from "node:crypto";
import { serverEnv } from "@/server/env";
import { ed25519KeyFromSeed, ed25519PublicKey } from "@/server/near/ed25519-key";

/** The stored format preserves existing authorizations. Registration has no application expiry. */
export function generateAgentKey(): { readonly publicKey: string; readonly sealedSecret: Buffer } {
  const seed = randomBytes(32);
  try {
    const publicKey = ed25519PublicKey(ed25519KeyFromSeed(seed));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", serverEnv().keyEncryptionKey, iv);
    const sealed = Buffer.concat([cipher.update(seed), cipher.final()]);
    return { publicKey, sealedSecret: Buffer.concat([iv, sealed, cipher.getAuthTag()]) };
  } finally {
    seed.fill(0);
  }
}

/** Vercel can access this key. Storage encryption is not hardware isolation. */
export function openAgentKey(sealed: Buffer, expectedPublicKey: string): KeyObject {
  if (sealed.length !== 60) {
    throw new Error("The stored delegated key has an invalid sealed length.");
  }
  const decipher = createDecipheriv("aes-256-gcm", serverEnv().keyEncryptionKey, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(44));
  const seed = Buffer.concat([decipher.update(sealed.subarray(12, 44)), decipher.final()]);
  try {
    const key = ed25519KeyFromSeed(seed);
    if (ed25519PublicKey(key) !== expectedPublicKey) {
      throw new Error("The stored key does not match its registered public key.");
    }
    return key;
  } finally {
    seed.fill(0);
  }
}
