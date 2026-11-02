import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { type currentAgentStrategy, resolvedTradeAssets } from "@/server/execution/asset-review";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError } from "@/server/execution/contracts";
import { freshDryQuote } from "@/server/execution/oneclick-quote";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { intentTokens } from "@/server/research/intents";
import { policySchema } from "@/shared/agents";
import { instructionPrice } from "./instruction-price";
import { applyInstructionReceipt } from "./instruction-receipt";
import { initialInstructionState, instructionStateSchema } from "./instruction-state";
import type { StrategyCheckPlan } from "./planning";
import {
  decideSpotInstruction,
  initialSpotState,
  type SpotInstruction,
  type SpotSnapshot,
  spotOrderSize,
} from "./spot-instructions";
import { observeSpotInstruction } from "./spot-observation";

export function instructionRequestId(agentId: string, version: number, slot: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["instruction:v1", agentId, version, slot]))
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function planSpotInstruction(
  db: AppDatabase,
  current: Awaited<ReturnType<typeof currentAgentStrategy>>,
  instruction: SpotInstruction,
  rawState: string | null,
): Promise<StrategyCheckPlan> {
  const previous = rawState
    ? instructionStateSchema.parse(JSON.parse(rawState))
    : initialInstructionState(instruction.kind);
  if (previous.kind !== instruction.kind) {
    throw new ExecutionError("conflict", "The runtime belongs to a different reviewed instruction.");
  }
  const receipt = await applyInstructionReceipt(
    db,
    current.agent.userId,
    current.agent.id,
    current.agent.version,
    instruction,
    previous,
  );
  const state = initialSpotState(instruction, receipt ?? previous);
  const intervalSeconds = instruction.kind === "dca" ? 60 : 5;
  if (receipt || state.phase === "completed") {
    return {
      signal: null,
      intervalSeconds,
      reason: receipt
        ? "The confirmed receipt updated the agent's remaining position."
        : "The reviewed instruction is complete.",
      progress: { strategyState: state, completed: state.phase === "completed" },
    };
  }
  const registry = await intentTokens();
  const assets = resolvedTradeAssets(instruction, current.version.resolvedAssetsJson, registry.tokens);
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
    throw new ExecutionError("not_ready", "Review this instruction's exact pair before activation.");
  }
  const order = spotOrderSize(instruction, state, Date.now());
  if (!order) {
    const observation = observeSpotInstruction(
      instruction,
      state,
      { base, cash, baseOwned: 0n, cashOwned: 0n, price: null, quote: null },
      Date.now(),
    );
    return {
      signal: null,
      intervalSeconds,
      reason: observation.reason,
      progress: { strategyState: observation.state, completed: observation.state.phase === "completed" },
    };
  }
  await synchronizePrivateInventory(db, current.agent.userId);
  const [baseOwned, cashOwned] = await Promise.all([
    unreservedOwnedUnits(db, current.agent.userId, current.agent.id, "confidential", base.assetId),
    unreservedOwnedUnits(db, current.agent.userId, current.agent.id, "confidential", cash.assetId),
  ]);
  const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  const needsPrice =
    instruction.kind !== "dca" &&
    !(instruction.kind === "spot_trader" && state.phase === "waiting" && instruction.entry.type === "market");
  const price = needsPrice
    ? await instructionPrice(base, cash, order.units, order.buy, instruction.priceUnit)
    : null;
  const snapshot: SpotSnapshot = { base, cash, baseOwned, cashOwned, price, quote: null };
  const observed = observeSpotInstruction(instruction, state, snapshot, Date.now());
  if (!observed.eligible) {
    return {
      signal: null,
      intervalSeconds,
      reason: observed.reason,
      progress: { strategyState: observed.state, completed: observed.state.phase === "completed" },
    };
  }
  const sized = spotOrderSize(instruction, observed.state, Date.now());
  const [owner] = await db
    .select({ accountId: users.accountId })
    .from(users)
    .where(eq(users.id, current.agent.userId))
    .limit(1);
  const session = await privateBalanceToken(db, current.agent.userId);
  if (!owner || !session || !sized) {
    throw new ExecutionError(
      "not_ready",
      "A current private-balance session and reviewed order size are required.",
    );
  }
  const quote = await freshDryQuote(
    owner.accountId,
    sized.buy ? cash.assetId : base.assetId,
    sized.buy ? base.assetId : cash.assetId,
    sized.units.toString(),
    policy.maxSlippageBps,
    "confidential",
    undefined,
    session,
  );
  const decision = decideSpotInstruction(
    instruction,
    policy,
    observed.state,
    { ...snapshot, quote },
    Date.now(),
  );
  return {
    signal: decision.signal,
    intervalSeconds,
    reason: decision.reason,
    ...(decision.signal
      ? {
          requestId: instructionRequestId(
            current.agent.id,
            current.agent.version,
            decision.signal.instructionSlot,
          ),
        }
      : {}),
    progress: { strategyState: decision.state, completed: decision.state.phase === "completed" },
  };
}
