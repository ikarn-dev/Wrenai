import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { base58 } from "@scure/base";

const ED25519_PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");
export function ed25519KeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new Error("The ed25519 seed must contain 32 bytes.");
  }
  const encoded = Buffer.concat([ED25519_PKCS8_HEADER, seed]);
  try {
    return createPrivateKey({ key: encoded, format: "der", type: "pkcs8" });
  } finally {
    encoded.fill(0);
  }
}
export function ed25519PublicKey(key: KeyObject): string {
  return `ed25519:${base58.encode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32))}`;
}
