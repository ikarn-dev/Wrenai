import { describe, expect, it } from "vitest";
import { privateNonceMatches, versionedNonce } from "@/server/execution/confidential-intents";

const salt = Buffer.from("252812b3", "hex");
const deadline = 1_793_000_300_000;
const signedAt = 1_793_000_000_000;
const random = Buffer.from([1, 2, 3, 4, 5, 6, 7]);

describe("versioned expirable nonces", () => {
  it("lays out magic, version, salt, deadline, signing time and random bytes as the intents SDK does", () => {
    const nonce = versionedNonce(salt, deadline, signedAt, random);
    expect(nonce).toHaveLength(32);
    expect([...nonce.subarray(0, 5)]).toEqual([86, 40, 246, 198, 0]);
    expect(nonce.subarray(5, 9).equals(salt)).toBe(true);
    expect(nonce.readBigUInt64LE(9)).toBe(BigInt(deadline) * 1_000_000n);
    expect(nonce.readBigInt64LE(17)).toBe(BigInt(signedAt) * 1_000_000n);
    expect(nonce.subarray(25).equals(random)).toBe(true);
  });
  it("matches the confidential check when built with the confidential salt, and only for its own deadline", () => {
    const nonce = versionedNonce(Buffer.from("e110f317", "hex"), deadline, signedAt, random);
    expect(privateNonceMatches(nonce, deadline)).toBe(true);
    expect(privateNonceMatches(nonce, deadline + 1)).toBe(false);
  });
  it("rejects a salt or random part of the wrong size", () => {
    expect(() => versionedNonce(Buffer.alloc(3), deadline, signedAt, random)).toThrow(RangeError);
    expect(() => versionedNonce(salt, deadline, signedAt, Buffer.alloc(8))).toThrow(RangeError);
  });
});
