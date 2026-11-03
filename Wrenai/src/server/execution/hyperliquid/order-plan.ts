import { createHash } from "node:crypto";
import type { AgentInstruction } from "@/shared/agent-instructions";
import { type AgentPolicy, parseUsd } from "@/shared/agents";
import { ExecutionError } from "../contracts";
import { type HlAction, type HlOrder, hlActionSchema } from "./contracts";
import { hlPrice, hlText, hlUnits } from "./decimal";
import { type HlMarket, verifyHlDepth } from "./market";

export type PerpsInstruction = Extract<AgentInstruction, { kind: "perps" }>;
export function perpsCloid(requestId: string, role: "entry" | "exit" | "sl" | "tp"): string {
  return `0x${createHash("sha256")
    .update(JSON.stringify(["perps-order:v1", requestId, role]))
    .digest("hex")
    .slice(0, 32)}`;
}
function capPrice(reference: string, buy: boolean, bps: number, decimals: number): string {
  const scaled = hlUnits(reference, 18),
    numerator = scaled * BigInt(buy ? 10000 + bps : 10000 - bps);
  return hlPrice(
    hlText(buy ? numerator / 10000n : (numerator + 9999n) / 10000n, 18),
    decimals,
    buy ? "down" : "up",
  );
}
function protectiveOrder(
  instruction: PerpsInstruction,
  market: HlMarket,
  requestId: string,
  quantity: string,
  role: "sl" | "tp",
  trigger: string,
  slippageBps: number,
): HlOrder {
  const buy = instruction.side === "short",
    triggerPx = hlPrice(trigger, market.sizeDecimals, buy ? "down" : "up");
  const reference = hlUnits(market.mark, 18),
    actualTrigger = hlUnits(triggerPx, 18),
    above = role === "sl" ? buy : !buy;
  if (above ? actualTrigger <= reference : actualTrigger >= reference) {
    throw new ExecutionError(
      "limit",
      "Choose a protective trigger at least one valid venue tick away from the current mark.",
    );
  }
  return {
    a: market.asset,
    b: buy,
    p: capPrice(triggerPx, buy, slippageBps, market.sizeDecimals),
    s: quantity,
    r: true,
    // Native market TP/SL has a fixed 10% tolerance. A limit trigger preserves the owner's tighter price bound.
    t: { trigger: { isMarket: false, triggerPx, tpsl: role } },
    c: perpsCloid(requestId, role),
  };
}
export interface PerpsOrderPlan {
  readonly action: HlAction;
  readonly leverage: HlAction | null;
  readonly notionalMicroUsd: bigint;
  readonly maximumCashDebit: bigint;
  readonly quantityUnits: bigint;
}
/** Exact size, inward price rounding, leverage tiers and side-correct native exits are bound before signing. */
export function composePerpsOrder(
  instruction: PerpsInstruction,
  policy: AgentPolicy,
  market: HlMarket,
  requestId: string,
  availableCash: bigint,
  ownedUnits = 0n,
  now = Date.now(),
): PerpsOrderPlan {
  if (
    instruction.market !== market.name ||
    market.observedAt > now + 1000 ||
    now - market.observedAt >= 5000
  ) {
    throw new ExecutionError(
      "not_ready",
      "The order's market observation is stale or belongs to a different market.",
    );
  }
  const quantity = hlUnits(instruction.quantity, market.sizeDecimals),
    opening = instruction.action === "open",
    buy = opening ? instruction.side === "long" : instruction.side === "short";
  if (
    quantity <= 0n ||
    (opening
      ? ownedUnits !== 0n
      : quantity > ownedUnits || (instruction.action === "close" && quantity !== ownedUnits))
  ) {
    throw new ExecutionError(
      "limit",
      "The order must open a new isolated position or reduce only its exact owned size.",
    );
  }
  const price = capPrice(market.mark, buy, policy.maxSlippageBps, market.sizeDecimals),
    scale = 10n ** BigInt(market.sizeDecimals);
  const notional = (quantity * hlUnits(price, 6, "up") + scale - 1n) / scale;
  const tier = [...market.tiers].reverse().find((item) => notional >= hlUnits(item.lowerBound, 6, "up"));
  if (
    opening &&
    (notional < 10_000_000n ||
      !tier ||
      instruction.leverage > tier.maxLeverage ||
      instruction.leverage > market.maxLeverage)
  ) {
    throw new ExecutionError(
      "limit",
      "The size or leverage exceeds this market's minimum order or margin tier.",
    );
  }
  const fee = (notional * BigInt(policy.maxProviderFeeBps) + 9999n) / 10000n;
  const cash = opening
    ? (notional + BigInt(instruction.leverage) - 1n) / BigInt(instruction.leverage) + fee
    : fee < availableCash
      ? fee
      : availableCash;
  const [marginWhole = "0", marginFraction = ""] = instruction.maximumMarginUsd.split(".");
  const marginCeiling = BigInt(marginWhole) * 1_000_000n + BigInt(marginFraction.padEnd(6, "0").slice(0, 6));
  if (
    (opening && (cash > marginCeiling || notional > parseUsd(policy.maxTradeUsd))) ||
    cash > availableCash
  ) {
    throw new ExecutionError(
      "insufficient_funds",
      "The isolated margin and bounded fees exceed this agent's available cash or reviewed limits.",
    );
  }
  if (instruction.entry.type === "price" && opening) {
    const mark = hlUnits(market.mark, 18),
      trigger = hlUnits(instruction.entry.price, 18);
    if (instruction.entry.direction === "above" ? mark < trigger : mark > trigger) {
      throw new ExecutionError("not_ready", "The reviewed entry price has not been reached.");
    }
  }
  verifyHlDepth(market, buy, quantity, price);
  const size = hlText(quantity, market.sizeDecimals),
    orders: HlOrder[] = [
      {
        a: market.asset,
        b: buy,
        p: price,
        s: size,
        r: !opening,
        t: { limit: { tif: "Ioc" } },
        c: perpsCloid(requestId, opening ? "entry" : "exit"),
      },
    ];
  if (opening) {
    const stop = instruction.exits.stopLossPrice,
      target = instruction.exits.takeProfitPrice,
      mark = hlUnits(market.mark, 18);
    if (
      !stop ||
      (instruction.side === "long" ? hlUnits(stop, 18) >= mark : hlUnits(stop, 18) <= mark) ||
      (target !== null &&
        (instruction.side === "long" ? hlUnits(target, 18) <= mark : hlUnits(target, 18) >= mark))
    ) {
      throw new ExecutionError(
        "limit",
        "Stop-loss and take-profit prices must be on the correct sides of the current entry.",
      );
    }
    orders.push(protectiveOrder(instruction, market, requestId, size, "sl", stop, policy.maxSlippageBps));
    if (target !== null) {
      orders.push(protectiveOrder(instruction, market, requestId, size, "tp", target, policy.maxSlippageBps));
    }
  }
  return {
    action: hlActionSchema.parse({ type: "order", orders, grouping: opening ? "normalTpsl" : "na" }),
    leverage: opening
      ? { type: "updateLeverage", asset: market.asset, isCross: false, leverage: instruction.leverage }
      : null,
    notionalMicroUsd: notional + fee,
    maximumCashDebit: cash,
    quantityUnits: quantity,
  };
}
/** A trailing stop can tighten only. The original venue stop remains effective until replacement is acknowledged. */
export function tightenedPerpsStop(
  side: "long" | "short",
  previousStop: string,
  previousWatermark: string,
  mark: string,
  trailingBps: number,
  sizeDecimals: number,
): { readonly stop: string; readonly watermark: string } {
  const before = hlUnits(previousWatermark, 18),
    current = hlUnits(mark, 18),
    oldStop = hlUnits(previousStop, 18);
  let watermark = before;
  if ((side === "long" && current > before) || (side === "short" && current < before)) {
    watermark = current;
  }
  const candidate =
    (watermark * BigInt(side === "long" ? 10000 - trailingBps : 10000 + trailingBps)) / 10000n;
  let next = oldStop;
  if ((side === "long" && candidate > oldStop) || (side === "short" && candidate < oldStop)) {
    next = candidate;
  }
  return {
    stop: hlPrice(hlText(next, 18), sizeDecimals, side === "long" ? "up" : "down"),
    watermark: hlText(watermark, 18),
  };
}
export function composePerpsProtection(
  instruction: PerpsInstruction,
  market: HlMarket,
  requestId: string,
  quantity: bigint,
  stop: string,
  slippageBps: number,
): HlAction {
  if (quantity <= 0n || !instruction.exits.stopLossPrice) {
    throw new ExecutionError(
      "limit",
      "Protective orders require a positive owned position and its reviewed stop.",
    );
  }
  const original = hlUnits(instruction.exits.stopLossPrice, 18),
    proposed = hlUnits(stop, 18),
    mark = hlUnits(market.mark, 18);
  if (
    instruction.side === "long"
      ? proposed < original || proposed >= mark
      : proposed > original || proposed <= mark
  ) {
    throw new ExecutionError(
      "limit",
      "A replacement stop must tighten the original stop without immediately crossing the market.",
    );
  }
  const size = hlText(quantity, market.sizeDecimals),
    orders = [protectiveOrder(instruction, market, requestId, size, "sl", stop, slippageBps)];
  const target = instruction.exits.takeProfitPrice;
  if (
    target !== null &&
    (instruction.side === "long" ? hlUnits(target, 18) > mark : hlUnits(target, 18) < mark)
  ) {
    orders.push(protectiveOrder(instruction, market, requestId, size, "tp", target, slippageBps));
  }
  return hlActionSchema.parse({ type: "order", orders, grouping: "positionTpsl" });
}
