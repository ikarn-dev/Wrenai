import { reportFixture } from "@tests/server/squint/fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memeResearch } from "@/server/research/memes";
import { SquintUnavailable } from "@/server/squint/contracts";
import { researchReportSchema } from "@/shared/research";

const io = vi.hoisted(() => ({ coins: vi.fn(), report: vi.fn(), token: vi.fn(), registry: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/squint/client", () => ({
  squintCoins: io.coins,
  squintReport: io.report,
  squintToken: io.token,
}));
vi.mock("@/server/research/intents", () => ({ intentTokens: io.registry }));
beforeEach(() => {
  vi.resetAllMocks();
  io.registry.mockResolvedValue({ tokens: [] });
  io.token.mockImplementation(async (value: string) => value);
  io.report.mockResolvedValue(reportFixture(Date.now()));
});
describe("Squint-backed meme research", () => {
  it("shows actual newest listings and bounded reports without implying every indexed token can trade", async () => {
    io.coins.mockResolvedValue(
      ["first", "second", "third"].map((name, index) => ({
        token: `${name}.nearlytrade.near`,
        symbol: name,
        name,
        created_at: new Date(Date.now() - index * 60000).toISOString(),
        holders: 1,
        holders_capped: false,
        liquidity_near: "10",
        fdv_usd: null,
        verdict: null,
        risk: null,
        launchpad: "nearly",
      })),
    );
    io.report.mockImplementation(async (token: string) => reportFixture(Date.now(), { token }));
    const result = await memeResearch({ symbols: [] });
    expect(io.report).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(3);
    expect(result.items[0]?.metrics).toContainEqual({ label: "Intents registry", value: "Not listed" });
    expect(result.items[2]?.status).toBe("indicative");
    expect(result.items[2]?.note).toContain("no safety pass");
    expect(() =>
      researchReportSchema.parse({
        tool: "meme_hunter",
        status: "partial",
        observedAt: Date.now(),
        ...result,
      }),
    ).not.toThrow();
  });
  it("retains visible listings when a cold report fails and never fabricates a pass", async () => {
    io.coins.mockResolvedValue([
      {
        token: "fixture.nearlytrade.near",
        symbol: "FIX",
        name: "Fixture",
        created_at: new Date().toISOString(),
        holders: 1,
        holders_capped: false,
        liquidity_near: "10",
        fdv_usd: null,
        verdict: null,
        risk: null,
        launchpad: "nearly",
      },
    ]);
    io.report.mockRejectedValue(new SquintUnavailable("limited", "Risk scans are cooling down."));
    const result = await memeResearch({ symbols: [] });
    expect(result.items[0]?.status).toBe("indicative");
    expect(result.limitations.join(" ")).toContain("risk report unavailable");
  });
  it("does not spend report quota on an ambiguous ticker or a broad six-token request", async () => {
    io.token.mockRejectedValue(new SquintUnavailable("ambiguous", "Specify the exact token contract."));
    await expect(memeResearch({ symbols: ["SAME"] })).rejects.toMatchObject({ code: "ambiguous" });
    expect(io.report).not.toHaveBeenCalled();
    io.registry.mockClear();
    await expect(memeResearch({ symbols: ["A", "B", "C"] })).rejects.toMatchObject({ code: "ambiguous" });
    expect(io.registry).not.toHaveBeenCalled();
  });
  it("deduplicates aliases resolved to the same exact contract", async () => {
    io.token.mockResolvedValue("fixture.nearlytrade.near");
    const result = await memeResearch({ symbols: ["FIX", "fixture.nearlytrade.near"] });
    expect(io.report).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
    expect(result.sources).toHaveLength(1);
  });
});
