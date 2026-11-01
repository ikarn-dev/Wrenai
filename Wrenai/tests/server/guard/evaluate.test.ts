import { describe, expect, it } from "vitest";
import { evaluateGuard } from "@/server/guard/evaluate";
import type {
  GuardContext,
  GuardLimits,
  GuardRule,
  GuardUsage,
  GuardVerdict,
  Proposal,
} from "@/server/guard/types";

const USD = 1_000_000n;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const WNEAR = "nep141:wrap.near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "proposal-1",
    agentId: "agent-1",
    tier: "private",
    kind: "swap",
    purpose: "entry",
    sellAssetId: USDC,
    buyAssetId: WNEAR,
    destination: { type: "confidential" },
    amountMicroUsd: 8n * USD,
    slippageBps: 50,
    edge: { expectedGainMicroUsd: 2n * USD, costMicroUsd: USD / 10n },
    ...overrides,
  };
}

function context(
  overrides: {
    readonly limits?: Partial<GuardLimits>;
    readonly usage?: Partial<GuardUsage>;
  } & Partial<Omit<GuardContext, "limits" | "usage">> = {},
): GuardContext {
  const { limits, usage, ...rest } = overrides;
  return {
    now: NOW,
    killSwitchEngaged: false,
    agentStatus: "running",
    requiresPositiveEdge: true,
    newCapitalMicroUsd: 8n * USD,
    allowedAssetIds: new Set([WNEAR, USDC]),
    allowedChains: new Set(["near", "eth"]),
    approval: { mode: "autonomous", granted: false },
    ...rest,
    limits: {
      maxTradeMicroUsd: 10n * USD,
      userDailyCapMicroUsd: 30n * USD,
      agentDailyCapMicroUsd: 20n * USD,
      maxSlippageBps: 100,
      maxTradesPerHour: 4,
      approvalThresholdMicroUsd: 5n * USD,
      ...limits,
    },
    usage: {
      userSpent24hMicroUsd: 0n,
      agentSpent24hMicroUsd: 0n,
      agentCommittedMicroUsd: 0n,
      agentBudgetMicroUsd: 50n * USD,
      agentTradesLastHour: 0,
      agentLastTradeAt: null,
      agentCooldownMs: 0,
      ...usage,
    },
  };
}

function expectBlocked(verdict: GuardVerdict, rule: GuardRule): void {
  expect(verdict.status).toBe("blocked");
  if (verdict.status === "blocked") {
    expect(verdict.rule).toBe(rule);
  }
}

describe("evaluateGuard", () => {
  it("blocks partner fees until explicitly covered by the configured cap", () => {
    expectBlocked(evaluateGuard(proposal({ providerFeeBps: 20 }), context()), "provider_fee");
    expect(
      evaluateGuard(proposal({ providerFeeBps: 20 }), context({ limits: { maxProviderFeeBps: 20 } })).status,
    ).toBe("approved");
    expectBlocked(
      evaluateGuard(proposal({ providerFeeBps: 21 }), context({ limits: { maxProviderFeeBps: 20 } })),
      "provider_fee",
    );
  });
  it("approves a proposal that passes every rule", () => {
    expect(evaluateGuard(proposal(), context()).status).toBe("approved");
  });

  describe("rule 1: schema", () => {
    it("blocks free text and malformed proposals", () => {
      expectBlocked(evaluateGuard("buy 500 NEAR now", context()), "schema");
      expectBlocked(evaluateGuard({ ...proposal(), amountMicroUsd: 8 }, context()), "schema");
      expectBlocked(evaluateGuard({ ...proposal(), extra: "field" }, context()), "schema");
      expectBlocked(evaluateGuard({ ...proposal(), requiresPositiveEdge: false }, context()), "schema");
    });

    it("does not let a proposal opt out of its strategy's edge requirement", () => {
      expectBlocked(evaluateGuard(proposal({ edge: null }), context()), "edge_gate");
      expectBlocked(evaluateGuard(proposal({ purpose: "exit", edge: null }), context()), "edge_gate");
    });

    it("allows DCA entries and risk-reducing exits under a trusted cost-bounded policy", () => {
      const bounded = context({ requiresPositiveEdge: false });
      expect(evaluateGuard(proposal({ edge: null }), bounded).status).toBe("approved");
      expect(evaluateGuard(proposal({ purpose: "exit", edge: null }), bounded).status).toBe("approved");
      expectBlocked(evaluateGuard(proposal({ edge: null, slippageBps: 150 }), bounded), "slippage");
    });
  });

  describe("rule 2: kill switch and agent status", () => {
    it("blocks everything while the kill switch is on", () => {
      expectBlocked(evaluateGuard(proposal(), context({ killSwitchEngaged: true })), "kill_switch");
    });

    it("blocks a paused or stopped agent", () => {
      expectBlocked(evaluateGuard(proposal(), context({ agentStatus: "paused" })), "agent_status");
      expectBlocked(evaluateGuard(proposal(), context({ agentStatus: "stopped" })), "agent_status");
    });
  });

  describe("rule 3: allowlist and tier", () => {
    it("blocks a token that isn't allowlisted", () => {
      expectBlocked(evaluateGuard(proposal({ buyAssetId: "nep141:meme.near" }), context()), "allowlist");
    });

    it("blocks a chain destination that isn't allowlisted", () => {
      const verdict = evaluateGuard(
        proposal({ tier: "public", destination: { type: "chain", chain: "sol", address: "So1" } }),
        context(),
      );
      expectBlocked(verdict, "allowlist");
    });

    it("allows a public-tier agent to send to an allowlisted chain", () => {
      const verdict = evaluateGuard(
        proposal({ tier: "public", destination: { type: "chain", chain: "eth", address: "0xabc" } }),
        context(),
      );
      expect(verdict.status).toBe("approved");
    });

    it("blocks a Private-tier agent from unshielding or sending outside the confidential balance", () => {
      expectBlocked(
        evaluateGuard(proposal({ kind: "unshield", purpose: "exit", edge: null }), context()),
        "tier",
      );
      expectBlocked(evaluateGuard(proposal({ destination: { type: "intents" } }), context()), "tier");
    });
  });

  describe("rule 4: max per trade", () => {
    it("blocks a trade over the limit and allows one exactly at it", () => {
      expectBlocked(evaluateGuard(proposal({ amountMicroUsd: 500n * USD }), context()), "max_trade");
      expect(evaluateGuard(proposal({ amountMicroUsd: 10n * USD }), context()).status).toBe("approved");
    });

    it("states the amounts in the reason", () => {
      const verdict = evaluateGuard(proposal({ amountMicroUsd: 500n * USD }), context());
      expect(verdict.status === "blocked" && verdict.reason).toBe(
        "Blocked: $500.00 is over your $10.00 per-trade limit",
      );
    });
  });

  describe("rule 5: rolling 24-hour caps", () => {
    it("blocks when the user's 24-hour total would pass the cap", () => {
      expectBlocked(
        evaluateGuard(proposal(), context({ usage: { userSpent24hMicroUsd: 25n * USD } })),
        "daily_cap",
      );
    });

    it("blocks when the agent's 24-hour total would pass its cap", () => {
      expectBlocked(
        evaluateGuard(proposal(), context({ usage: { agentSpent24hMicroUsd: 15n * USD } })),
        "daily_cap",
      );
    });

    it("allows a trade that lands exactly on the cap", () => {
      const verdict = evaluateGuard(proposal(), context({ usage: { userSpent24hMicroUsd: 22n * USD } }));
      expect(verdict.status).toBe("approved");
    });
  });

  describe("rule 6: budget and cooldown", () => {
    it("blocks when spent plus reserved would pass the agent's budget", () => {
      expectBlocked(
        evaluateGuard(proposal(), context({ usage: { agentCommittedMicroUsd: 45n * USD } })),
        "budget",
      );
    });

    it("does not charge funded swaps twice against attributed capital", () => {
      const funded = context({ newCapitalMicroUsd: 0n, usage: { agentCommittedMicroUsd: 50n * USD } });
      expect(evaluateGuard(proposal(), funded).status).toBe("approved");
      expectBlocked(evaluateGuard(proposal({ amountMicroUsd: 11n * USD }), funded), "max_trade");
      expectBlocked(evaluateGuard(proposal(), context({ newCapitalMicroUsd: -1n })), "budget");
      expectBlocked(evaluateGuard({ ...proposal(), newCapitalMicroUsd: 0n }, context()), "schema");
    });

    it("blocks during the cooldown and allows once it has passed", () => {
      const cooling = context({ usage: { agentLastTradeAt: NOW - 30_000, agentCooldownMs: 60_000 } });
      expectBlocked(evaluateGuard(proposal(), cooling), "cooldown");
      const cooled = context({ usage: { agentLastTradeAt: NOW - 60_000, agentCooldownMs: 60_000 } });
      expect(evaluateGuard(proposal(), cooled).status).toBe("approved");
    });
  });

  describe("rule 7: slippage", () => {
    it("blocks slippage over the limit", () => {
      expectBlocked(evaluateGuard(proposal({ slippageBps: 150 }), context()), "slippage");
    });
  });

  describe("rule 8: edge gate", () => {
    it("blocks when the expected gain doesn't beat the cost", () => {
      const edge = { expectedGainMicroUsd: USD, costMicroUsd: USD };
      expectBlocked(evaluateGuard(proposal({ edge }), context()), "edge_gate");
    });

    it("also applies to a rebalance that states an edge", () => {
      const edge = { expectedGainMicroUsd: 0n, costMicroUsd: USD };
      expectBlocked(evaluateGuard(proposal({ purpose: "rebalance", edge }), context()), "edge_gate");
    });
  });

  describe("rule 9: rate limit", () => {
    it("blocks once the agent has used its trades for the hour", () => {
      expectBlocked(evaluateGuard(proposal(), context({ usage: { agentTradesLastHour: 4 } })), "rate_limit");
      expect(evaluateGuard(proposal(), context({ usage: { agentTradesLastHour: 3 } })).status).toBe(
        "approved",
      );
    });
  });

  describe("rule 10: approval", () => {
    it("asks before every action in every_action mode until approved", () => {
      const asking = context({ approval: { mode: "every_action", granted: false } });
      expect(evaluateGuard(proposal(), asking).status).toBe("needs_approval");
      const approved = context({ approval: { mode: "every_action", granted: true } });
      expect(evaluateGuard(proposal(), approved).status).toBe("approved");
    });

    it("asks only above the threshold in above_size mode", () => {
      const mode = context({ approval: { mode: "above_size", granted: false } });
      expect(evaluateGuard(proposal({ amountMicroUsd: 8n * USD }), mode).status).toBe("needs_approval");
      expect(evaluateGuard(proposal({ amountMicroUsd: 5n * USD }), mode).status).toBe("approved");
    });

    it("never lets an approval override an earlier block", () => {
      const verdict = evaluateGuard(
        proposal({ amountMicroUsd: 500n * USD }),
        context({ approval: { mode: "every_action", granted: true } }),
      );
      expectBlocked(verdict, "max_trade");
    });
  });

  it("stops at the first failing rule", () => {
    const verdict = evaluateGuard(
      proposal({ amountMicroUsd: 500n * USD, slippageBps: 900 }),
      context({ killSwitchEngaged: true }),
    );
    expectBlocked(verdict, "kill_switch");
  });
});
