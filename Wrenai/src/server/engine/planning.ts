import "server-only";
import type { z } from "zod";
import type { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { type currentAgentStrategy, resolvedTradeAssets } from "@/server/execution/asset-review";
import { ExecutionError } from "@/server/execution/contracts";
import type { swapSignalSchema } from "@/server/execution/intents-order";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { intentTokens } from "@/server/research/intents";
import { isRemovedExecutablePack, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import { policySchema } from "@/shared/agents";
import { planSpotInstruction } from "./instruction-planning";
import { freshMarketPrice } from "./market-price";
import { planPaymentCheck } from "./payment-check";
import type { PricedHolding } from "./rebalance";
import type { RuntimeStrategyState } from "./strategy-state";
import { INITIAL_TRIGGER_STATE, triggerDecision, triggerStateSchema } from "./trigger";
import { applyTriggerReceipt } from "./trigger-receipt";
import { planWhaleCheck } from "./whale-check";

export interface StrategyCheckPlan {
  readonly signal: Omit<
    z.infer<typeof swapSignalSchema>,
    "requestId" | "agentId" | "expectedRevision"
  > | null;
  readonly intervalSeconds: number;
  readonly reason: string;
  readonly requestId?: string;
  readonly paymentRequestId?: string;
  readonly progress?: { readonly strategyState: RuntimeStrategyState; readonly completed: boolean };
}
type CurrentStrategy = Awaited<ReturnType<typeof currentAgentStrategy>>;

async function ownedHoldings(db: AppDatabase, current: CurrentStrategy): Promise<readonly PricedHolding[]> {
  const readings = await Promise.allSettled([
    intentTokens(),
    synchronizePrivateInventory(db, current.agent.userId),
  ]);
  const registry = readings[0],
    inventory = readings[1];
  if (registry?.status !== "fulfilled" || inventory?.status !== "fulfilled") {
    throw new ExecutionError(
      "not_ready",
      "The asset registry or complete private inventory could not be refreshed.",
    );
  }
  const assets = resolvedTradeAssets(
    current.strategy,
    current.version.resolvedAssetsJson,
    registry.value.tokens,
  );
  if (assets.length < 2) {
    throw new ExecutionError("not_ready", "Review the strategy's exact assets before trading.");
  }
  return Promise.all(
    assets.map(async (asset) => {
      const token = registry.value.tokens.find((t) => t.assetId === asset.assetId);
      const priceTime = token?.priceUpdatedAt ? Date.parse(token.priceUpdatedAt) : Number.NaN;
      if (
        !token?.price ||
        !Number.isFinite(priceTime) ||
        Date.now() - priceTime >= 30_000 ||
        priceTime > Date.now() + 1000
      ) {
        throw new ExecutionError("not_ready", "The portfolio valuation is stale or missing.");
      }
      return {
        ...asset,
        units: await unreservedOwnedUnits(
          db,
          current.agent.userId,
          current.agent.id,
          "confidential",
          asset.assetId,
        ),
        priceUsd: token.price,
      };
    }),
  );
}

export async function planStrategyCheck(
  db: AppDatabase,
  current: CurrentStrategy,
  runtime: typeof agentRuntimes.$inferSelect,
  requestId: string,
): Promise<StrategyCheckPlan> {
  if (isRemovedExecutablePack(current.agent.pack)) {
    throw new ExecutionError("not_ready", REMOVED_AGENT_MESSAGE);
  }
  const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  if ("format" in current.strategy) {
    const instruction = current.strategy;
    if (instruction.kind === "private_payments") {
      return planPaymentCheck(db, runtime, instruction);
    }
    if (instruction.kind === "whale_tracker") {
      return planWhaleCheck(db, runtime, instruction);
    }
    if (
      instruction.kind === "spot_trader" ||
      instruction.kind === "dca" ||
      instruction.kind === "buy_the_dip" ||
      instruction.kind === "sell_the_top"
    ) {
      return planSpotInstruction(db, current, instruction, runtime.strategyStateJson);
    }
    throw new ExecutionError("not_ready", "This instruction's venue adapter has not been enabled.");
  }
  if (current.strategy.kind !== "triggers") {
    throw new ExecutionError("not_ready", REMOVED_AGENT_MESSAGE);
  }
  const strategy = current.strategy;
  const state =
    runtime.strategyStateJson === null
      ? INITIAL_TRIGGER_STATE
      : triggerStateSchema.parse(JSON.parse(runtime.strategyStateJson));
  const receipt = await applyTriggerReceipt(
    db,
    current.agent.userId,
    current.agent.id,
    current.agent.version,
    requestId,
    strategy,
    state,
  );
  if (receipt) {
    return {
      signal: null,
      intervalSeconds: 5,
      reason: "The last trigger order is reconciled.",
      progress: { strategyState: receipt, completed: receipt.phase === "completed" },
    };
  }
  if (state.phase === "completed") {
    return {
      signal: null,
      intervalSeconds: 5,
      reason: "The reviewed trigger strategy has completed.",
      progress: { strategyState: state, completed: true },
    };
  }
  const holdings = await ownedHoldings(db, current);
  const tick = await freshMarketPrice(strategy.asset);
  const asset = holdings.find((h) => h.symbol === strategy.asset),
    quote = holdings.find((h) => h.symbol === strategy.quoteAsset);
  if (!asset || !quote || (state.lastActionId === null && asset.units !== 0n)) {
    throw new ExecutionError(
      "not_ready",
      "A new trigger needs quote-token funding and no unmanaged asset position.",
    );
  }
  const priceUsd = `${tick.priceMicroUsd / 1_000_000n}.${(tick.priceMicroUsd % 1_000_000n).toString().padStart(6, "0")}`;
  const decision = triggerDecision(strategy, policy, state, tick, { ...asset, priceUsd }, quote, Date.now());
  return {
    signal: decision.signal,
    intervalSeconds: 5,
    reason: decision.reason,
    progress: { strategyState: decision.state, completed: decision.state.phase === "completed" },
  };
}
