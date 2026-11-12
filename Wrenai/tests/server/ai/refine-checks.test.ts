import { describe, expect, it } from "vitest";
import { rewriteProblems } from "@/server/ai/refine-checks";

describe("refine rewrite checks", () => {
  it("accepts a faithful rewrite with exact per-order amounts", () => {
    expect(
      rewriteProblems(
        "buy near using 2 usdc in 3 trades",
        "Spend 2 USDC to buy NEAR now at the current market price, split into 3 orders of 0.666666 USDC each, one every 60 seconds.",
        [],
      ),
    ).toEqual([]);
  });
  it("rejects a renamed token and a rounded per-order amount", () => {
    const problems = rewriteProblems(
      "buy near using 2 usdc in 3 trades",
      "Spend 2 USDC to buy wNEAR now, split into 3 orders of 0.66 USDC each (total 2 USDC).",
      [],
    );
    expect(problems.some((p) => p.includes("wNEAR"))).toBe(true);
    expect(problems.some((p) => p.includes("0.666666"))).toBe(true);
  });
  it("requires every token contract to survive verbatim", () => {
    const original = "Spend 1 USDC once to buy usdt.tether-token.near";
    expect(rewriteProblems(original, "Spend 1 USDC once to buy USDT at the market price.", [])).toEqual([
      "Keep the token contract usdt.tether-token.near exactly as written.",
    ]);
    expect(
      rewriteProblems(original, "Spend 1 USDC once to buy usdt.tether-token.near at the market price.", []),
    ).toEqual([]);
  });
  it("allows the selected budget token and plain words like USD", () => {
    expect(
      rewriteProblems(
        "buy ETH when it is below $3000",
        "Spend 1 USDC to buy ETH when its USD price is at or below $3000.",
        ["USDC"],
      ),
    ).toEqual([]);
  });
});
