import type { HlAccountState } from "@/server/execution/hyperliquid/account-state";
import type { HlMarket } from "@/server/execution/hyperliquid/market";
import { composePerpsOrder, type PerpsInstruction } from "@/server/execution/hyperliquid/order-plan";
import type { HlOrderRecord } from "@/server/execution/hyperliquid/order-record";
import { executionHash } from "@/server/execution/records";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { DEFAULT_POLICY, policySchema } from "@/shared/agents";

export const fixtureAddress = "0x1111111111111111111111111111111111111111";
export const fixtureAsset = "nep141:usdc.test-fixture.near";
export const perpsPolicy = policySchema.parse({
  ...DEFAULT_POLICY,
  budgetUsd: "50",
  maxTradeUsd: "25",
  dailyCapUsd: "100",
  cooldownSeconds: 0,
  maxProviderFeeBps: 50,
  allowRiskReducingExits: true,
});
export function perpsInstruction(overrides: Partial<PerpsInstruction> = {}): PerpsInstruction {
  const parsed = agentInstructionSchema.parse({
    format: 2,
    kind: "perps",
    market: "NEAR",
    collateralAssetId: fixtureAsset,
    action: "open",
    side: "long",
    quantity: "4",
    leverage: 4,
    marginMode: "isolated",
    maximumMarginUsd: "10",
    entry: { type: "market" },
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    exits: { stopLossPrice: "4", takeProfitPrice: "6", trailingStopBps: 500 },
    ...overrides,
  });
  if (parsed.kind !== "perps") {
    throw new Error("Expected a Perps fixture.");
  }
  return parsed;
}
export function marketFixture(overrides: Partial<HlMarket> = {}): HlMarket {
  return {
    asset: 7,
    name: "NEAR",
    sizeDecimals: 2,
    maxLeverage: 20,
    mark: "5",
    oracle: "5",
    funding: "0.00001",
    tiers: [{ lowerBound: "0", maxLeverage: 20 }],
    book: {
      coin: "NEAR",
      time: Date.now(),
      levels: [[{ px: "4.99", sz: "100", n: 3 }], [{ px: "5", sz: "100", n: 3 }]],
    },
    observedAt: Date.now(),
    ...overrides,
  };
}
export function accountFixture(cash = "19.9", overrides: Partial<HlAccountState> = {}): HlAccountState {
  const summary = { accountValue: cash, totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: cash };
  return {
    time: Date.now(),
    withdrawable: cash,
    crossMarginSummary: summary,
    marginSummary: summary,
    assetPositions: [],
    ...overrides,
  };
}
export function orderFixture(overrides: Partial<HlOrderRecord> = {}): HlOrderRecord {
  const instruction = perpsInstruction(),
    market = marketFixture(),
    requestId = "16c38b23-6a37-4aa5-835e-1ee46359db1a",
    order = composePerpsOrder(instruction, perpsPolicy, market, requestId, 19_900_000n);
  return {
    format: 1,
    address: fixtureAddress,
    instructionHash: executionHash(instruction),
    role: "entry",
    exitReason: null,
    action: order.action,
    leverage: order.leverage,
    market,
    account: accountFixture(),
    availableCashUnits: "19900000",
    beforeCashUnits: "19900000",
    requestedUnits: "400",
    beforeCollateralUnits: "0",
    beforeExposureUnits: "0",
    beforeCollateralPrincipal: "0",
    ...overrides,
  };
}
