import { base64urlnopad } from "@scure/base";
import { z } from "zod";
import { type RecoveryPayload, recoveryEnvelopeSchema, recoveryPayloadSchema } from "./trading-recovery";

const AAD = new TextEncoder().encode("wrenai-mainnet-recovery:v1");
async function encryptionKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const encoded = new TextEncoder().encode(z.string().min(12).max(1024).parse(password));
  try {
    const base = await crypto.subtle.importKey("raw", encoded, "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      usages,
    );
  } finally {
    encoded.fill(0);
  }
}
export async function sealRecoveryFile(payload: RecoveryPayload, password: string): Promise<string> {
  const valid = recoveryPayloadSchema.parse(payload);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(password, salt, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(valid));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 },
      key,
      plaintext,
    );
    return JSON.stringify(
      recoveryEnvelopeSchema.parse({
        format: "wrenai-encrypted-recovery-v1",
        kdf: "PBKDF2-SHA256",
        iterations: 600000,
        salt: base64urlnopad.encode(salt),
        iv: base64urlnopad.encode(iv),
        ciphertext: base64urlnopad.encode(new Uint8Array(ciphertext)),
      }),
    );
  } finally {
    plaintext.fill(0);
  }
}
export async function openRecoveryFile(text: string, password: string): Promise<RecoveryPayload> {
  const envelope = recoveryEnvelopeSchema.parse(JSON.parse(z.string().max(40_000).parse(text)));
  const salt = Uint8Array.from(base64urlnopad.decode(envelope.salt));
  const iv = Uint8Array.from(base64urlnopad.decode(envelope.iv));
  const ciphertext = Uint8Array.from(base64urlnopad.decode(envelope.ciphertext));
  const key = await encryptionKey(password, salt, ["decrypt"]);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 },
      key,
      ciphertext,
    ),
  );
  try {
    return recoveryPayloadSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } finally {
    plaintext.fill(0);
  }
}
export async function recoveryFileHash(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
