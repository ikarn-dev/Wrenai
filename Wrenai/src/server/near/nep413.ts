import { createHash, createPublicKey, verify } from "node:crypto";
import { base58, base64, base64urlnopad } from "@scure/base";

// NEP-413 signed messages: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
// The prefix tag 2^31 + 413 makes the payload an invalid transaction, so a signature over it can't be replayed on chain.
const NEP413_TAG = 2_147_484_061;
const ED25519_PREFIX = "ed25519:";
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

export const NEP413_NONCE_BYTES = 32;

export interface Nep413Payload {
  readonly message: string;
  readonly nonce: Uint8Array;
  readonly recipient: string;
  readonly callbackUrl?: string;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function borshU32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function borshString(value: string): Uint8Array {
  const utf8 = new TextEncoder().encode(value);
  return concatBytes([borshU32(utf8.length), utf8]);
}

/** Borsh bytes that NEP-413 hashes: the u32 tag followed by the serialized payload. */
export function serializeNep413Payload(payload: Nep413Payload): Uint8Array {
  if (payload.nonce.length !== NEP413_NONCE_BYTES) {
    throw new RangeError(`NEP-413 nonce must be ${NEP413_NONCE_BYTES} bytes, got ${payload.nonce.length}`);
  }
  const callbackUrl =
    payload.callbackUrl === undefined
      ? Uint8Array.of(0)
      : concatBytes([Uint8Array.of(1), borshString(payload.callbackUrl)]);
  return concatBytes([
    borshU32(NEP413_TAG),
    borshString(payload.message),
    payload.nonce,
    borshString(payload.recipient),
    callbackUrl,
  ]);
}

export function hashNep413Payload(payload: Nep413Payload): Uint8Array {
  return new Uint8Array(createHash("sha256").update(serializeNep413Payload(payload)).digest());
}

/** Parses "ed25519:<base58>" into the 32 raw key bytes, or returns null if it isn't one. */
export function parseEd25519PublicKey(publicKey: string): Uint8Array | null {
  if (!publicKey.startsWith(ED25519_PREFIX)) {
    return null;
  }
  try {
    const raw = base58.decode(publicKey.slice(ED25519_PREFIX.length));
    return raw.length === ED25519_PUBLIC_KEY_BYTES ? raw : null;
  } catch {
    // Not base58: the input is invalid, which this function reports as null.
    return null;
  }
}

/** Decodes the base64 signature NEP-413 wallets return, or returns null if it isn't one. */
export function decodeSignature(signature: string): Uint8Array | null {
  try {
    const raw = base64.decode(signature);
    return raw.length === ED25519_SIGNATURE_BYTES ? raw : null;
  } catch {
    // Not base64: the input is invalid, which this function reports as null.
    return null;
  }
}

export function verifyNep413Signature(input: {
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
  readonly payload: Nep413Payload;
}): boolean {
  if (
    input.publicKey.length !== ED25519_PUBLIC_KEY_BYTES ||
    input.signature.length !== ED25519_SIGNATURE_BYTES
  ) {
    return false;
  }
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(input.publicKey) },
    format: "jwk",
  });
  return verify(null, hashNep413Payload(input.payload), key, input.signature);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
