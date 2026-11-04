import { z } from "zod";

// Production constants: https://docs.near-intents.org/integration/market-makers/confidential-intents
const treasury = "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe";
const contractSalt = Buffer.from("e110f317", "hex");
const magic = Buffer.from([86, 40, 246, 198]);

/**
 * A version-0 expirable nonce (intents-sdk 0.93.0 VersionedNonceBuilder.encodeNonce): magic, version, the
 * contract's salt, the deadline in nanoseconds, then 15 inner bytes that begin with the signing time in
 * nanoseconds (createTimestampedNonceBytes) and end with 7 random bytes. 1Click's NEP-413 login rejects any other
 * layout with "timestamp validation failed". Integers are little-endian, as the SDK writes them.
 */
export function versionedNonce(salt: Buffer, deadlineMs: number, signedAtMs: number, random: Buffer): Buffer {
  if (salt.length !== 4 || random.length !== 7) {
    throw new RangeError("A versioned nonce needs a 4-byte salt and 7 random bytes.");
  }
  const nonce = Buffer.alloc(32);
  magic.copy(nonce, 0);
  nonce[4] = 0;
  salt.copy(nonce, 5);
  nonce.writeBigUInt64LE(BigInt(deadlineMs) * 1_000_000n, 9);
  nonce.writeBigInt64LE(BigInt(signedAtMs) * 1_000_000n, 17);
  random.copy(nonce, 25);
  return nonce;
}
const publicAssetSchema = z
  .string()
  .max(180)
  .regex(/^nep141:[^\s:*]+$/);

export function privateTokenId(publicAssetId: string): string {
  return `imt:${treasury}:${publicAssetSchema.parse(publicAssetId)}`;
}

/** Version-0 nonce layout from @defuse-protocol/intents-sdk 0.93.0, expirable-nonce.ts. */
export function privateNonceMatches(nonce: Buffer, deadlineMs: number): boolean {
  return (
    nonce.length === 32 &&
    nonce.subarray(0, 4).equals(magic) &&
    nonce[4] === 0 &&
    nonce.subarray(5, 9).equals(contractSalt) &&
    nonce.readBigUInt64LE(9) === BigInt(deadlineMs) * 1_000_000n
  );
}
