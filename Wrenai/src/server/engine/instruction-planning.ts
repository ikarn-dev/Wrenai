import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import {
  type currentAgentStrategy,
  instructionRouteTokens,
  resolvedTradeAssets,
} from "@/server/execution/asset-review";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError } from "@/server/execution/contracts";
import { freshDryQuote } from "@/server/execution/oneclick-quote";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { synchronizeNativeInventory } from "@/server/execution/rhea/inventory";
import { quoteRhea, rheaTradeQuote } from "@/server/execution/rhea/quote";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { publicRoutePool, usesPublicRoute } from "@/shared/agent-instructions";
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
  const order = spotOrderSize(instruction, state, Date.now());
  if (!order) {
    const observation = observeSpotInstruction(instruction, state, null, Date.now());
    return {
      signal: null,
      intervalSeconds,
      reason: observation.reason,
      progress: { strategyState: observation.state, completed: observation.state.phase === "completed" },
    };
  }
  const native = usesPublicRoute(instruction);
  const pool = publicRoutePool(instruction);
  const scope = native ? "native_near" : "confidential";
  const tokens = await instructionRouteTokens(instruction);
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
    throw new ExecutionError("not_ready", "Review this instruction's exact pair before activation.");
  }
  if (native) {
    await synchronizeNativeInventory(db, current.agent.userId, [base.assetId, cash.assetId]);
  } else {
    await synchronizePrivateInventory(db, current.agent.userId);
  }
  const [baseOwned, cashOwned] = await Promise.all([
    unreservedOwnedUnits(db, current.agent.userId, current.agent.id, scope, base.assetId),
    unreservedOwnedUnits(db, current.agent.userId, current.agent.id, scope, cash.assetId),
  ]);
  const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  const needsPrice =
    instruction.kind !== "dca" &&
    !(instruction.kind === "spot_trader" && state.phase === "waiting" && instruction.entry.type === "market");
  const price = needsPrice
    ? await instructionPrice(base, cash, order.units, order.buy, instruction.priceUnit, pool)
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
  if (!sized) {
    // The schedule slot can close between observation and sizing; wait for the next one instead of failing.
    return {
      signal: null,
      intervalSeconds,
      reason: "Waiting for the next reviewed schedule.",
      progress: { strategyState: observed.state, completed: observed.state.phase === "completed" },
    };
  }
  const input = sized.buy ? cash : base;
  const output = sized.buy ? base : cash;
  const quote = pool
    ? await nativeSpotQuote(
        db,
        current.agent.userId,
        input,
        output,
        sized.units.toString(),
        policy.maxSlippageBps,
        pool,
      )
    : await privateSpotQuote(
        db,
        current.agent.userId,
        input.assetId,
        output.assetId,
        sized.units.toString(),
        policy.maxSlippageBps,
      );
  const decision = decideSpotInstruction(
    instruction,
    policy,
    observed.state,
    { ...snapshot, quote },
    Date.now(),
  );
  return {
    signal:
      decision.signal && native ? { ...decision.signal, scope: "native_near" as const } : decision.signal,
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

async function nativeSpotQuote(
  db: AppDatabase,
  userId: string,
  input: SpotSnapshot["base"],
  output: SpotSnapshot["base"],
  units: string,
  slippageBps: number,
  poolId: string,
): Promise<Awaited<ReturnType<typeof freshDryQuote>>> {
  const root = await activeTradingAccount(db, userId);
  if (!root?.backupConfirmedAt) {
    throw new ExecutionError("not_ready", "Confirm the trading account recovery backup.");
  }
  const quote = await quoteRhea(input, output, units, slippageBps, poolId);
  return rheaTradeQuote(quote, root.nativeAccountId);
}

async function privateSpotQuote(
  db: AppDatabase,
  userId: string,
  inputAssetId: string,
  outputAssetId: string,
  units: string,
  slippageBps: number,
): Promise<Awaited<ReturnType<typeof freshDryQuote>>> {
  const [[owner], session] = await Promise.all([
    db.select({ accountId: users.accountId }).from(users).where(eq(users.id, userId)).limit(1),
    privateBalanceToken(db, userId),
  ]);
  if (!owner || !session) {
    throw new ExecutionError("not_ready", "Connect your private balance before trading.");
  }
  return freshDryQuote(
    owner.accountId,
    inputAssetId,
    outputAssetId,
    units,
    slippageBps,
    "confidential",
    undefined,
    session,
  );
}
