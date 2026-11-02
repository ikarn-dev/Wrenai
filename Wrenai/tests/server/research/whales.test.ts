import { beforeEach, describe, expect, it, vi } from "vitest";
import { whaleResearch } from "@/server/research/whales";

const provider = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/activity/wallet", () => ({ walletActivityPage: provider.page }));
beforeEach(() => vi.resetAllMocks());
describe("bounded public whale research", () => {
  it("includes only confirmed events and does not turn unknown decimals into an amount", async () => {
    const event = {
      id: "public-event",
      title: "Tokens received",
      description: "Public transfer",
      status: "completed",
      amount: { kind: "token", units: "1000000", symbol: "TOKEN", decimals: null },
    };
    provider.page.mockResolvedValue({
      items: [event, { ...event, id: "pending-event", status: "pending" }],
      next: null,
      total: 2,
    });
    const signal = new AbortController().signal;
    const report = await whaleResearch({ accountId: "watched.near", symbols: [] }, signal);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.metrics.some((metric) => metric.label === "Amount")).toBe(false);
    expect(report.items[0]?.note).toContain("not proof");
    expect(report.limitations.join(" ")).toContain("not chain-wide");
    expect(provider.page).toHaveBeenCalledWith(
      "watched.near",
      "tokens",
      expect.any(Object),
      expect.any(Number),
      signal,
    );
  });
  it("does not call the provider without an explicit supported account or after cancellation", async () => {
    await expect(whaleResearch({ symbols: [] }, new AbortController().signal)).rejects.toThrow("explicit");
    const controller = new AbortController();
    controller.abort();
    await expect(
      whaleResearch({ accountId: "watched.near", symbols: [] }, controller.signal),
    ).rejects.toThrow();
    expect(provider.page).not.toHaveBeenCalled();
  });
});
