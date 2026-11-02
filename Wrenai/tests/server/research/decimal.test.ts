import { describe, expect, it, vi } from "vitest";
import { compare, decimal, displayDecimal, percent, ratio, tokenUnits } from "@/server/research/decimal";

vi.mock("server-only", () => ({}));
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
});
