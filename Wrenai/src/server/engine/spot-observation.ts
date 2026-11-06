import { ExecutionError } from "@/server/execution/contracts";
import { type Decimal, decimal } from "@/server/research/decimal";
import { MarketUnavailable } from "@/server/research/market-http";
import { dcaScheduleSlot } from "./dca-schedule";
import { comparePrice, priceCondition, priceScale } from "./instruction-price";
import type { InstructionState } from "./instruction-state";
import type { SpotInstruction, SpotSnapshot } from "./spot-instructions";

interface Observation {
  readonly state: InstructionState;
  readonly eligible: boolean;
  readonly reason: string;
}
function peak(state: InstructionState, price: Decimal): InstructionState["peakPrice"] {
  const old = state.peakPrice ? { n: BigInt(state.peakPrice.n), d: BigInt(state.peakPrice.d) } : null;
  const value = old && comparePrice(old, price) >= 0 ? old : price;
  return { n: value.n.toString(), d: value.d.toString() };
}
function trailing(state: InstructionState, price: Decimal, bps: number | null): boolean {
  return (
    bps !== null &&
    state.peakPrice !== null &&
    comparePrice(
      price,
      priceScale({ n: BigInt(state.peakPrice.n), d: BigInt(state.peakPrice.d) }, BigInt(10_000 - bps)),
    ) <= 0
  );
}
function dipObservation(
  instruction: Extract<SpotInstruction, { kind: "buy_the_dip" }>,
  previous: InstructionState,
  price: Decimal,
  now: number,
): Observation {
  let state = previous;
  let threshold: Decimal;
  const gap = state.lastSampleAt === null || now - state.lastSampleAt > 10_000;
  if (instruction.reference.type === "price") {
    threshold = decimal(instruction.reference.price);
  } else {
    const window = instruction.reference.windowSeconds * 1000;
    const samples = gap ? [] : state.samples.filter((sample) => sample.at >= now - window);
    const last = samples.at(-1),
      sample = { at: now, n: price.n.toString(), d: price.d.toString() };
    if (last && Math.floor(last.at / 60_000) === Math.floor(now / 60_000)) {
      if (comparePrice(price, { n: BigInt(last.n), d: BigInt(last.d) }) >= 0) {
        samples[samples.length - 1] = sample;
      }
    } else {
      samples.push(sample);
    }
    state = { ...state, samples: samples.slice(-1441), coverageFrom: gap ? now : state.coverageFrom };
    if (
      state.coverageFrom === null ||
      now - state.coverageFrom < instruction.reference.windowSeconds * 1000
    ) {
      return {
        state: { ...state, lastSampleAt: now, confirmationSince: null },
        eligible: false,
        reason: "Collecting a complete observed rolling-high window; a data gap restarts coverage.",
      };
    }
    const high = samples.reduce<Decimal>((value, s) => {
      const p = { n: BigInt(s.n), d: BigInt(s.d) };
      return comparePrice(p, value) > 0 ? p : value;
    }, price);
    threshold = priceScale(high, BigInt(10_000 - instruction.reference.drawdownBps));
  }
  const below = comparePrice(price, threshold) <= 0;
  if (state.resetRequired) {
    return {
      state: { ...state, resetRequired: below, confirmationSince: null, lastSampleAt: now },
      eligible: false,
      reason: "Waiting for the dip condition to reset before another entry.",
    };
  }
  const since = below ? (gap ? now : (state.confirmationSince ?? now)) : null;
  state = {
    ...state,
    confirmationSince: since,
    lastSampleAt: now,
    entryLimitPrice: { n: threshold.n.toString(), d: threshold.d.toString() },
  };
  const cooled = state.lastEntryAt === null || now - state.lastEntryAt >= instruction.cooldownSeconds * 1000;
  return {
    state,
    eligible: cooled && since !== null && now - since >= instruction.confirmationSeconds * 1000,
    reason: "Monitoring the reviewed dip threshold, confirmation and cooldown.",
  };
}

export function observeSpotInstruction(
  instruction: SpotInstruction,
  previous: InstructionState,
  snapshot: SpotSnapshot | null,
  now: number,
): Observation {
  let state = previous;
  const result = (eligible: boolean, reason: string): Observation => ({ state, eligible, reason });
  const expired = now >= Date.parse(instruction.expiresAt);
  if (
    state.phase === "completed" ||
    (expired && (state.phase !== "holding" || instruction.onExpiry === "stop"))
  ) {
    state = { ...state, phase: "completed" };
    return result(false, "The instruction is complete; remaining holdings are retained.");
  }
  if (state.pendingActionId !== null) {
    return result(false, "Reconcile the previous action before another order.");
  }
  if (instruction.kind === "dca") {
    if (state.runs >= instruction.maxRuns) {
      state = { ...state, phase: "completed" };
      return result(false, "The reviewed DCA schedule is complete.");
    }
    const slot = dcaScheduleSlot(instruction.schedule, now).due;
    return result(
      slot !== null && slot.key !== state.lastSlot,
      "Waiting for the next DCA slot; missed slots are skipped.",
    );
  }
  if (
    instruction.kind === "sell_the_top" &&
    !state.exitTriggered &&
    instruction.targets.every((_target, i) => state.completedTargets.includes(i))
  ) {
    state = { ...state, phase: "completed" };
    return result(false, "All reviewed profit targets are complete; remaining holdings are retained.");
  }
  if (!snapshot) {
    return result(false, "Waiting for a reviewed order size.");
  }
  const needsPrice = !(
    instruction.kind === "spot_trader" &&
    state.phase === "waiting" &&
    instruction.entry.type === "market"
  );
  const price = snapshot.price;
  if (needsPrice && (!price || price.observedAt > now + 1000 || now - price.observedAt >= 5000)) {
    throw new MarketUnavailable("Fresh price for the reviewed pair");
  }
  if (price && state.phase === "holding") {
    state = { ...state, peakPrice: peak(state, price) };
  }
  if (instruction.kind === "sell_the_top") {
    const index = instruction.targets.findIndex((_target, i) => !state.completedTargets.includes(i));
    const target = instruction.targets[index];
    if (!target && !state.exitTriggered) {
      state = { ...state, phase: "completed" };
      return result(false, "All reviewed profit targets are complete; unallocated remainder is retained.");
    }
    if (!price) {
      throw new ExecutionError("not_ready", "The profit-rule price is unavailable.");
    }
    const basis = {
      n: BigInt(instruction.confirmedBasisUnits) * 10n ** BigInt(snapshot.base.decimals),
      d:
        BigInt(instruction.quantityUnits) *
        (instruction.priceUnit === "usd" ? 1_000_000n : 10n ** BigInt(snapshot.cash.decimals)),
    };
    const stop =
      instruction.stopLossBps !== null &&
      comparePrice(price, priceScale(basis, BigInt(10_000 - instruction.stopLossBps))) <= 0;
    const protective =
      state.exitTriggered ||
      stop ||
      trailing(state, price, instruction.trailingStopBps) ||
      (expired && instruction.onExpiry === "close");
    const profit =
      target !== undefined && comparePrice(price, priceScale(basis, BigInt(10_000 + target.profitBps))) >= 0;
    state = { ...state, exitTriggered: protective, pendingTarget: protective ? null : profit ? index : null };
    return result(protective || profit, "Monitoring net-profit targets and protective exits.");
  }
  if (state.phase === "holding") {
    if (!price) {
      throw new ExecutionError("not_ready", "The protective-exit price is unavailable.");
    }
    const exit = instruction.exits;
    const triggered =
      state.exitTriggered ||
      (expired && instruction.onExpiry === "close") ||
      (exit.takeProfitPrice !== null && priceCondition(price, "above", exit.takeProfitPrice)) ||
      (exit.stopLossPrice !== null && priceCondition(price, "below", exit.stopLossPrice)) ||
      trailing(state, price, exit.trailingStopBps);
    state = { ...state, exitTriggered: triggered };
    return result(triggered, "Monitoring the confirmed position's reviewed exits.");
  }
  if (instruction.kind === "buy_the_dip") {
    if (state.runs >= instruction.maxEntries) {
      state = { ...state, phase: "completed" };
      return result(false, "The maximum reviewed dip entries is reached.");
    }
    if (!price) {
      throw new ExecutionError("not_ready", "The dip price is unavailable.");
    }
    return dipObservation(instruction, state, price, now);
  }
  return result(
    instruction.entry.type === "market" ||
      (price !== null && priceCondition(price, instruction.entry.direction, instruction.entry.price)),
    "Waiting for the reviewed spot entry condition.",
  );
}
