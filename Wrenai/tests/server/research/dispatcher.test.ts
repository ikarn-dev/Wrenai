import { beforeEach, describe, expect, it, vi } from "vitest";
import { runResearchTool } from "@/server/research/dispatcher";

const provider = vi.hoisted(() => ({ registry: vi.fn(), news: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/research/news", () => ({
  researchNews: provider.news,
}));
vi.mock("@/server/research/intents", async (original) => ({
  ...(await original<typeof import("@/server/research/intents")>()),
  intentTokens: provider.registry,
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
    provider.registry.mockResolvedValue({
      tokens: [
        {
          assetId: "nep141:long.near",
          symbol: "TOKEN".repeat(100),
          blockchain: "near",
          decimals: 24,
          price: "1",
        },
      ],
      source: { id: "intents-tokens", label: "Registry", url: "https://example.org", observedAt: 1000 },
    });
    const result = await runResearchTool(
      "research_rebalancer",
      '{"symbols":["nep141:long.near"]}',
      new AbortController().signal,
    );
    expect(result.status).toBe("unavailable");
    expect(result.items).toHaveLength(0);
    expect(result.news?.status).toBe("not_configured");
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
  it.each(["triggers", "perps", "copy_trading", "private_payments"])(
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
