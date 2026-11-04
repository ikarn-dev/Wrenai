import { testDatabase } from "@tests/server/db/test-database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordPortfolioHistory } from "@/server/portfolio/history";
import type { PortfolioValuation } from "@/server/portfolio/valuation";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof testDatabase>> | null = null;
afterEach(async () => {
  if (context) {
    await context.postgres.close();
    context = null;
  }
});
function value(at: number, total: bigint | null, settling = false): PortfolioValuation {
  return { locations: [], knownMicroUsd: total ?? 100n, totalMicroUsd: total, settling, observedAt: at };
}
describe("actual observed portfolio history", () => {
  it("keeps one latest point per interval, preserves missing-data gaps and isolates owners", async () => {
    context = await testDatabase();
    const start = Math.floor(Date.now() / 300000) * 300000;
    await recordPortfolioHistory(context.db, "owner", value(start + 1, 100n));
    await recordPortfolioHistory(context.db, "owner", value(start + 2, 101n));
    expect(await recordPortfolioHistory(context.db, "owner", value(start + 300001, null))).toEqual([
      { at: start + 2, valueMicroUsd: 101n },
      { at: start + 300001, valueMicroUsd: null },
    ]);
    expect(await recordPortfolioHistory(context.db, "owner", value(start + 600001, 200n, true))).toHaveLength(
      3,
    );
    expect(await recordPortfolioHistory(context.db, "stranger", value(start + 1, 500n))).toEqual([
      { at: start + 1, valueMicroUsd: 500n },
    ]);
  });
});
