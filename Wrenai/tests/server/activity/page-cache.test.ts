import { createSecretKey } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ActivitySlot, loadActivityOnce, readActivityCache } from "@/server/activity/page-cache";
import type { ActivityPage } from "@/shared/activity";

const redis = vi.hoisted(() => ({
  store: new Map<string, { readonly value: string; readonly ex: number }>(),
  down: false,
  tasks: [] as Promise<unknown>[],
}));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({
  after: (task: () => Promise<unknown>) => {
    redis.tasks.push(task());
  },
}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async get(key: string): Promise<string | null> {
      if (redis.down) {
        throw new Error("down");
      }
      return redis.store.get(key)?.value ?? null;
    }
    async set(key: string, value: string, options: { readonly ex: number }): Promise<void> {
      if (redis.down) {
        throw new Error("down");
      }
      redis.store.set(key, { value, ex: options.ex });
    }
  },
}));

const head: ActivitySlot = { ownerId: "owner", filter: "all", cursor: null };
const page: ActivityPage = {
  items: [
    {
      id: "agent:1",
      source: "agents",
      category: "agent",
      title: "Agent paused",
      description: "Private strategy note",
      status: "recorded",
      occurredAt: 1_793_000_000_000,
      agent: null,
      transactionHash: null,
      amount: null,
    },
  ],
  nextCursor: null,
  snapshotAt: 1_793_000_000_001,
  unavailable: [],
};

async function load(slot: ActivitySlot, value: ActivityPage): Promise<ActivityPage> {
  const result = await loadActivityOnce(slot, async () => value);
  await Promise.all(redis.tasks);
  return result;
}

describe("activity page cache", () => {
  beforeEach(() => {
    redis.store.clear();
    redis.tasks = [];
    redis.down = false;
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("stores the newest page sealed and briefly, and serves it only to its owner and filter", async () => {
    await load(head, page);
    const [stored] = [...redis.store.values()];
    expect(stored?.value).not.toContain("Private strategy note");
    expect(stored?.ex).toBe(30);
    expect(await readActivityCache(head)).toEqual(page);
    expect(await readActivityCache({ ...head, ownerId: "stranger" })).toBeNull();
    expect(await readActivityCache({ ...head, filter: "wallet" })).toBeNull();
  });

  it("does not cache a page with a missing source, so the next read retries it", async () => {
    await load(head, { ...page, unavailable: ["Token transfers"] });
    expect(redis.store.size).toBe(0);
  });

  it("shares one source read between concurrent requests for the same page", async () => {
    let reads = 0;
    const read = async (): Promise<ActivityPage> => {
      reads += 1;
      return page;
    };
    const [first, second] = await Promise.all([loadActivityOnce(head, read), loadActivityOnce(head, read)]);
    expect(reads).toBe(1);
    expect(second).toBe(first);
    await Promise.all(redis.tasks);
  });

  it("treats a Redis outage or tampered value as a miss", async () => {
    await load(head, page);
    for (const [key, entry] of redis.store) {
      redis.store.set(key, { ...entry, value: "tampered" });
    }
    expect(await readActivityCache(head)).toBeNull();
    redis.down = true;
    expect(await readActivityCache(head)).toBeNull();
    expect(await load(head, page)).toEqual(page);
  });
});
