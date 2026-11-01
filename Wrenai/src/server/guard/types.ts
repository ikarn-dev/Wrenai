import { z } from "zod";

// Proposal and Guard contract: Docs/wrenai-spec.md §5. All USD values are micro-USD (bigint).

const microUsd = z.bigint().nonnegative();

const destinationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("confidential") }),
  z.strictObject({ type: z.literal("intents") }),
  z.strictObject({ type: z.literal("chain"), chain: z.string().min(1), address: z.string().min(1) }),
]);

export const proposalSchema = z.strictObject({
  id: z.string().min(1),
  agentId: z.string().min(1),
  tier: z.enum(["private", "public"]),
  kind: z.enum(["swap", "limit_order", "shield", "unshield"]),
  // This describes the action; trusted strategy context decides whether an economic edge is required.
  purpose: z.enum(["entry", "exit", "rebalance"]),
  sellAssetId: z.string().min(1),
  buyAssetId: z.string().min(1),
  destination: destinationSchema,
  amountMicroUsd: z.bigint().positive(),
  slippageBps: z.number().int().min(0).max(10_000),
  providerFeeBps: z.number().int().min(0).max(2000).optional(),
  edge: z.strictObject({ expectedGainMicroUsd: microUsd, costMicroUsd: microUsd }).nullable(),
});

export type Proposal = z.infer<typeof proposalSchema>;

export type ApprovalMode = "autonomous" | "above_size" | "every_action";
export type AgentStatus = "running" | "paused" | "stopped";

export interface GuardLimits {
  readonly maxTradeMicroUsd: bigint;
  readonly userDailyCapMicroUsd: bigint;
  readonly agentDailyCapMicroUsd: bigint;
  readonly maxSlippageBps: number;
  readonly maxProviderFeeBps?: number;
  readonly maxTradesPerHour: number;
  readonly approvalThresholdMicroUsd: bigint;
}

export interface GuardUsage {
  readonly userSpent24hMicroUsd: bigint;
  readonly agentSpent24hMicroUsd: bigint;
  /** Attributed principal plus pending new-capital commitments, supplied by trusted accounting. */
  readonly agentCommittedMicroUsd: bigint;
  readonly agentBudgetMicroUsd: bigint;
  readonly agentTradesLastHour: number;
  readonly agentLastTradeAt: number | null;
  readonly agentCooldownMs: number;
}

export interface GuardContext {
  /** UTC epoch milliseconds. */
  readonly now: number;
  readonly killSwitchEngaged: boolean;
  readonly agentStatus: AgentStatus;
  /** Compiled from trusted strategy/action policy, never selected by the proposal or LLM. */
  readonly requiresPositiveEdge: boolean;
  /** Incremental principal from trusted attribution logic. An already-funded owned-asset swap uses zero. */
  readonly newCapitalMicroUsd: bigint;
  readonly allowedAssetIds: ReadonlySet<string>;
  readonly allowedChains: ReadonlySet<string>;
  readonly limits: GuardLimits;
  readonly usage: GuardUsage;
  readonly approval: { readonly mode: ApprovalMode; readonly granted: boolean };
}

export type GuardRule =
  | "schema"
  | "kill_switch"
  | "agent_status"
  | "allowlist"
  | "tier"
  | "max_trade"
  | "daily_cap"
  | "budget"
  | "cooldown"
  | "slippage"
  | "provider_fee"
  | "edge_gate"
  | "rate_limit";

export type GuardVerdict =
  | { readonly status: "approved"; readonly proposal: Proposal }
  | { readonly status: "needs_approval"; readonly proposal: Proposal; readonly reason: string }
  | { readonly status: "blocked"; readonly rule: GuardRule; readonly reason: string };

export type GuardBlock = Extract<GuardVerdict, { status: "blocked" }>;
