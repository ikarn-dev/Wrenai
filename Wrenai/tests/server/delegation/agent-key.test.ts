import { createSecretKey, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateAgentKey, openAgentKey } from "@/server/delegation/agent-key";
import { ed25519PublicKey } from "@/server/near/ed25519-key";
import { hashNep413Payload, parseEd25519PublicKey, verifyNep413Signature } from "@/server/near/nep413";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));

describe("shared encrypted trading key", () => {
  it("preserves the sealed format and signs valid NEP-413 messages without a key lifetime", () => {
    const generated = generateAgentKey();
    expect(generated.sealedSecret.length).toBe(60);
    const key = openAgentKey(generated.sealedSecret, generated.publicKey);
    expect(ed25519PublicKey(key)).toBe(generated.publicKey);
    const publicKey = parseEd25519PublicKey(generated.publicKey);
    if (!publicKey) {
      throw new Error("Invalid offline key");
    }
    const payload = { message: "offline fixture", nonce: Buffer.alloc(32), recipient: "intents.near" };
    expect(
      verifyNep413Signature({ publicKey, payload, signature: sign(null, hashNep413Payload(payload), key) }),
    ).toBe(true);
    expect(Object.keys(generated).sort()).toEqual(["publicKey", "sealedSecret"]);
  });
  it("rejects tampered ciphertext and a substituted public key", () => {
    const first = generateAgentKey();
    const second = generateAgentKey();
    expect(() => openAgentKey(first.sealedSecret, second.publicKey)).toThrow("does not match");
    const damaged = Buffer.from(first.sealedSecret);
    damaged[14] = (damaged[14] ?? 0) ^ 1;
    expect(() => openAgentKey(damaged, first.publicKey)).toThrow();
    expect(() => openAgentKey(Buffer.alloc(59), first.publicKey)).toThrow("sealed length");
  });
});
