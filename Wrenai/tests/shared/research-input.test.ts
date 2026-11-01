import { describe, expect, it } from "vitest";
import { researchInputSchema, researchToolSchema } from "@/shared/research";
import { researchInputIssue } from "@/shared/research-input";

describe("essential public research inputs", () => {
  it.each(researchToolSchema.options)("rejects zero amounts and missing units for %s", (tool) => {
    expect(researchInputIssue(tool, researchInputSchema.parse({ amount: "0.000" }))).toContain(
      "greater than zero",
    );
    expect(researchInputIssue(tool, researchInputSchema.parse({ amount: "10" }))).toContain("which asset");
  });
  it("does not invent a pair, choose equal assets or accept an unrelated amount unit", () => {
    expect(researchInputIssue("triggers", { symbols: ["NEAR"] })).toContain("both assets");
    expect(researchInputIssue("triggers", { symbols: ["NEAR", "near"] })).toContain("different assets");
    expect(
      researchInputIssue("triggers", { symbols: ["NEAR", "USDC"], amount: "1", amountAsset: "BTC" }),
    ).toContain("requested pair");
    expect(researchInputIssue("triggers", { symbols: ["NEAR", "USDC"] })).toBeNull();
  });
  it("requires a public leader, recipient or market instead of silently picking one", () => {
    expect(researchInputIssue("perps", { symbols: [] })).toContain("Which perpetual market");
    expect(researchInputIssue("copy_trading", { symbols: [] })).toContain("public account");
    expect(researchInputIssue("private_payments", { symbols: [] })).toContain("recipient");
    expect(
      researchInputIssue("private_payments", { symbols: [], accountId: `0x${"a".repeat(40)}` }),
    ).toContain("NEAR recipient");
    expect(researchInputIssue("private_payments", { symbols: [], accountId: "owner.near" })).toBeNull();
    expect(researchInputIssue("yield_optimizer", { symbols: [] })).toBeNull();
  });
});
