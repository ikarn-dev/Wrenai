import { describe, expect, it, vi } from "vitest";
import { candidateCycles } from "./arbitrage";
import { compare, decimal, displayDecimal, percent, ratio, tokenUnits } from "./decimal";
import type { RheaPool } from "./rhea";

vi.mock("server-only", () => ({}));
function pool(id: string, from: string, to: string, x: string, y: string): RheaPool {
  return {
    id,
    pool_kind: "SIMPLE_POOL",
    token_account_ids: [from, to],
    amounts: [x, y],
    total_fee: 30,
    tvl: "10000",
  };
}
describe("exact market math", () => {
  it("preserves large/scientific API numbers and token precision", () => {
    expect(tokenUnits("1.000000000000000000000001", 24)).toBe(1000000000000000000000001n);
    expect(compare(decimal("1.234567890123456789e-9"), decimal("0.000000001234567890123456789"))).toBe(0);
    expect(displayDecimal(ratio(decimal("1"), decimal("3")), 8)).toBe("0.33333333");
    expect(() => tokenUnits("0.0000001", 6)).toThrow("precision");
  });
  it("never formats signed zero or scientific financial displays", () => {
    expect(percent(decimal("-0.00000001"))).toBe("−<0.01%");
    expect(displayDecimal(decimal("0"), 8)).toBe("0");
    expect(displayDecimal(decimal("1e25"), 0)).not.toContain("e+");
  });
  it("finds only fee-adjusted cycles using distinct reserve IDs", () => {
    const near = "wrap.near",
      usd = "usdc.near";
    expect(candidateCycles([pool("1", near, usd, "1000", "1000")])).toHaveLength(0);
    expect(
      candidateCycles([pool("1", near, usd, "1000", "1000"), pool("2", near, usd, "1000", "1000")]),
    ).toHaveLength(0);
    const cycles = candidateCycles([
      pool("1", near, usd, "1000", "2000"),
      pool("2", near, usd, "1000", "1000"),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.edges.map((edge) => edge.pool.id)).toEqual(["1", "2"]);
  });
});
