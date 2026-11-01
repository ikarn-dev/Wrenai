import "server-only";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { type currentAgentStrategy, resolvedTradeAssets } from "@/server/execution/asset-review";
import { ExecutionError } from "@/server/execution/contracts";
import type { swapSignalSchema } from "@/server/execution/intents-order";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { publicLeaderFeed } from "@/server/research/explorer";
import { intentTokens } from "@/server/research/intents";
import { policySchema } from "@/shared/agents";
import { copyDecision, copyRequestId, copyStateSchema, INITIAL_COPY_STATE } from "./copy";
import { freshMarketPrice } from "./market-price";
import { type PricedHolding, rebalanceSignal } from "./rebalance";
import type { RuntimeStrategyState } from "./strategy-state";
import { INITIAL_TRIGGER_STATE, triggerDecision, triggerStateSchema } from "./trigger";
import { applyTriggerReceipt } from "./trigger-receipt";

export interface StrategyCheckPlan {
  readonly signal: Omit<
    z.infer<typeof swapSignalSchema>,
    "requestId" | "agentId" | "expectedRevision"
  > | null;
  readonly intervalSeconds: number;
  readonly reason: string;
  readonly requestId?: string;
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
  const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  if (current.strategy.kind === "rebalancer") {
    return {
      signal: rebalanceSignal(current.strategy, policy, await ownedHoldings(db, current)),
      intervalSeconds: current.strategy.intervalSeconds,
      reason: "Within the reviewed allocation band.",
    };
  }
  if (current.strategy.kind === "copy_trading") {
    const state =
      runtime.strategyStateJson === null
        ? INITIAL_COPY_STATE
        : copyStateSchema.parse(JSON.parse(runtime.strategyStateJson));
    const readings =
      Date.now() >= Date.parse(current.strategy.expiresAt)
        ? null
        : await Promise.allSettled([publicLeaderFeed(), ownedHoldings(db, current)]);
    const feed = readings?.[0],
      holdings = readings?.[1];
    if (feed?.status === "rejected") {
      if (feed.reason instanceof ExecutionError) {
        throw feed.reason;
      }
      throw new ExecutionError("not_ready", "The public leader feed is unavailable.");
    }
    if (holdings?.status === "rejected") {
      throw new ExecutionError("not_ready", "The follower's allocated holdings could not be refreshed.");
    }
    const decision = copyDecision(
      current.strategy,
      policy,
      state,
      feed?.status === "fulfilled" ? feed.value : { capturedAt: Date.now(), swaps: [] },
      holdings?.status === "fulfilled" ? holdings.value : [],
      runtime.createdAt,
      Date.now(),
    );
    const request = decision.signal
      ? copyRequestId(current.agent.id, current.agent.version, decision.signal.copyTrade.eventId)
      : undefined;
    const [existing] = request
      ? await db
          .select({ id: executionActions.id })
          .from(executionActions)
          .where(
            and(eq(executionActions.userId, current.agent.userId), eq(executionActions.requestId, request)),
          )
          .limit(1)
      : [];
    return {
      signal: existing ? null : decision.signal,
      ...(request ? { requestId: request } : {}),
      intervalSeconds: 60,
      reason: existing ? "This leader swap already has a follower execution record." : decision.reason,
      progress: { strategyState: decision.state, completed: decision.completed },
    };
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
