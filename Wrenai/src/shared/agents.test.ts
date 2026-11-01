import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, parseUsd, policySchema, strategySchema, usdInputSchema } from "./agents";

describe("agent inputs and strategy boundaries", () => {
  it("preserves exact dollar precision, including values beyond Number's precise micro-dollar range", () => {
    expect(parseUsd("999999999.123456")).toBe(999999999123456n);
    expect(parseUsd("0.000001")).toBe(1n);
  });
  it.each(["0", "-1", "1e3", "Infinity", "1.0000001", "01", "1,000", "  "])(
    "rejects invalid dollar input %s",
    (value) => {
      expect(usdInputSchema.safeParse(value).success).toBe(false);
    },
  );
  it("validates user limits independently of model output", () => {
    expect(policySchema.safeParse(DEFAULT_POLICY).success).toBe(true);
    expect(policySchema.safeParse({ ...DEFAULT_POLICY, maxTradeUsd: "101" }).success).toBe(false);
    expect(policySchema.safeParse({ ...DEFAULT_POLICY, maxSlippageBps: 501 }).success).toBe(false);
    expect(policySchema.safeParse({ ...DEFAULT_POLICY, approvalMode: "unrestricted" }).success).toBe(false);
    expect(policySchema.safeParse({ ...DEFAULT_POLICY, signingKey: "malicious" }).success).toBe(false);
    for (const budgetUsd of ["1e9", "invalid", "", "1,000", "Infinity"]) {
      expect(policySchema.safeParse({ ...DEFAULT_POLICY, budgetUsd }).success).toBe(false);
    }
  });
  it("defaults new agents to autonomous limits without broadening legacy approvals or fee permissions", () => {
    expect(DEFAULT_POLICY.approvalMode).toBe("autonomous");
    const legacy = { ...DEFAULT_POLICY, approvalMode: "every_action" };
    const { maxProviderFeeBps: _fee, ...withoutFeeAllowance } = legacy;
    expect(policySchema.parse(withoutFeeAllowance)).toMatchObject({
      approvalMode: "every_action",
      maxProviderFeeBps: 0,
    });
    expect(policySchema.parse({ ...DEFAULT_POLICY, maxProviderFeeBps: 20 }).maxProviderFeeBps).toBe(20);
  });
  const targets = [
    { symbol: "NEAR", weightBps: 5000 },
    { symbol: "USDC", weightBps: 5000 },
  ];
  const rebalance = { kind: "rebalancer", targets, driftBps: 500, intervalSeconds: 300 };
  it("rejects duplicate targets, unbalanced allocations and unsupported tokens", () => {
    expect(strategySchema.safeParse(rebalance).success).toBe(true);
    expect(strategySchema.safeParse({ ...rebalance, targets: [targets[0], targets[0]] }).success).toBe(false);
    expect(
      strategySchema.safeParse({ ...rebalance, targets: [{ symbol: "NEAR", weightBps: 9999 }, targets[1]] })
        .success,
    ).toBe(false);
    expect(
      strategySchema.safeParse({ ...rebalance, targets: [{ symbol: "DOGE", weightBps: 5000 }, targets[1]] })
        .success,
    ).toBe(false);
  });
  const trigger = {
    kind: "triggers",
    asset: "NEAR",
    quoteAsset: "USDC",
    condition: "buy_above",
    triggerPriceUsd: "4",
    orderSizeUsd: "10",
    takeProfitPriceUsd: "5",
    stopLossPriceUsd: "3",
    trailingStopBps: null,
    maxChaseBps: 100,
    confirmationSeconds: 0,
    expiresAt: "2027-01-01T00:00:00.000Z",
    rearm: false,
  };
  it("requires valid entry/exit relationships and refuses extra model permissions", () => {
    expect(strategySchema.safeParse(trigger).success).toBe(true);
    expect(strategySchema.safeParse({ ...trigger, takeProfitPriceUsd: "3" }).success).toBe(false);
    expect(strategySchema.safeParse({ ...trigger, stopLossPriceUsd: "5" }).success).toBe(false);
    expect(strategySchema.safeParse({ ...trigger, approvalMode: "autonomous" }).success).toBe(false);
    expect(strategySchema.safeParse({ ...trigger, triggerPriceUsd: "1e3" }).success).toBe(false);
    expect(strategySchema.safeParse({ ...trigger, takeProfitPriceUsd: "invalid" }).success).toBe(false);
  });
});
