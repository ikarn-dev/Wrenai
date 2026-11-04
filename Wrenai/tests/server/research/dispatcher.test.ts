import { beforeEach, describe, expect, it, vi } from "vitest";
import { runResearchTool } from "@/server/research/dispatcher";

const provider = vi.hoisted(() => ({ registry: vi.fn(), news: vi.fn(), quote: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/research/news", () => ({
  researchNews: provider.news,
}));
vi.mock("@/server/research/intents", async (original) => ({
  ...(await original<typeof import("@/server/research/intents")>()),
  intentTokens: provider.registry,
  drySwapQuote: provider.quote,
}));
describe("research validation failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.news.mockResolvedValue({
      status: "not_configured",
      query: "public topics",
      searchedAt: 1000,
      articles: [],
      note: "No news key",
    });
  });
  it("returns an unavailable result for invalid provider fields instead of failing the entire answer", async () => {
    provider.quote.mockResolvedValue({
      item: {
        id: "quote",
        title: "x".repeat(200),
        kind: "quote",
        status: "quoted",
        metrics: [],
        note: "",
        sourceIds: [],
      },
      sources: [],
    });
    const result = await runResearchTool(
      "research_dca",
      '{"symbols":["NEAR","USDC"]}',
      new AbortController().signal,
    );
    expect(result.status).toBe("unavailable");
    expect(result.items).toHaveLength(0);
    expect(provider.news).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid inputs before public data requests", async () => {
    const result = await runResearchTool(
      "research_rebalancer",
      '{"url":"http://internal"}',
      new AbortController().signal,
    );
    expect(result.status).toBe("unavailable");
    expect(provider.registry).not.toHaveBeenCalled();
    expect(provider.news).not.toHaveBeenCalled();
  });
  it("rejects removed Whale Tracker requests without reading markets or news", async () => {
    const result = await runResearchTool(
      "research_whale_tracker",
      '{"accountId":"watched.near"}',
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "unavailable", items: [] });
    expect(result.summary).toContain("removed");
    expect(provider.registry).not.toHaveBeenCalled();
    expect(provider.news).not.toHaveBeenCalled();
  });
  it.each(["dca", "spot_trader", "perps", "private_payments"])(
    "does not fetch markets or news for missing %s inputs",
    async (tool) => {
      const result = await runResearchTool(`research_${tool}`, "{}", new AbortController().signal);
      expect(result.status).toBe("unavailable");
      expect(result.summary).not.toContain("could not be validated");
      expect(provider.registry).not.toHaveBeenCalled();
      expect(provider.news).not.toHaveBeenCalled();
    },
  );
});
