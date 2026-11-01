import { afterEach, describe, expect, it, vi } from "vitest";
import { researchNews } from "./news";

vi.mock("server-only", () => ({}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("bounded news context", () => {
  it("distinguishes missing configuration from checked news", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    const result = await researchNews("perps", { symbols: ["NEAR"] }, new AbortController().signal);
    expect(result.status).toBe("not_configured");
    expect(result.articles).toHaveLength(0);
  });
  it("sends only public topics, preserves dated sources and treats missing dates as unverified", async () => {
    vi.stubEnv("TAVILY_API_KEY", "fixture-news-key");
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toBe("https://api.tavily.com/search");
      const body = JSON.parse(String(options?.body));
      expect(body.query).toContain("NEAR Protocol");
      expect(body.query).not.toContain("private.near");
      expect(body.query).not.toContain("1000");
      expect(body).toMatchObject({
        search_depth: "basic",
        auto_parameters: false,
        topic: "news",
        time_range: "week",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
      });
      return Response.json({
        results: [
          {
            title: "Protocol update",
            url: "https://example.org/dated",
            content: "<b>Reported development</b>",
            published_date: new Date(Date.now() - 3600000).toISOString(),
          },
          {
            title: "Undated opinion",
            url: "https://example.org/undated",
            published_date: null,
            content: null,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await researchNews(
      "perps",
      { symbols: ["NEAR", "private.near"], accountId: "private.near", amount: "1000" },
      new AbortController().signal,
    );
    expect(result.status).toBe("partial");
    expect(result.articles[0]?.snippet).toBe("Reported development");
    expect(result.articles[0]?.pageDate).not.toBeNull();
    expect(result.articles[1]?.pageDate).toBeNull();
  });
  it("does not turn a provider failure into a no-news claim", async () => {
    vi.stubEnv("TAVILY_API_KEY", "fixture-news-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream error", { status: 503 })));
    const result = await researchNews("lp_manager", { symbols: ["SOL"] }, new AbortController().signal);
    expect(result.status).toBe("unavailable");
    expect(result.note).toContain("Do not treat missing news");
  });
});
