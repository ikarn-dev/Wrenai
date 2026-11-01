import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeRateLimit } from "@/server/http/rate-limit";

const redis = vi.hoisted(() => ({ eval: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    eval = redis.eval;
  },
}));

describe("shared request protection", () => {
  beforeEach(() => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://test.upstash.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-only-token");
    redis.eval.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("maps the shared atomic decision and uses an opaque stable key", async () => {
    redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await consumeRateLimit("sign-in:192.0.2.1", 10, 60_000)).toBe("allowed");
    expect(await consumeRateLimit("sign-in:192.0.2.1", 10, 60_000)).toBe("limited");
    const keys = redis.eval.mock.calls.map((call) => call[1]);
    expect(keys[0]).toEqual(keys[1]);
    expect(JSON.stringify(keys)).not.toContain("192.0.2.1");
  });

  it("fails closed and distinguishes infrastructure failure from exhausted quota", async () => {
    redis.eval.mockRejectedValue(new Error("provider response"));
    expect(await consumeRateLimit("agents:owner", 4, 60_000)).toBe("unavailable");
    redis.eval.mockResolvedValue("unexpected");
    expect(await consumeRateLimit("agents:owner", 4, 60_000)).toBe("unavailable");
  });

  it("does not contact Redis when credentials are missing", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    expect(await consumeRateLimit("agents:owner", 4, 60_000)).toBe("unavailable");
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
