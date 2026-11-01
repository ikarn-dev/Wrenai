import { createSecretKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chatCipher } from "./cipher";

vi.mock("server-only", () => ({}));
const key = createSecretKey(Buffer.alloc(32, 7));

describe("encrypted chat storage", () => {
  it("randomizes encryption and binds ciphertext to owner, conversation and message role", () => {
    const cipher = chatCipher(key);
    const sealed = cipher.seal("owner", "conversation", "message:user", "Private conversation text");
    expect(sealed).not.toContain("Private");
    expect(cipher.open("owner", "conversation", "message:user", sealed)).toBe("Private conversation text");
    expect(cipher.seal("owner", "conversation", "message:user", "Private conversation text")).not.toBe(
      sealed,
    );
    for (const [owner, conversation, field] of [
      ["stranger", "conversation", "message:user"],
      ["owner", "other", "message:user"],
      ["owner", "conversation", "message:assistant"],
    ]) {
      if (!owner || !conversation || !field) {
        throw new Error("Invalid test context");
      }
      expect(() => cipher.open(owner, conversation, field, sealed)).toThrow();
    }
    const tampered = Buffer.from(sealed, "base64url");
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(() =>
      cipher.open("owner", "conversation", "message:user", tampered.toString("base64url")),
    ).toThrow();
    expect(() =>
      chatCipher(createSecretKey(Buffer.alloc(32, 8))).open("owner", "conversation", "message:user", sealed),
    ).toThrow();
  });

  it("round-trips large model evidence within the existing ciphertext budget and authenticates its format", () => {
    const cipher = chatCipher(key);
    const evidence = JSON.stringify({
      evidenceJson: JSON.stringify({ certificate: "attestation-data".repeat(23000) }),
      reply: "A completed verified answer",
    });
    expect(Buffer.byteLength(evidence)).toBeGreaterThan(300_000);
    const sealed = cipher.seal("owner", "chat", "reply", evidence);
    expect(sealed.length).toBeLessThan(300_000);
    expect(cipher.open("owner", "chat", "reply", sealed)).toBe(evidence);
    expect(() => cipher.open("owner", "chat", "reply", sealed.slice(3))).toThrow();
    expect(() => cipher.open("stranger", "chat", "reply", sealed)).toThrow();
    expect(() => cipher.seal("owner", "chat", "reply", "x".repeat(1_048_577))).toThrow("plaintext budget");
  });

  it("uses a keyed input digest rather than a public dictionary-checkable plaintext hash", () => {
    expect(chatCipher(key).hash("private text")).toMatch(/^[a-f0-9]{64}$/);
    expect(chatCipher(key).hash("private text")).not.toBe(
      chatCipher(createSecretKey(Buffer.alloc(32, 9))).hash("private text"),
    );
  });
});
