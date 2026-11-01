import "server-only";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { freshMarketPrice } from "@/server/engine/market-price";
import { INITIAL_TRIGGER_STATE, triggerStateSchema } from "@/server/engine/trigger";
import { intentTokens } from "@/server/research/intents";
import { parseUsd, policySchema } from "@/shared/agents";
import type { TradeQuote } from "@/shared/trade-preview";
import { type currentAgentStrategy, resolvedTradeAssets } from "./asset-review";
import { ExecutionError } from "./contracts";
import type { preparedOrderSchema } from "./intents-order";
import type { ExecutionAction } from "./records";

/** Re-read the underlying book immediately before signing; no registry display price can fire a trigger. */
export async function triggerSubmissionCheck(
  db: AppDatabase,
  action: ExecutionAction,
  prepared: z.infer<typeof preparedOrderSchema>,
  quote: TradeQuote,
  current: Awaited<ReturnType<typeof currentAgentStrategy>>,
): Promise<(() => void) | null> {
  if (current.strategy.kind !== "triggers") {
    return null;
  }
  const strategy = current.strategy;
  const signal = prepared.signal;
  if (signal?.purpose !== "trigger_entry" && signal?.purpose !== "trigger_exit") {
    throw new ExecutionError("not_ready", "This trigger is missing its immutable entry or exit instruction.");
  }
  const { tokens } = await intentTokens();
  const assets = resolvedTradeAssets(strategy, current.version.resolvedAssetsJson, tokens);
  const asset = assets.find((a) => a.symbol === strategy.asset),
    cash = assets.find((a) => a.symbol === strategy.quoteAsset);
  const [runtime] = await db
    .select()
    .from(agentRuntimes)
    .where(and(eq(agentRuntimes.userId, action.userId), eq(agentRuntimes.agentId, action.agentId)))
    .limit(1);
  const state = runtime?.strategyStateJson
    ? triggerStateSchema.parse(JSON.parse(runtime.strategyStateJson))
    : INITIAL_TRIGGER_STATE;
  const entry = signal.purpose === "trigger_entry";
  if (
    !asset ||
    !cash ||
    (entry ? state.phase !== "waiting" : state.phase !== "holding") ||
    action.inputAssetId !== (entry ? cash.assetId : asset.assetId) ||
    action.outputAssetId !== (entry ? asset.assetId : cash.assetId) ||
    (!entry && (!state.exitTriggered || action.inputUnits > BigInt(state.quantityUnits))) ||
    (entry &&
      (state.confirmationSince === null ||
        Date.now() - state.confirmationSince < strategy.confirmationSeconds * 1000))
  ) {
    throw new ExecutionError(
      "not_ready",
      "The trigger direction or confirmed position no longer matches this order.",
    );
  }
  const tick = await freshMarketPrice(strategy.asset);
  const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  const inputUsd = BigInt(quote.inputMicroUsd ?? "0");
  const tolerance = BigInt(policy.maxSlippageBps);
  if (entry) {
    const trigger = parseUsd(strategy.triggerPriceUsd);
    const market = tick.priceMicroUsd;
    const condition = strategy.condition === "buy_above" ? market >= trigger : market <= trigger;
    const maximumPrice = trigger * BigInt(10_000 + strategy.maxChaseBps);
    if (
      !condition ||
      Date.now() >= Date.parse(strategy.expiresAt) ||
      inputUsd > parseUsd(strategy.orderSizeUsd) ||
      market * 10_000n > maximumPrice ||
      (strategy.stopLossPriceUsd !== null && market <= parseUsd(strategy.stopLossPriceUsd)) ||
      (strategy.takeProfitPriceUsd !== null && market >= parseUsd(strategy.takeProfitPriceUsd)) ||
      inputUsd * 10n ** BigInt(asset.decimals) * 10_000n > BigInt(quote.minOutputUnits) * maximumPrice ||
      BigInt(quote.outputUnits) * market * 10_000n <
        inputUsd * 10n ** BigInt(asset.decimals) * (10_000n - tolerance)
    ) {
      throw new ExecutionError(
        "not_ready",
        "The entry condition or executable price moved outside its reviewed limits.",
      );
    }
  } else {
    const reference = (action.inputUnits * tick.priceMicroUsd) / 10n ** BigInt(asset.decimals);
    const difference = inputUsd > reference ? inputUsd - reference : reference - inputUsd;
    if (reference <= 0n || difference * 10_000n > reference * tolerance) {
      throw new ExecutionError("not_ready", "The exit quote moved beyond the fresh market-price tolerance.");
    }
  }
  return () => {
    if (
      Date.now() - tick.marketAt >= 5000 ||
      Date.now() - tick.capturedAt >= 5000 ||
      (entry && Date.now() >= Date.parse(strategy.expiresAt))
    ) {
      throw new ExecutionError("not_ready", "The trigger market reference expired before signing.");
    }
  };
}
