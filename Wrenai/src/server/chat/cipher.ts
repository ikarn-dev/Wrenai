import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { serverEnv } from "@/server/env";

export interface ChatCipher {
  seal(userId: string, conversationId: string, field: string, value: string): string;
  open(userId: string, conversationId: string, field: string, value: string): string;
  hash(value: string): string;
}

/** Domain separation keeps chat encryption independent of delegated-key encryption under the existing master. */
export function chatCipher(master: KeyObject = serverEnv().keyEncryptionKey): ChatCipher {
  const derived = createHmac("sha256", master).update("wrenai-chat:encryption:v1").digest();
  const key = createSecretKey(derived);
  derived.fill(0);
  const context = (user: string, conversation: string, field: string, compressed = false): Buffer =>
    Buffer.from(
      JSON.stringify([compressed ? "wrenai-chat:v2:deflate" : "wrenai-chat:v1", user, conversation, field]),
    );
  return {
    seal(user, conversation, field, value) {
      const plaintext = Buffer.from(value, "utf8");
      if (plaintext.length > 1_048_576) {
        throw new RangeError("Chat record exceeds its plaintext budget.");
      }
      const compressed = plaintext.length >= 8192 ? deflateRawSync(plaintext) : null;
      const useCompressed = compressed !== null && compressed.length < plaintext.length;
      const payload = useCompressed ? compressed : plaintext;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(context(user, conversation, field, useCompressed));
      const body = Buffer.concat([cipher.update(payload), cipher.final()]);
      const encoded = `${useCompressed ? "z1." : ""}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
      if (encoded.length > 300_000) {
        throw new RangeError("Chat record exceeds its ciphertext budget.");
      }
      return encoded;
    },
    open(user, conversation, field, value) {
      const encoded = z
        .string()
        .min(38)
        .max(300_000)
        .regex(/^(?:z1\.)?[A-Za-z0-9_-]+$/)
        .parse(value);
      const compressed = encoded.startsWith("z1.");
      const blob = Buffer.from(compressed ? encoded.slice(3) : encoded, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      decipher.setAAD(context(user, conversation, field, compressed));
      decipher.setAuthTag(blob.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
      return (compressed ? inflateRawSync(plaintext, { maxOutputLength: 1_048_576 }) : plaintext).toString(
        "utf8",
      );
    },
    hash(value) {
      return createHmac("sha256", key).update("wrenai-chat:request:v1:").update(value).digest("hex");
    },
  };
}
