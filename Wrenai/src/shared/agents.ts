import { z } from "zod";
import { agentBudgetInputSchema } from "./agent-budget";
import { AGENT_CATALOG } from "./agent-catalog";
import { agentInstructionSchema, instructionAssetSchema } from "./agent-instructions";
import { activeAgentToolSchema } from "./agent-scope";
import { tradeAssetSchema } from "./trade-preview";

export const PACKS = {
  private_payments: {
    label: AGENT_CATALOG.private_payments.name,
    description: AGENT_CATALOG.private_payments.description,
  },
  dca: { label: AGENT_CATALOG.dca.name, description: AGENT_CATALOG.dca.description },
  spot_trader: { label: AGENT_CATALOG.spot_trader.name, description: AGENT_CATALOG.spot_trader.description },
  perps: { label: AGENT_CATALOG.perps.name, description: AGENT_CATALOG.perps.description },
  meme_hunter: { label: AGENT_CATALOG.meme_hunter.name, description: AGENT_CATALOG.meme_hunter.description },
  whale_tracker: {
    label: AGENT_CATALOG.whale_tracker.name,
    description: AGENT_CATALOG.whale_tracker.description,
  },
  buy_the_dip: { label: AGENT_CATALOG.buy_the_dip.name, description: AGENT_CATALOG.buy_the_dip.description },
  sell_the_top: {
    label: AGENT_CATALOG.sell_the_top.name,
    description: AGENT_CATALOG.sell_the_top.description,
  },
  rebalancer: { label: AGENT_CATALOG.rebalancer.name, description: AGENT_CATALOG.rebalancer.description },
  triggers: { label: AGENT_CATALOG.triggers.name, description: AGENT_CATALOG.triggers.description },
  copy_trading: {
    label: AGENT_CATALOG.copy_trading.name,
    description: AGENT_CATALOG.copy_trading.description,
  },
} as const;

export const symbolSchema = z.enum(["NEAR", "BTC", "ETH", "SOL", "USDC", "USDT"]);
export type AssetSymbol = z.infer<typeof symbolSchema>;
export const AGENT_PACK_NAMES = [
  "rebalancer",
  "triggers",
  "copy_trading",
  "whale_tracker",
  ...activeAgentToolSchema.options,
] as const;
export const packSchema = z.enum(AGENT_PACK_NAMES);
export const approvalSchema = z.enum(["autonomous", "above_size", "every_action"]);
export const statusSchema = z.enum(["paused", "running", "stopped", "error"]);

// Decimal inputs are exact strings; never coerce financial values through Number.
const USD_PATTERN = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;
export const usdInputSchema = z
  .string()
  .trim()
  .regex(USD_PATTERN, "Enter a dollar amount with up to 6 decimal places.")
  .pipe(z.string().refine((value) => parseUsd(value) > 0n, "Enter an amount greater than zero."));

export function parseUsd(value: string): bigint {
  if (!USD_PATTERN.test(value)) {
    throw new RangeError("Invalid USD decimal string");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

const bps = z.number().int().min(1).max(10_000);
const price = usdInputSchema;
const rebalancerSchema = z.strictObject({
  kind: z.literal("rebalancer"),
  targets: z
    .array(z.strictObject({ symbol: symbolSchema, weightBps: bps }))
    .min(2)
    .max(6),
  driftBps: z.number().int().min(10).max(5000),
  intervalSeconds: z.number().int().min(60).max(86400),
});
const triggersSchema = z.strictObject({
  kind: z.literal("triggers"),
  asset: symbolSchema.exclude(["USDC", "USDT"]),
  quoteAsset: z.enum(["USDC", "USDT"]),
  condition: z.enum(["buy_below", "buy_above"]),
  triggerPriceUsd: price,
  orderSizeUsd: usdInputSchema,
  takeProfitPriceUsd: price.nullable(),
  stopLossPriceUsd: price.nullable(),
  trailingStopBps: bps.nullable(),
  maxChaseBps: z.number().int().min(0).max(2000),
  confirmationSeconds: z.number().int().min(0).max(300),
  expiresAt: z.iso.datetime(),
  rearm: z.boolean(),
});

const copyTradingSchema = z.strictObject({
  kind: z.literal("copy_trading"),
  leaderAccountId: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  assets: z.array(symbolSchema).min(2).max(6),
  orderSizeUsd: usdInputSchema,
  maxSignalAgeSeconds: z.number().int().min(60).max(600),
  maxPriceDeviationBps: z.number().int().min(0).max(500),
  expiresAt: z.iso.datetime(),
});
const strategyFieldsSchema = z.discriminatedUnion("kind", [
  rebalancerSchema,
  triggersSchema,
  copyTradingSchema,
]);
// Object-level refinements can run after a child reports a continuable error. A pipeline keeps
// all financial comparisons behind complete structural and decimal validation.
const legacyStrategySchema = strategyFieldsSchema.pipe(
  strategyFieldsSchema.superRefine((config, context) => {
    if (config.kind === "rebalancer") {
      if (new Set(config.targets.map((target) => target.symbol)).size !== config.targets.length) {
        context.addIssue({ code: "custom", message: "Each asset can have only one target." });
      }
      if (config.targets.reduce((sum, target) => sum + target.weightBps, 0) !== 10_000) {
        context.addIssue({ code: "custom", message: "Allocation targets must total 100%." });
      }
    } else if (config.kind === "triggers") {
      const entry = parseUsd(config.triggerPriceUsd);
      if (config.takeProfitPriceUsd !== null && parseUsd(config.takeProfitPriceUsd) <= entry) {
        context.addIssue({ code: "custom", message: "Take profit must be above the entry price." });
      }
      if (config.stopLossPriceUsd !== null && parseUsd(config.stopLossPriceUsd) >= entry) {
        context.addIssue({ code: "custom", message: "Stop loss must be below the entry price." });
      }
    } else if (new Set(config.assets).size !== config.assets.length) {
      context.addIssue({ code: "custom", message: "Each copied asset can be listed only once." });
    }
  }),
);
export const strategySchema = z.union([legacyStrategySchema, agentInstructionSchema]);
export type Strategy = z.infer<typeof strategySchema>;

export function strategySymbols(strategy: Strategy): readonly AssetSymbol[] {
  if ("format" in strategy) {
    return [];
  }
  switch (strategy.kind) {
    case "rebalancer":
      return strategy.targets.map((target) => target.symbol);
    case "triggers":
      return [strategy.asset, strategy.quoteAsset];
    case "copy_trading":
      return strategy.assets;
    default: {
      const unreachable: never = strategy;
      return unreachable;
    }
  }
}

const policyFieldsSchema = z.strictObject({
  budgetUsd: usdInputSchema,
  maxTradeUsd: usdInputSchema,
  dailyCapUsd: usdInputSchema,
  approvalMode: approvalSchema,
  approvalThresholdUsd: usdInputSchema,
  maxSlippageBps: z.number().int().min(1).max(500),
  maxProviderFeeBps: z.number().int().min(0).max(2000),
  maxTradesPerHour: z.number().int().min(1).max(60),
  cooldownSeconds: z.number().int().min(0).max(86400),
  allowRiskReducingExits: z.boolean().optional(),
});
const reviewedPolicySchema = policyFieldsSchema.pipe(
  policyFieldsSchema.superRefine((policy, context) => {
    if (parseUsd(policy.maxTradeUsd) > parseUsd(policy.budgetUsd)) {
      context.addIssue({
        code: "custom",
        path: ["maxTradeUsd"],
        message: "Trade limit must fit within the budget.",
      });
    }
    if (parseUsd(policy.maxTradeUsd) > parseUsd(policy.dailyCapUsd)) {
      context.addIssue({
        code: "custom",
        path: ["dailyCapUsd"],
        message: "Daily cap must cover at least one trade.",
      });
    }
  }),
);
// Existing policies never granted a partner-fee allowance. Preserve that conservative meaning on read.
export const policySchema = z.preprocess((value) => {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !("maxProviderFeeBps" in value)
  ) {
    return { ...value, maxProviderFeeBps: 0 };
  }
  return value;
}, reviewedPolicySchema);
export type AgentPolicy = z.infer<typeof policySchema>;
export const DEFAULT_POLICY: AgentPolicy = {
  budgetUsd: "100",
  maxTradeUsd: "10",
  dailyCapUsd: "50",
  approvalMode: "autonomous",
  approvalThresholdUsd: "10",
  maxSlippageBps: 50,
  maxProviderFeeBps: 0,
  maxTradesPerHour: 6,
  cooldownSeconds: 60,
};
export const strategyTextSchema = z
  .string()
  .trim()
  .min(20, "Describe the assets, targets and conditions in at least 20 characters.")
  .max(4000)
  .refine(
    (text) => !/\{\{[^{}]+\}\}/.test(text),
    "Fill in the template fields marked with {{...}} before review.",
  );
export const parseStrategyInputSchema = z.strictObject({
  requestId: z.uuid(),
  pack: packSchema,
  strategyText: strategyTextSchema,
  budget: agentBudgetInputSchema.optional(),
});
export const saveAgentSchema = z.strictObject({
  requestId: z.uuid(),
  draftId: z.uuid(),
  policy: policySchema,
  agentId: z.uuid().nullable(),
  expectedRevision: z.number().int().positive().nullable(),
  setupId: z.uuid().optional(),
  setupHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const saveAgentWithBudgetSchema = saveAgentSchema.extend({
  budget: agentBudgetInputSchema.nullable(),
});
export const agentCommandSchema = z
  .strictObject({
    requestId: z.uuid(),
    agentId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    command: z.enum(["pause", "resume", "stop", "clone", "delete", "claim"]),
    /**
     * Claim only: the NEAR token to receive the agent's funds in, or "held" to send each token as held.
     * Omitted keeps the current choice (as held for a first claim).
     */
    receiveAssetId: z.union([z.literal("held"), instructionAssetSchema]).optional(),
  })
  .refine((input) => input.receiveAssetId === undefined || input.command === "claim", {
    message: "Only a claim chooses a receive token.",
  });

/** What the Agents list shows per agent; read with a narrow query and parsed again in the browser. */
export const agentCardSchema = z.object({
  id: z.uuid(),
  name: z.string().max(120),
  pack: packSchema,
  status: statusSchema,
  reason: z.string().max(400),
  strategyText: z.string().max(4000),
  budgetUsd: z.string().max(40),
  returningFunds: z.boolean(),
});
export type AgentCardItem = z.infer<typeof agentCardSchema>;
/** `deleted` is true when a delete removed the agent at once because it held nothing. */
export const agentCommandResultSchema = z.object({ agentId: z.uuid(), deleted: z.boolean() });
export type AgentCommandResult = z.infer<typeof agentCommandResultSchema>;
export const agentListSchema = z.object({
  agents: z.array(agentCardSchema).max(100).readonly(),
  stop: z.object({ engaged: z.boolean(), revision: z.number().int().nonnegative() }),
});
export type AgentList = z.infer<typeof agentListSchema>;
export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly pack: z.infer<typeof packSchema>;
  readonly status: z.infer<typeof statusSchema>;
  readonly reason: string;
  readonly revision: number;
  readonly version: number;
  readonly strategyText: string;
  readonly strategy: Strategy;
  readonly policy: AgentPolicy;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The owner's claim is sending its funds to the wallet. */
  readonly returningFunds: boolean;
  /** Deleted by the owner; it disappears once it holds nothing, and its funds wait in Claims. */
  readonly deleting: boolean;
}

export const agentFailureCodeSchema = z.enum([
  "signed_out",
  "rate_limited",
  "invalid_input",
  "not_found",
  "conflict",
  "in_progress",
  "unavailable",
  "verification_failed",
  "not_ready",
]);
export type AgentFailureCode = z.infer<typeof agentFailureCodeSchema>;
export type AgentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: AgentFailureCode; readonly message: string };
/** A verified strategy review. Parsed again in the browser, since it arrives from a route handler. */
export const strategyDraftSchema = z.object({
  id: z.uuid(),
  strategy: strategySchema,
  strategyText: z.string().max(4000),
  model: z.string().max(200),
  verifiedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  assets: z.array(tradeAssetSchema).max(6).readonly().optional(),
});
export type StrategyDraft = z.infer<typeof strategyDraftSchema>;
/** A rewritten instruction and the result of checking it: a verified draft ready to deploy, or what to fix. */
/** Refine's reply: the rewritten instructions only. Checking happens once, when the user continues. */
export const strategyRefinementSchema = z.object({
  text: z.string().max(1000),
  /** A short remark, such as a better-suited agent type; never a question. */
  note: z.string().max(200).nullable(),
});
export type StrategyRefinement = z.infer<typeof strategyRefinementSchema>;
