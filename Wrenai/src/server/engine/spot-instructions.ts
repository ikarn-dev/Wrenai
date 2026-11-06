import { ExecutionError } from "@/server/execution/contracts";
import type { AgentInstruction } from "@/shared/agent-instructions";
import { type AgentPolicy, parseUsd } from "@/shared/agents";
import { minimumUnits } from "@/shared/token-units";
import type { TradeAsset, TradeQuote } from "@/shared/trade-preview";
import { dcaScheduleSlot } from "./dca-schedule";
import { comparePrice, type InstructionPrice, priceCondition, priceScale } from "./instruction-price";
import type { InstructionState } from "./instruction-state";
import { observeSpotInstruction } from "./spot-observation";

export type SpotInstruction = Extract<
  AgentInstruction,
  { kind: "spot_trader" | "dca" | "buy_the_dip" | "sell_the_top" }
>;
export interface SpotSnapshot {
  readonly base: TradeAsset;
  readonly cash: TradeAsset;
  readonly baseOwned: bigint;
  readonly cashOwned: bigint;
  readonly price: InstructionPrice | null;
  readonly quote: TradeQuote | null;
}
export interface InstructionDecision {
  readonly state: InstructionState;
  readonly reason: string;
  readonly signal: {
    readonly inputAssetId: string;
    readonly outputAssetId: string;
    readonly inputUnits: string;
    readonly purpose: "instruction_entry" | "instruction_exit";
    readonly instructionSlot: string;
  } | null;
}
export function initialSpotState(instruction: SpotInstruction, state: InstructionState): InstructionState {
  if (state.lastActionId !== null || state.pendingActionId !== null) {
    return state;
  }
  if (instruction.kind === "sell_the_top") {
    return {
      ...state,
      phase: "holding",
      quantityUnits: instruction.quantityUnits,
      basisMicroUsd: instruction.confirmedBasisUnits,
    };
  }
  return instruction.kind === "spot_trader" && instruction.side === "sell"
    ? { ...state, quantityUnits: instruction.amountUnits }
    : state;
}
export function spotOrderSize(
  instruction: SpotInstruction,
  state: InstructionState,
  now: number,
): { readonly buy: boolean; readonly units: bigint; readonly slot: string } | null {
  if (state.phase === "completed" || state.pendingActionId !== null) {
    return null;
  }
  if (instruction.kind === "dca") {
    if (state.runs >= instruction.maxRuns || now >= Date.parse(instruction.expiresAt)) {
      return null;
    }
    const slot = dcaScheduleSlot(instruction.schedule, now).due;
    return slot && slot.key !== state.lastSlot
      ? { buy: true, units: BigInt(instruction.amountUnits), slot: slot.key }
      : null;
  }
  if (instruction.kind === "sell_the_top") {
    const index = instruction.targets.findIndex((_target, i) => !state.completedTargets.includes(i));
    const target = instruction.targets[index];
    if (!state.exitTriggered && !target) {
      return null;
    }
    const remaining = BigInt(state.quantityUnits);
    const requested = state.exitTriggered
      ? remaining
      : target
        ? (BigInt(instruction.quantityUnits) * BigInt(target.sellBps)) / 10_000n -
          BigInt(state.targetSoldUnits[index] ?? "0")
        : 0n;
    const units = minimumUnits(remaining, requested);
    return units > 0n
      ? {
          buy: false,
          units,
          slot: `${state.exitTriggered ? "protection" : `profit:${index}`}:${state.lastActionId ?? "initial"}`,
        }
      : null;
  }
  const exit = state.phase === "holding";
  const buy = !exit && !(instruction.kind === "spot_trader" && instruction.side === "sell");
  const units = exit || !buy ? BigInt(state.quantityUnits) : BigInt(instruction.amountUnits);
  return units > 0n
    ? { buy, units, slot: `${buy ? "entry" : "exit"}:${state.runs}:${state.lastActionId ?? "initial"}` }
    : null;
}
/** Worst executable price: buys use minimum output; sells round proceeds down. */
export function executableSpotPrice(
  snapshot: SpotSnapshot,
  buy: boolean,
  unit: "usd" | "quote_token",
): InstructionPrice {
  const q = snapshot.quote;
  if (!q) {
    throw new ExecutionError("not_ready", "A verified executable quote is required.");
  }
  const n =
    unit === "quote_token"
      ? BigInt(buy ? q.inputUnits : q.minOutputUnits)
      : buy
        ? BigInt(q.inputMicroUsd ?? "0")
        : (BigInt(q.outputMicroUsd ?? "0") * BigInt(q.minOutputUnits)) / BigInt(q.outputUnits);
  if (n <= 0n) {
    throw new ExecutionError(
      "not_ready",
      "The executable quote has no validated price in the reviewed unit.",
    );
  }
  return {
    n: n * 10n ** BigInt(snapshot.base.decimals),
    d:
      BigInt(buy ? q.minOutputUnits : q.inputUnits) *
      (unit === "usd" ? 1_000_000n : 10n ** BigInt(snapshot.cash.decimals)),
    observedAt: q.capturedAt,
  };
}
function validateSpotQuote(
  instruction: SpotInstruction,
  policy: AgentPolicy,
  state: InstructionState,
  snapshot: SpotSnapshot,
  order: NonNullable<ReturnType<typeof spotOrderSize>>,
  now: number,
): boolean {
  const q = snapshot.quote,
    input = order.buy ? snapshot.cash : snapshot.base,
    output = order.buy ? snapshot.base : snapshot.cash;
  const reducing = !order.buy && policy.allowRiskReducingExits === true;
  if (
    !q ||
    q.expiresAt <= now ||
    q.capturedAt > now + 1000 ||
    now - q.capturedAt >= 15_000 ||
    q.inputAssetId !== input.assetId ||
    q.outputAssetId !== output.assetId ||
    q.inputUnits !== order.units.toString() ||
    !q.inputMicroUsd ||
    (!reducing && BigInt(q.inputMicroUsd) > parseUsd(policy.maxTradeUsd)) ||
    q.appFeeBps > policy.maxProviderFeeBps ||
    q.slippageBps > policy.maxSlippageBps
  ) {
    throw new ExecutionError(
      "not_ready",
      "A fresh size-matched signed quote within reviewed fee and spending limits is required.",
    );
  }
  const actual = executableSpotPrice(snapshot, order.buy, instruction.priceUnit);
  if (order.buy && "exits" in instruction) {
    const exits = instruction.exits;
    if (
      (exits.stopLossPrice !== null && priceCondition(actual, "below", exits.stopLossPrice)) ||
      (exits.takeProfitPrice !== null && priceCondition(actual, "above", exits.takeProfitPrice))
    ) {
      return false;
    }
  }
  if (snapshot.price) {
    const outputFloor = BigInt(10_000 - policy.maxSlippageBps);
    const bound = order.buy
      ? priceScale(snapshot.price, 10_000n, outputFloor)
      : priceScale(snapshot.price, outputFloor);
    // Venue drift from the independent price is a market condition: wait, never count it as a failure.
    if (order.buy ? comparePrice(actual, bound) > 0 : comparePrice(actual, bound) < 0) {
      return false;
    }
  }
  if (instruction.kind === "spot_trader" && state.phase === "waiting" && instruction.entry.type === "price") {
    return priceCondition(actual, instruction.entry.direction, instruction.entry.price);
  }
  if (instruction.kind === "buy_the_dip" && state.phase === "waiting" && snapshot.price) {
    return (
      state.entryLimitPrice !== null &&
      comparePrice(actual, { n: BigInt(state.entryLimitPrice.n), d: BigInt(state.entryLimitPrice.d) }) <= 0
    );
  }
  if (instruction.kind === "sell_the_top" && !state.exitTriggered && state.pendingTarget !== null) {
    const target = instruction.targets[state.pendingTarget];
    const basis = BigInt(instruction.confirmedBasisUnits) * order.units;
    const proceeds =
      instruction.priceUnit === "quote_token"
        ? BigInt(q.minOutputUnits)
        : (BigInt(q.outputMicroUsd ?? "0") * BigInt(q.minOutputUnits)) / BigInt(q.outputUnits);
    return (
      target !== undefined &&
      proceeds * BigInt(instruction.quantityUnits) * 10_000n >= basis * BigInt(10_000 + target.profitBps)
    );
  }
  return true;
}
/** Eligibility runs before quoting so idle polls never request executable orders. */
export function decideSpotInstruction(
  instruction: SpotInstruction,
  policy: AgentPolicy,
  previous: InstructionState,
  snapshot: SpotSnapshot,
  now: number,
): InstructionDecision {
  const observed = observeSpotInstruction(
    instruction,
    initialSpotState(instruction, previous),
    snapshot,
    now,
  );
  const state = observed.state;
  if (!observed.eligible) {
    return { state, signal: null, reason: observed.reason };
  }
  const order = spotOrderSize(instruction, state, now);
  if (!order) {
    return { state, signal: null, reason: "Waiting for the next reviewed schedule or reconciliation." };
  }
  if (order.units > (order.buy ? snapshot.cashOwned : snapshot.baseOwned)) {
    throw new ExecutionError(
      "insufficient_funds",
      "The agent's confirmed unreserved inventory does not cover the complete order.",
    );
  }
  if (!validateSpotQuote(instruction, policy, state, snapshot, order, now)) {
    return { state, signal: null, reason: "The executable net price has not reached the reviewed target." };
  }
  const anchor = order.buy
    ? (snapshot.price ?? executableSpotPrice(snapshot, true, instruction.priceUnit))
    : null;
  return {
    state: {
      ...state,
      pendingSlot: order.slot,
      ...(anchor ? { peakPrice: { n: anchor.n.toString(), d: anchor.d.toString() } } : {}),
    },
    signal: {
      inputAssetId: (order.buy ? snapshot.cash : snapshot.base).assetId,
      outputAssetId: (order.buy ? snapshot.base : snapshot.cash).assetId,
      inputUnits: order.units.toString(),
      purpose: order.buy ? "instruction_entry" : "instruction_exit",
      instructionSlot: order.slot,
    },
    reason: "The reviewed instruction passes current price and size checks.",
  };
}
