import { describe, expect, it } from "vitest";
import {
  agentBudgetInputSchema,
  budgetTokenAmount,
  checkedWalletBudget,
  walletBudgetAvailability,
} from "@/shared/agent-budget";

const holding = {
  assetId: "nep141:unknown-token.near",
  symbol: "SAME",
  decimals: 18,
  balanceUnits: "10000000000000000000",
  spendableUnits: "10000000000000000000",
  observedAt: 10_000,
  blockHeight: 500,
};
describe("exact-token agent budgets", () => {
  it("reserves an arbitrary held token without a price, registry entry or floating-point conversion", () => {
    const input = { assetId: holding.assetId, amount: "1.000000000000000001" };
    const budget = checkedWalletBudget("owner.near", input, holding, 0n, 10_001);
    expect(budget.units).toBe("1000000000000000001");
    expect(budgetTokenAmount(budget.units, 18)).toBe(input.amount);
    expect(budgetTokenAmount("1", 36)).toBe(`0.${"0".repeat(35)}1`);
  });
  it("deducts existing allocations and exposes deficits after an external withdrawal", () => {
    expect(walletBudgetAvailability(holding, 7n * 10n ** 18n)).toMatchObject({
      allocatedUnits: "7000000000000000000",
      availableUnits: "3000000000000000000",
      deficitUnits: "0",
    });
    expect(walletBudgetAvailability(holding, 12n * 10n ** 18n)).toMatchObject({
      availableUnits: "0",
      deficitUnits: "2000000000000000000",
    });
    expect(() =>
      checkedWalletBudget(
        "owner.near",
        { assetId: holding.assetId, amount: "4" },
        holding,
        7n * 10n ** 18n,
        10_001,
      ),
    ).toThrow("available");
  });
  it("allows reducing an existing reservation after a shortfall, but never increasing it", () => {
    const remaining = { ...holding, spendableUnits: "1" };
    expect(
      checkedWalletBudget(
        "owner.near",
        { assetId: holding.assetId, amount: "2" },
        remaining,
        0n,
        10_001,
        3n * 10n ** 18n,
      ).units,
    ).toBe("2000000000000000000");
    expect(() =>
      checkedWalletBudget(
        "owner.near",
        { assetId: holding.assetId, amount: "4" },
        remaining,
        0n,
        10_001,
        3n * 10n ** 18n,
      ),
    ).toThrow("available");
  });
  it("rejects stale/future, wrong-token, zero and over-precision amounts", () => {
    const input = { assetId: holding.assetId, amount: "1" };
    for (const time of [9999, 25_000]) {
      expect(() => checkedWalletBudget("owner.near", input, holding, 0n, time)).toThrow("expired");
    }
    expect(() =>
      checkedWalletBudget("owner.near", { ...input, assetId: "nep141:other.near" }, holding, 0n, 10_001),
    ).toThrow();
    for (const amount of ["0", "1.0000000000000000001", "1e2", "-1"]) {
      expect(() => checkedWalletBudget("owner.near", { ...input, amount }, holding, 0n, 10_001)).toThrow();
    }
    expect(agentBudgetInputSchema.safeParse({ ...input, availableUnits: "90000" }).success).toBe(false);
  });
});
