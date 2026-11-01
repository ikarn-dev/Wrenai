import { z } from "zod";

// Production constants: https://docs.near-intents.org/integration/market-makers/confidential-intents
const treasury = "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe";
const contractSalt = Buffer.from("e110f317", "hex");
const magic = Buffer.from([86, 40, 246, 198]);
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
