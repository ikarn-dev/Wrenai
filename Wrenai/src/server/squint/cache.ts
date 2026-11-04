import "server-only";
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { z } from "zod";

const MAX_TEXT = 2_000_000;
export function squintRedis(): Redis | null {
  const env = z
    .object({
      UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }),
      UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
    })
    .safeParse(process.env);
  return env.success
    ? new Redis({
        url: env.data.UPSTASH_REDIS_REST_URL,
        token: env.data.UPSTASH_REDIS_REST_TOKEN,
        retry: false,
        automaticDeserialization: false,
        signal: () => AbortSignal.timeout(750),
      })
    : null;
}
function key(path: string): string {
  return `wrenai:squint:v1:${createHash("sha256").update(path).digest("hex")}`;
}
export async function cachedSquint(path: string): Promise<string | null> {
  try {
    const redis = squintRedis();
    if (!redis) {
      return null;
    }
    const text = await redis.get<string>(key(path));
    return typeof text === "string" && text.length <= MAX_TEXT ? text : null;
  } catch {
    return null;
  }
}
export async function cacheSquint(path: string, text: string, seconds: number): Promise<void> {
  if (text.length > MAX_TEXT) {
    return;
  }
  try {
    await squintRedis()?.set(key(path), text, { ex: seconds });
  } catch {
    /* Optional public-data cache; the validated provider response remains usable. */ return;
  }
}
export async function squintCooldown(): Promise<boolean> {
  try {
    return (await squintRedis()?.exists("wrenai:squint:cooldown:v1")) === 1;
  } catch {
    return false;
  }
}
export async function coolDownSquint(seconds: number): Promise<void> {
  try {
    await squintRedis()?.set("wrenai:squint:cooldown:v1", "1", {
      ex: Math.min(604800, Math.max(60, seconds)),
    });
  } catch {
    /* Shared request budgets still fail closed if Redis is unavailable. */ return;
  }
}
