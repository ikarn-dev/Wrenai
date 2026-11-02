import "server-only";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { instructionPrice } from "@/server/engine/instruction-price";
import { instructionStateSchema } from "@/server/engine/instruction-state";
import { decideSpotInstruction } from "@/server/engine/spot-instructions";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { intentTokens } from "@/server/research/intents";
import { policySchema } from "@/shared/agents";
import type { TradeQuote } from "@/shared/trade-preview";
import { type currentAgentStrategy, resolvedTradeAssets } from "./asset-review";
import { ExecutionError } from "./contracts";
import type { swapSignalSchema } from "./intents-order";

/** External observations happen before the owner lock; only their freshness and state binding are checked inside it. */
export async function instructionSubmissionCheck(
  db: AppDatabase,
  current: Awaited<ReturnType<typeof currentAgentStrategy>>,
  signal: z.infer<typeof swapSignalSchema> | undefined,
  quote: TradeQuote,
  actionId?: string,
): Promise<((tx: AppDatabase) => Promise<void>) | null> {
  if (!("format" in current.strategy)) {
    return null;
  }
  const instruction = current.strategy;
  if (
    instruction.kind !== "spot_trader" &&
    instruction.kind !== "dca" &&
    instruction.kind !== "buy_the_dip" &&
    instruction.kind !== "sell_the_top"
  ) {
    throw new ExecutionError(
      "not_ready",
      "This instruction does not authorize the confidential swap Signer.",
    );
  }
  const [runtime] = await db
    .select()
    .from(agentRuntimes)
    .where(and(eq(agentRuntimes.userId, current.agent.userId), eq(agentRuntimes.agentId, current.agent.id)))
    .limit(1);
  if (
    !signal ||
    !runtime?.strategyStateJson ||
    runtime.state !== "active" ||
    runtime.strategyVersion !== current.agent.version ||
    runtime.agentRevision !== current.agent.revision
  ) {
    throw new ExecutionError(
      "not_ready",
      "A persisted current runtime decision is required before preparing an instruction.",
    );
  }
  const stored = runtime.strategyStateJson,
    state = instructionStateSchema.parse(JSON.parse(stored));
  if (
    state.kind !== instruction.kind ||
    state.pendingSlot !== signal.instructionSlot ||
    (state.pendingActionId !== null && state.pendingActionId !== actionId)
  ) {
    throw new ExecutionError("conflict", "This order does not own the persisted instruction slot.");
  }
  const { tokens } = await intentTokens();
  const assets = resolvedTradeAssets(instruction, current.version.resolvedAssetsJson, tokens);
  const base = assets.find(
    (asset) =>
      asset.assetId ===
      (instruction.kind === "sell_the_top" ? instruction.sellAssetId : instruction.buyAssetId),
  );
  const cash = assets.find(
    (asset) =>
      asset.assetId ===
      (instruction.kind === "sell_the_top" ? instruction.receiveAssetId : instruction.payAssetId),
  );
  if (!base || !cash) {
    throw new ExecutionError("not_ready", "The exact reviewed pair is unavailable.");
  }
  const buy = signal.purpose === "instruction_entry";
  const needsPrice =
    instruction.kind !== "dca" &&
    !(instruction.kind === "spot_trader" && state.phase === "waiting" && instruction.entry.type === "market");
  const price = needsPrice
    ? await instructionPrice(base, cash, BigInt(signal.inputUnits), buy, instruction.priceUnit)
    : null;
  const [baseOwned, cashOwned] = await Promise.all([
    unreservedOwnedUnits(db, current.agent.userId, current.agent.id, "confidential", base.assetId, actionId),
    unreservedOwnedUnits(db, current.agent.userId, current.agent.id, "confidential", cash.assetId, actionId),
  ]);
  const decision = decideSpotInstruction(
    instruction,
    policySchema.parse(JSON.parse(current.agent.policyJson)),
    { ...state, pendingActionId: null },
    { base, cash, baseOwned, cashOwned, price, quote },
    Date.now(),
  );
  const fresh = decision.signal;
  if (
    !fresh ||
    fresh.instructionSlot !== signal.instructionSlot ||
    fresh.inputAssetId !== signal.inputAssetId ||
    fresh.outputAssetId !== signal.outputAssetId ||
    fresh.inputUnits !== signal.inputUnits ||
    fresh.purpose !== signal.purpose
  ) {
    throw new ExecutionError(
      "not_ready",
      "The reviewed rule, remaining position or executable price no longer authorizes this order.",
    );
  }
  return async (tx) => {
    const [row] = await tx
      .select()
      .from(agentRuntimes)
      .where(eq(agentRuntimes.agentId, current.agent.id))
      .limit(1);
    if (
      !row ||
      row.strategyStateJson !== stored ||
      row.state !== "active" ||
      row.agentRevision !== current.agent.revision ||
      row.strategyVersion !== current.agent.version ||
      quote.expiresAt <= Date.now() ||
      (price !== null && Date.now() - price.observedAt >= 5000) ||
      (buy && Date.now() >= Date.parse(instruction.expiresAt))
    ) {
      throw new ExecutionError(
        "not_ready",
        "The instruction state or market reference changed before signing.",
      );
    }
  };
}
