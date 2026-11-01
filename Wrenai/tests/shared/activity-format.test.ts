import { describe, expect, it } from "vitest";
import { formatActivityAmount } from "@/shared/activity-format";

describe("activity amounts", () => {
  it("retains sub-display dust and full yocto precision without showing a false zero", () => {
    const amount = formatActivityAmount({
      kind: "token",
      units: "1",
      decimals: 24,
      symbol: "NEAR",
      direction: "in",
    });
    expect(amount.display).toBe("+<0.00000001 NEAR");
    expect(amount.full).toBe("+0.000000000000000000000001 NEAR");
    expect(
      formatActivityAmount({ kind: "token", units: "0", decimals: 24, symbol: "NEAR", direction: "out" })
        .display,
    ).toBe("0 NEAR");
  });
  it("uses known decimals, marks truncation and never guesses missing token precision", () => {
    expect(
      formatActivityAmount({
        kind: "token",
        units: "123456789123456789",
        decimals: 18,
        symbol: "TOKEN",
        direction: "out",
      }).display,
    ).toBe("−~0.12345678 TOKEN");
    expect(
      formatActivityAmount({
        kind: "token",
        units: "1234567",
        decimals: null,
        symbol: "Token",
        direction: "in",
      }).display,
    ).toBe("+1,234,567 Token base units");
  });
  it("distinguishes USD estimates from exact spending limits", () => {
    expect(formatActivityAmount({ kind: "usd", microUsd: "100000001", estimated: true }).display).toBe(
      "~$100.000001",
    );
    expect(formatActivityAmount({ kind: "usd", microUsd: "100000000", estimated: false }).display).toBe(
      "$100.00",
    );
  });
});
