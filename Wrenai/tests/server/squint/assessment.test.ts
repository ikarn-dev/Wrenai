import { hunterInstruction, reportFixture } from "@tests/server/squint/fixtures";
import { describe, expect, it } from "vitest";
import { screenMemeReport } from "@/server/squint/assessment";

const now = 1793788200000;
describe("mandatory Squint admission findings", () => {
  it("accepts a complete fresh fixture only within the reviewed age and concentration bounds", () => {
    expect(screenMemeReport(reportFixture(now), hunterInstruction(now), now).passed).toBe(true);
    expect(
      screenMemeReport(
        reportFixture(now, {
          holders: [{ account: "holder.near", share: "0.100000000000000000000000000000001", tags: [] }],
        }),
        hunterInstruction(now),
        now,
      ).passed,
    ).toBe(false);
    expect(
      screenMemeReport(
        reportFixture(now, { holders: [{ account: "holder.near", share: "0.1", tags: [] }] }),
        hunterInstruction(now),
        now,
      ).passed,
    ).toBe(true);
  });
  it.each(["copy", "dev", "history", "snipers", "linked", "top10", "fresh", "tax", "liquidity"])(
    "does not turn a clean score into a pass when %s is unknown",
    (id) => {
      const report = reportFixture(now);
      const changed = {
        ...report,
        checks: report.checks.map((check) => ({
          ...check,
          status: check.id === id ? ("unknown" as const) : check.status,
        })),
      };
      expect(screenMemeReport(changed, hunterInstruction(now), now).passed).toBe(false);
    },
  );
  it("rejects missing checks, incomplete traces and missing transfer history", () => {
    const report = reportFixture(now);
    for (const changed of [
      { ...report, checks: report.checks.slice(1) },
      { ...report, coverage: { ...report.coverage, transfers_complete: false } },
      { ...report, coverage: { ...report.coverage, wallets_traced: 19 } },
    ]) {
      expect(screenMemeReport(changed, hunterInstruction(now), now).passed).toBe(false);
    }
  });
  it("preserves report age and rejects future, expired, unscored and taxed evidence", () => {
    for (const changed of [
      { checked_at: new Date(now - 60000).toISOString() },
      { checked_at: new Date(now + 2000).toISOString() },
      { created_at: new Date(now - 3600001).toISOString() },
      { created_at: null },
      { risk: null },
      { tax: { status: "set", buy_pct: "0.0001", sell_pct: 0 } },
    ]) {
      expect(screenMemeReport(reportFixture(now, changed), hunterInstruction(now), now).passed).toBe(false);
    }
  });
  it("rejects contradictory shapes before they can become policy evidence", () => {
    const report = reportFixture(now);
    expect(() => reportFixture(now, { checks: [...report.checks, report.checks[0]] })).toThrow();
    expect(() =>
      reportFixture(now, { holders: [{ account: "holder.near", share: "1.0001", tags: [] }] }),
    ).toThrow();
    expect(() => reportFixture(now, { market: { ...report.market, holders: true } })).toThrow();
  });
});
