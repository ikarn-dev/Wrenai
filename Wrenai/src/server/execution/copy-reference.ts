import "server-only";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { copyPriceAllowed, copyRequestId, eligibleLeaderSwap } from "@/server/engine/copy";
import { publicLeaderFeed } from "@/server/research/explorer";
import { copyEventId } from "@/server/research/explorer-contracts";
import { parseUsd } from "@/shared/agents";
import type { TradeQuote } from "@/shared/trade-preview";
import type { currentAgentStrategy } from "./asset-review";
import { ExecutionError } from "./contracts";
import type { preparedOrderSchema } from "./intents-order";
import { type ExecutionAction, executionHash } from "./records";

/** A public record is evidence of leader activity, never permission to reuse the leader's transaction bytes. */
export async function copySubmissionCheck(
  db: AppDatabase,
  action: ExecutionAction,
  prepared: z.infer<typeof preparedOrderSchema>,
  quote: TradeQuote,
  current: Awaited<ReturnType<typeof currentAgentStrategy>>,
): Promise<() => void> {
  const strategy = current.strategy;
  const evidence = prepared.signal?.copyTrade;
  if (strategy.kind !== "copy_trading" || prepared.signal?.purpose !== "copy_trade" || !evidence) {
    throw new ExecutionError("not_ready", "This copy is missing its immutable leader evidence.");
  }
  const [runtime] = await db
    .select()
    .from(agentRuntimes)
    .where(and(eq(agentRuntimes.userId, action.userId), eq(agentRuntimes.agentId, action.agentId)))
    .limit(1);
  const feed = await publicLeaderFeed();
  const event = feed.swaps.find((candidate) => copyEventId(candidate) === evidence.eventId);
  const inputUsd = BigInt(quote.inputMicroUsd ?? "0");
  if (
    runtime?.state !== "active" ||
    runtime.agentRevision !== action.agentRevision ||
    !event ||
    executionHash(event) !== executionHash(evidence.event) ||
    action.requestId !== copyRequestId(action.agentId, action.strategyVersion, evidence.eventId) ||
    Date.parse(event.createdAt) < runtime.createdAt ||
    event.originAsset !== action.inputAssetId ||
    event.destinationAsset !== action.outputAssetId ||
    inputUsd <= 0n ||
    inputUsd > parseUsd(strategy.orderSizeUsd) ||
    !copyPriceAllowed(strategy, event, action.inputUnits, BigInt(quote.minOutputUnits))
  ) {
    throw new ExecutionError(
      "not_ready",
      "The leader evidence or follower's executable price differs from the reviewed copy.",
    );
  }
  const check = (): void => {
    if (
      !eligibleLeaderSwap(strategy, event, Date.now()) ||
      Date.now() >= Date.parse(strategy.expiresAt) ||
      feed.capturedAt > Date.now() ||
      Date.now() - feed.capturedAt >= 5000
    ) {
      throw new ExecutionError("not_ready", "The public leader signal expired before signing.");
    }
  };
  check();
  return check;
}
