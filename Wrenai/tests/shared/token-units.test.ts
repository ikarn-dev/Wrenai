import { describe, expect, it } from "vitest";
import { parseTokenAmount } from "@/shared/token-units";

describe("exact token input", () => {
  it("keeps integer precision beyond JavaScript's safe range", () => {
    expect(parseTokenAmount("1.000000000000000000000001", 24)).toBe(1000000000000000000000001n);
    expect(parseTokenAmount("999999999999999999", 0)).toBe(999999999999999999n);
  });
  it("rejects rounded, scientific, negative, zero and oversized inputs", () => {
    for (const value of ["0.0000001", "1e3", "-1", "0", "9".repeat(78)]) {
      expect(() => parseTokenAmount(value, 6)).toThrow();
    }
  });
});
