import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicLeaderFeed } from "./explorer";

const transport = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), budget: vi.fn(), request: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    get = transport.get;
    set = transport.set;
  },
}));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: transport.budget }));
vi.mock("./market-http", () => ({ marketJson: transport.request }));

beforeEach(() => {
  vi.stubEnv("ONECLICK_EXPLORER_JWT", "offline-explorer-token");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "offline-redis-token");
  transport.get.mockReset().mockResolvedValue(null);
  transport.set.mockReset().mockResolvedValue("OK");
  transport.budget.mockReset().mockResolvedValue("allowed");
  transport.request.mockReset().mockImplementation(async () => ({ capturedAt: Date.now(), value: [] }));
});
afterEach(() => vi.unstubAllEnvs());

describe("shared read-only Explorer transport", () => {
  it("shares a fresh public snapshot without spending another provider request", async () => {
    const feed = { capturedAt: Date.now(), swaps: [] };
    transport.get.mockResolvedValue(feed);
    expect(await publicLeaderFeed()).toEqual(feed);
    expect(transport.budget).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("uses a fixed documented endpoint and an opaque cache key after the shared budget passes", async () => {
    expect((await publicLeaderFeed()).swaps).toEqual([]);
    expect(transport.budget).toHaveBeenCalledWith("1click-explorer:public-near-feed", 1, 5000);
    expect(transport.request).toHaveBeenCalledWith(
      "1Click Explorer",
      "https://explorer.near-intents.org/api/v0/transactions?numberOfTransactions=1000&fromChainId=near",
      { headers: { Authorization: "Bearer offline-explorer-token" } },
    );
    expect(transport.set.mock.calls[0]?.[0]).not.toContain("offline-explorer-token");
  });

  it("waits rather than bypassing a busy partner request window", async () => {
    transport.budget.mockResolvedValue("limited");
    await expect(publicLeaderFeed()).rejects.toMatchObject({ code: "conflict" });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("fails closed on missing configuration, bad data, cache failure and provider errors", async () => {
    transport.get.mockRejectedValue(new Error("private provider detail"));
    await expect(publicLeaderFeed()).rejects.toMatchObject({
      code: "not_ready",
      message: "The public leader feed could not be refreshed or validated.",
    });
    transport.get.mockResolvedValue(null);
    transport.request.mockResolvedValue({
      capturedAt: Date.now(),
      value: [{ status: "SUCCESS", amountIn: "1e6" }],
    });
    await expect(publicLeaderFeed()).rejects.toMatchObject({ code: "not_ready" });
    expect(transport.set).not.toHaveBeenCalled();
    vi.stubEnv("ONECLICK_EXPLORER_JWT", "");
    await expect(publicLeaderFeed()).rejects.toMatchObject({ code: "not_ready" });
  });
});
