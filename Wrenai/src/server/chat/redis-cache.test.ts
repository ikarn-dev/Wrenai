import { createSecretKey } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chatCipher } from "./cipher";
import { readChatCache, writeChatCache } from "./redis-cache";

const redis = vi.hoisted(() => ({ store: new Map<string, string>(), down: false }));
vi.mock("server-only", () => ({}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async get(key: string): Promise<string | null> {
      if (redis.down) {
        throw new Error("down");
      }
      return redis.store.get(key) ?? null;
    }
    async set(key: string, value: string): Promise<void> {
      if (redis.down) {
        throw new Error("down");
      }
      redis.store.set(key, value);
    }
  },
}));
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 23)));
const shape = z.object({ message: z.string() });
describe("encrypted optional chat cache", () => {
  beforeEach(() => {
    redis.store.clear();
    redis.down = false;
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("stores sealed text and isolates owner, conversation, revision and payload shape", async () => {
    expect(await writeChatCache("owner", "chat", "page:1", { message: "private text" }, cipher)).toBe(true);
    expect([...redis.store.values()].join()).not.toContain("private text");
    expect(await readChatCache("owner", "chat", "page:1", shape, cipher)).toEqual({
      message: "private text",
    });
    expect(await readChatCache("stranger", "chat", "page:1", shape, cipher)).toBeNull();
    expect(await readChatCache("owner", "other", "page:1", shape, cipher)).toBeNull();
    expect(await readChatCache("owner", "chat", "page:2", shape, cipher)).toBeNull();
    expect(await readChatCache("owner", "chat", "page:1", z.number(), cipher)).toBeNull();
    for (const key of redis.store.keys()) {
      redis.store.set(key, "tampered");
    }
    expect(await readChatCache("owner", "chat", "page:1", shape, cipher)).toBeNull();
  });
  it("treats Redis outages as cache misses without blocking durable storage", async () => {
    redis.down = true;
    expect(await writeChatCache("owner", "chat", "page:1", {}, cipher)).toBe(false);
    expect(await readChatCache("owner", "chat", "page:1", shape, cipher)).toBeNull();
  });
});
