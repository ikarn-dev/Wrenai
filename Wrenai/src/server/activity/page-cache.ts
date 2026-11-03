import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { Redis } from "@upstash/redis";
import { after } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/server/env";
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityCursor,
  type ActivityFilter,
  type ActivityPage,
  activityCursorSchema,
  activityEntrySchema,
} from "@/shared/activity";

// The newest page is shared by Portfolio and Activity, so repeat visits within this window skip the indexer and
// Postgres. Refresh bypasses it. Pages behind a cursor are bounded by their snapshot time, so they keep longer.
const HEAD_TTL_SECONDS = 30;
const CURSOR_TTL_SECONDS = 300;
const MAX_CACHE_CHARS = 200_000;

const pageSchema = z.strictObject({
  items: z.array(activityEntrySchema).max(ACTIVITY_PAGE_SIZE),
  nextCursor: activityCursorSchema.nullable(),
  snapshotAt: z.number().int(),
  unavailable: z.array(z.string().max(64)).max(8),
});

export interface ActivitySlot {
  readonly ownerId: string;
  readonly filter: ActivityFilter;
  readonly cursor: ActivityCursor | null;
}

interface CacheStore {
  readonly redis: Redis;
  readonly key: KeyObject;
}

function cacheStore(): CacheStore | null {
  const config = z
    .object({
      UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }),
      UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
    })
    .safeParse(process.env);
  if (!config.success) {
    return null;
  }
  // Domain-separated from chat and delegated-key encryption under the same master.
  const derived = createHmac("sha256", serverEnv().keyEncryptionKey)
    .update("wrenai-activity:cache:v1")
    .digest();
  const key = createSecretKey(derived);
  derived.fill(0);
  return {
    key,
    // A short timeout and no retries: a slow cache must never cost more than reading the sources directly.
    redis: new Redis({
      url: config.data.UPSTASH_REDIS_REST_URL,
      token: config.data.UPSTASH_REDIS_REST_TOKEN,
      retry: false,
      automaticDeserialization: false,
      signal: () => AbortSignal.timeout(750),
    }),
  };
}

/** Opaque Redis key: owner, filter and cursor are hashed, so the key reveals neither account nor position. */
function slotId(store: CacheStore, slot: ActivitySlot): string {
  return createHmac("sha256", store.key)
    .update(JSON.stringify([slot.ownerId, slot.filter, slot.cursor]))
    .digest("hex");
}

function seal(store: CacheStore, id: string, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", store.key, iv);
  cipher.setAAD(Buffer.from(`wrenai-activity:v1:${id}`));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function open(store: CacheStore, id: string, sealed: string): string {
  const blob = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", store.key, blob.subarray(0, 12));
  decipher.setAAD(Buffer.from(`wrenai-activity:v1:${id}`));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}

/** A cached page for this slot, or null on a miss, an outage, tampering or a page that isn't this owner's. */
export async function readActivityCache(slot: ActivitySlot): Promise<ActivityPage | null> {
  try {
    const store = cacheStore();
    if (store === null) {
      return null;
    }
    const id = slotId(store, slot);
    const sealed = await store.redis.get<string>(`wrenai:activity:v1:${id}`);
    if (typeof sealed !== "string" || sealed.length > MAX_CACHE_CHARS) {
      return null;
    }
    const page = pageSchema.parse(JSON.parse(open(store, id, sealed)));
    return page.nextCursor === null || page.nextCursor.ownerId === slot.ownerId ? page : null;
  } catch {
    // The cache is optional: outages, stale keys and bad ciphertext fall back to the authoritative sources.
    return null;
  }
}

async function writeActivityCache(slot: ActivitySlot, page: ActivityPage): Promise<void> {
  // A page with a missing source is not cached, so the next read retries that source instead of hiding it.
  if (page.unavailable.length > 0) {
    return;
  }
  try {
    const store = cacheStore();
    if (store === null) {
      return;
    }
    const id = slotId(store, slot);
    const sealed = seal(store, id, JSON.stringify(page));
    if (sealed.length > MAX_CACHE_CHARS) {
      return;
    }
    await store.redis.set(`wrenai:activity:v1:${id}`, sealed, {
      ex: slot.cursor === null ? HEAD_TTL_SECONDS : CURSOR_TTL_SECONDS,
    });
  } catch {
    // A failed write only costs the next reader a source read; the page itself is already correct.
  }
}

const inflight = new Map<string, Promise<ActivityPage>>();

/**
 * Reads the sources once per slot at a time: concurrent requests for the same page (Portfolio and Activity
 * rendering together, double clicks) share one read, and the result is written back for the next request.
 */
export function loadActivityOnce(
  slot: ActivitySlot,
  load: () => Promise<ActivityPage>,
): Promise<ActivityPage> {
  const key = JSON.stringify([slot.ownerId, slot.filter, slot.cursor]);
  const running = inflight.get(key);
  if (running !== undefined) {
    return running;
  }
  const read = load()
    .then((page) => {
      // After the response is sent, so the cache write never adds to this request's latency.
      after(() => writeActivityCache(slot, page));
      return page;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, read);
  return read;
}
