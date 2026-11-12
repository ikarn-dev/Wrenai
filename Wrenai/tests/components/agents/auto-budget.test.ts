import { describe, expect, it } from "vitest";
import { suggestBudget } from "@/components/agents/auto-budget";
import { resolveInstructionBudget } from "@/components/agents/use-instruction-budget";
import { parseBudgetHint } from "@/shared/budget-hint";

const USDC = { assetId: "nep141:usdc.near", symbol: "USDC", decimals: 6, availableUnits: "5000000" };
const ETH = { assetId: "nep141:eth.near", symbol: "ETH", decimals: 18 };

describe("budget suggestion", () => {
  it("sets the token and total the instructions imply", () => {
    const hint = parseBudgetHint("Spend 0.5 USDC to buy ETH 4 times", true);
    expect(suggestBudget(hint, [USDC, ETH])?.budget).toEqual({ assetId: USDC.assetId, amount: "2" });
  });
  it("caps a total above what is available to the most whole orders that fit", () => {
    const suggestion = suggestBudget(parseBudgetHint("Spend 0.75 USDC every minute for 1 hour", true), [
      USDC,
    ]);
    expect(suggestion?.budget.amount).toBe("4.5");
    expect(suggestion?.note).toContain("6 orders");
  });
  it("gives no amount for an ambiguous or unknown token, or too many decimals", () => {
    const twice = [USDC, { ...USDC, assetId: "nep141:other.near" }];
    expect(suggestBudget(parseBudgetHint("Spend 1 USDC once", false), twice)).toBeNull();
    expect(suggestBudget(parseBudgetHint("Spend 1 DOGE once", false), [USDC])).toBeNull();
    expect(suggestBudget(parseBudgetHint("Spend 0.0000001 USDC once", false), [USDC])?.budget.amount).toBe(
      "",
    );
  });
  it("follows the instructions until the user chooses, then offers them back", () => {
    const suggestion = suggestBudget(parseBudgetHint("Spend 1 USDC once", false), [USDC]);
    const apply = (): void => undefined;
    expect(resolveInstructionBudget(suggestion, null, false, apply).budget?.amount).toBe("1");
    const mine = { assetId: USDC.assetId, amount: "3" };
    const chosen = resolveInstructionBudget(suggestion, mine, true, apply);
    expect(chosen.budget).toBe(mine);
    expect(chosen.note?.onApply).toBe(apply);
    expect(resolveInstructionBudget(suggestion, { ...mine, amount: "1" }, true, apply).note).toBeNull();
  });
});
