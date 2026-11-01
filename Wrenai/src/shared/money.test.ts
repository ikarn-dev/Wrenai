import { describe, expect, it } from "vitest";
import { formatCompactMicroUsd, formatExactMicroUsd, formatMicroUsd, formatUnits } from "./money";

const NEAR = { decimals: 24, fractionDigits: 4 } as const;

describe("formatUnits", () => {
  it("formats whole and fractional NEAR with fixed digits", () => {
    expect(formatUnits(10n ** 24n, NEAR)).toBe("1.0000");
    expect(formatUnits(1_234_567n * 10n ** 21n, NEAR)).toBe("1,234.5670");
  });

  it("rounds toward zero instead of up", () => {
    expect(formatUnits(999_999n, { decimals: 6, fractionDigits: 2 })).toBe("0.99");
  });

  it("uses a real minus sign for negative values", () => {
    expect(formatUnits(-1_500_000n, { decimals: 6, fractionDigits: 2 })).toBe("\u22121.50");
  });

  it("drops the sign when the displayed value is zero", () => {
    expect(formatUnits(-1n, { decimals: 6, fractionDigits: 2 })).toBe("0.00");
  });

  it("supports zero fraction digits", () => {
    expect(formatUnits(12_345_678n, { decimals: 3, fractionDigits: 0 })).toBe("12,345");
  });

  it("rejects fraction digits beyond the asset's decimals", () => {
    expect(() => formatUnits(1n, { decimals: 2, fractionDigits: 3 })).toThrow(RangeError);
  });
});

describe("formatMicroUsd", () => {
  it("formats dollars with cents", () => {
    expect(formatMicroUsd(12_500_000n)).toBe("$12.50");
    expect(formatMicroUsd(1_000_000_000n)).toBe("$1,000.00");
  });

  it("puts the minus sign before the dollar sign", () => {
    expect(formatMicroUsd(-2_000_000n)).toBe("\u2212$2.00");
  });
});

describe("compact budget values", () => {
  it("shows exact configured price levels without rounding a trigger or tiny value to zero", () => {
    expect(formatExactMicroUsd(123_456n)).toBe("$0.123456");
    expect(formatExactMicroUsd(1n)).toBe("$0.000001");
    expect(formatExactMicroUsd(4_600_000n)).toBe("$4.60");
    expect(formatExactMicroUsd(0n)).toBe("$0.00");
    expect(formatExactMicroUsd(-1n)).toBe("−$0.000001");
  });
  it("keeps zero, tiny values and ordinary amounts distinct", () => {
    expect(formatCompactMicroUsd(0n)).toBe("$0.00");
    expect(formatCompactMicroUsd(1n)).toBe("<$0.01");
    expect(formatCompactMicroUsd(12_500_000n)).toBe("$12.50");
  });
  it("abbreviates large values without overstating the amount", () => {
    expect(formatCompactMicroUsd(1_299_999_999n)).toBe("$1.2K");
    expect(formatCompactMicroUsd(999_999_999_123_456n)).toBe("$999.9M");
    expect(formatCompactMicroUsd(-1_500_000_000n)).toBe("−$1.5K");
  });
});
