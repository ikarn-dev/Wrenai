import { generateKeyPairSync, sign } from "node:crypto";
import { base58, base64, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  decodeSignature,
  hashNep413Payload,
  type Nep413Payload,
  parseEd25519PublicKey,
  serializeNep413Payload,
  verifyNep413Signature,
} from "./nep413";

const NONCE = Uint8Array.from({ length: 32 }, (_, index) => index);

function keyPair(): { publicKey: Uint8Array; signPayload: (payload: Nep413Payload) => Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new Error("Node returned an ed25519 JWK without x");
  }
  return {
    publicKey: base64urlnopad.decode(jwk.x),
    signPayload: (payload) => new Uint8Array(sign(null, hashNep413Payload(payload), privateKey)),
  };
}

describe("serializeNep413Payload", () => {
  it("lays out the NEP-413 example as tag, message, nonce, recipient, callbackUrl", () => {
    const bytes = serializeNep413Payload({
      message: "hi",
      nonce: NONCE,
      recipient: "myapp.com",
      callbackUrl: "myapp.com/callback",
    });
    const encode = (text: string) => Array.from(new TextEncoder().encode(text));
    const expected = [
      0x9d,
      0x01,
      0x00,
      0x80,
      0x02,
      0x00,
      0x00,
      0x00,
      ...encode("hi"),
      ...NONCE,
      0x09,
      0x00,
      0x00,
      0x00,
      ...encode("myapp.com"),
      0x01,
      0x12,
      0x00,
      0x00,
      0x00,
      ...encode("myapp.com/callback"),
    ];
    expect(Array.from(bytes)).toEqual(expected);
  });

  it("encodes a missing callbackUrl as Option::None", () => {
    const bytes = serializeNep413Payload({ message: "hi", nonce: NONCE, recipient: "myapp.com" });
    expect(bytes.at(-1)).toBe(0);
  });

  it("rejects a nonce that isn't 32 bytes", () => {
    expect(() =>
      serializeNep413Payload({ message: "hi", nonce: new Uint8Array(31), recipient: "a" }),
    ).toThrow(RangeError);
  });
});

describe("verifyNep413Signature", () => {
  const payload: Nep413Payload = { message: "Sign in", nonce: NONCE, recipient: "localhost:3000" };

  it("accepts a signature from the matching key", () => {
    const { publicKey, signPayload } = keyPair();
    expect(verifyNep413Signature({ publicKey, signature: signPayload(payload), payload })).toBe(true);
  });

  it("rejects a signature made for another recipient", () => {
    const { publicKey, signPayload } = keyPair();
    const signature = signPayload({ ...payload, recipient: "phishing.example" });
    expect(verifyNep413Signature({ publicKey, signature, payload })).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const signer = keyPair();
    const other = keyPair();
    expect(
      verifyNep413Signature({ publicKey: other.publicKey, signature: signer.signPayload(payload), payload }),
    ).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const { publicKey, signPayload } = keyPair();
    const signature = signPayload(payload);
    signature[0] = (signature[0] ?? 0) ^ 0xff;
    expect(verifyNep413Signature({ publicKey, signature, payload })).toBe(false);
  });
});

describe("key and signature parsing", () => {
  it("parses an ed25519 public key and rejects other formats", () => {
    const raw = new Uint8Array(32).fill(7);
    expect(parseEd25519PublicKey(`ed25519:${base58.encode(raw)}`)).toEqual(raw);
    expect(parseEd25519PublicKey(`secp256k1:${base58.encode(raw)}`)).toBeNull();
    expect(parseEd25519PublicKey("ed25519:0OIl")).toBeNull();
    expect(parseEd25519PublicKey(`ed25519:${base58.encode(new Uint8Array(31))}`)).toBeNull();
  });

  it("decodes a 64-byte base64 signature and rejects anything else", () => {
    const raw = new Uint8Array(64).fill(1);
    expect(decodeSignature(base64.encode(raw))).toEqual(raw);
    expect(decodeSignature(base64.encode(new Uint8Array(63)))).toBeNull();
    expect(decodeSignature("not base64!")).toBeNull();
  });
});
