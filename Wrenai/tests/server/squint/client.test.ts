import { rawReport } from "@tests/server/squint/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { squintCoins, squintReport, squintToken } from "@/server/squint/client";

const io = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  cooldown: vi.fn(),
  cool: vi.fn(),
  meter: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/squint/quota", () => ({ consumeSquintQuota: io.meter }));
vi.mock("@/server/squint/cache", () => ({
  cachedSquint: io.read,
  cacheSquint: io.write,
  squintCooldown: io.cooldown,
  coolDownSquint: io.cool,
}));
beforeEach(() => {
  vi.resetAllMocks();
  io.read.mockResolvedValue(null);
  io.cooldown.mockResolvedValue(false);
  io.meter.mockResolvedValue("allowed");
  io.write.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", io.fetch);
});
afterEach(() => vi.unstubAllGlobals());
describe("bounded lossless Squint client", () => {
  it("uses exact contracts and retains tiny financial decimals without floating point", async () => {
    const raw = rawReport(Date.now());
    io.fetch.mockResolvedValue(
      new Response(
        JSON.stringify(raw).replace('"liquidity_near":10000', '"liquidity_near":0.0000000000000000000000001'),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const report = await squintReport("fixture.nearlytrade.near");
    expect(report.market.liquidity_near).toBe("0.0000000000000000000000001");
    expect(io.fetch.mock.calls[0]?.[0]).toBe(
      "https://api.nearsquint.tech/v1/tokens/fixture.nearlytrade.near",
    );
    expect(io.meter).toHaveBeenCalledWith(true);
    expect(io.write).toHaveBeenCalledTimes(1);
  });
  it("reuses validated cache evidence without changing checked_at or spending quota", async () => {
    const observedAt = Date.now() - 25000;
    const raw = rawReport(observedAt);
    io.read.mockResolvedValue(JSON.stringify(raw));
    expect((await squintReport("fixture.nearlytrade.near")).checked_at).toBe(
      new Date(observedAt).toISOString(),
    );
    expect(io.fetch).not.toHaveBeenCalled();
    expect(io.meter).not.toHaveBeenCalled();
  });
  it("never chooses the most-held contract for an ambiguous ticker", async () => {
    io.fetch.mockResolvedValue(
      Response.json({
        results: [
          { token: "a.nearlytrade.near", symbol: "SAME", name: "A" },
          { token: "b.nearlytrade.near", symbol: "SAME", name: "B" },
        ],
      }),
    );
    await expect(squintToken("SAME")).rejects.toMatchObject({ code: "ambiguous" });
    expect(io.fetch).toHaveBeenCalledTimes(1);
    expect(await squintToken("nep141:exact.nearlytrade.near")).toBe("exact.nearlytrade.near");
    expect(io.fetch).toHaveBeenCalledTimes(1);
    await expect(squintToken("https://untrusted.invalid")).rejects.toThrow();
  });
  it("fails closed on unavailable distributed quotas and honors provider cooldown", async () => {
    io.meter.mockResolvedValueOnce("unavailable");
    await expect(squintReport("fixture.nearlytrade.near")).rejects.toMatchObject({ code: "unavailable" });
    expect(io.fetch).not.toHaveBeenCalled();
    io.fetch.mockResolvedValue(new Response("limited", { status: 429, headers: { "retry-after": "90" } }));
    await expect(squintReport("fixture.nearlytrade.near")).rejects.toMatchObject({ code: "limited" });
    expect(io.cool).toHaveBeenCalledWith(90);
    io.cooldown.mockResolvedValue(true);
    await expect(squintReport("other.nearlytrade.near")).rejects.toMatchObject({ code: "limited" });
    expect(io.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not cache wrong identities, future timestamps, malformed JSON or oversized bodies", async () => {
    for (const raw of [
      rawReport(Date.now(), { token: "wrong.near" }),
      rawReport(Date.now() + 3000),
      { token: "missing" },
    ]) {
      io.fetch.mockResolvedValue(Response.json(raw));
      await expect(squintReport("fixture.nearlytrade.near")).rejects.toThrow();
    }
    io.fetch.mockResolvedValue(
      new Response(" ".repeat(2000001), { headers: { "content-type": "application/json" } }),
    );
    await expect(squintReport("fixture.nearlytrade.near")).rejects.toThrow("size");
    expect(io.write).not.toHaveBeenCalled();
  });
  it("coalesces concurrent reads while keeping cancellation local to each subscriber", async () => {
    let finish: ((value: Response) => void) | undefined;
    io.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const first = squintReport("fixture.nearlytrade.near", controller.signal);
    const rejected = expect(first).rejects.toThrow();
    const second = squintReport("fixture.nearlytrade.near");
    await vi.waitFor(() => expect(io.fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    if (!finish) {
      throw new Error("The provider request did not start.");
    }
    finish(Response.json(rawReport(Date.now())));
    await rejected;
    expect((await second).token).toBe("fixture.nearlytrade.near");
  });
  it("uses newest-first pagination and keeps unknown listing dates last", async () => {
    const coin = {
      token: "old.near",
      name: "Old",
      symbol: "OLD",
      created_at: "2026-11-01T00:00:00Z",
      holders: 1,
      holders_capped: false,
      liquidity_near: null,
      fdv_usd: null,
      verdict: null,
      risk: null,
      launchpad: "other",
    };
    io.fetch.mockResolvedValue(
      Response.json({
        total: 3,
        count: 3,
        offset: 0,
        sort: "age",
        dir: "desc",
        coins: [
          { ...coin, token: "unknown.near", created_at: null },
          coin,
          { ...coin, token: "new.near", created_at: "2026-11-03T00:00:00Z" },
        ],
      }),
    );
    expect((await squintCoins()).map((value) => value.token)).toEqual([
      "new.near",
      "old.near",
      "unknown.near",
    ]);
    expect(io.fetch.mock.calls[0]?.[0]).toContain("sort=age&dir=desc&limit=100&offset=0");
  });
});
