import "server-only";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import { type ChatCipher, chatCipher } from "./cipher";

const CACHE_TTL_SECONDS = 300;
const MAX_CACHE_BYTES = 300_000;

function cacheClient(): Redis | null {
  const config = z
    .object({
      UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }),
      UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
    })
    .safeParse(process.env);
  return config.success
    ? new Redis({
        url: config.data.UPSTASH_REDIS_REST_URL,
        token: config.data.UPSTASH_REDIS_REST_TOKEN,
        retry: false,
        automaticDeserialization: false,
        signal: () => AbortSignal.timeout(750),
      })
    : null;
}

function cacheKey(cipher: ChatCipher, userId: string, conversationId: string, stamp: string): string {
  return `wrenai:chat-cache:v1:${cipher.hash(JSON.stringify([userId, conversationId, stamp]))}`;
}

/** This cache never establishes ownership or write authority. Callers validate those in Postgres first. */
export async function readChatCache<T>(
  userId: string,
  conversationId: string,
  stamp: string,
  schema: z.ZodType<T>,
  cipher: ChatCipher = chatCipher(),
): Promise<T | null> {
  const redis = cacheClient();
  if (!redis) {
    return null;
  }
  try {
    const sealed = await redis.get<string>(cacheKey(cipher, userId, conversationId, stamp));
    if (typeof sealed !== "string" || sealed.length > MAX_CACHE_BYTES) {
      return null;
    }
    const parsed = schema.safeParse(
      JSON.parse(cipher.open(userId, conversationId, `cache:${stamp}`, sealed)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    // Optional cache errors, stale ciphertext and unavailable Redis fall back to authoritative Postgres.
    return null;
  }
}

export async function writeChatCache(
  userId: string,
  conversationId: string,
  stamp: string,
  value: unknown,
  cipher: ChatCipher = chatCipher(),
): Promise<boolean> {
  const redis = cacheClient();
  if (!redis) {
    return false;
  }
  try {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_CACHE_BYTES / 2) {
      return false;
    }
    const sealed = cipher.seal(userId, conversationId, `cache:${stamp}`, text);
    await redis.set(cacheKey(cipher, userId, conversationId, stamp), sealed, { ex: CACHE_TTL_SECONDS });
    return true;
  } catch {
    return false;
  }
}
