import { ExecutionError } from "../contracts";
import type { HlAccountState } from "./account-state";
import type { HlOrder } from "./contracts";
import { hlUnits } from "./decimal";
import type { HlFill } from "./observations";
import type { HlOrderRecord } from "./order-record";

export interface PerpsFillAccounting {
  readonly quantity: bigint;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly collateral: bigint;
  readonly risk: bigint;
  readonly fee: bigint;
  readonly cashAfter: bigint;
}
/** Venue fills must form one complete, non-flipping position chain, including any native protective fills. */
export function accountPerpsFills(
  saved: HlOrderRecord,
  state: HlAccountState,
  fills: readonly HlFill[],
  knownOrders: ReadonlyMap<number, HlOrder>,
  maximumFeeBps: number,
  liquidationOrderIds: ReadonlySet<number> = new Set(),
): PerpsFillAccounting | null {
  let signed =
    BigInt(saved.beforeExposureUnits) *
    (saved.action.type === "order" && saved.action.orders[0]?.b === (saved.role === "entry") ? 1n : -1n);
  const initial = signed,
    scale = 10n ** BigInt(saved.market.sizeDecimals),
    parent = saved.action.type === "order" ? saved.action.orders[0] : undefined;
  if (!parent) {
    throw new ExecutionError("conflict", "The venue receipt has no reviewed parent order.");
  }
  let fee = 0n,
    risk = 0n,
    entered = 0n;
  for (const fill of fills) {
    const order = knownOrders.get(fill.oid),
      quantity = hlUnits(fill.sz, saved.market.sizeDecimals),
      price = hlUnits(fill.px, 18),
      charged = hlUnits(fill.fee, 6);
    if (
      !order ||
      fill.coin !== saved.market.name ||
      fill.side !== (order.b ? "B" : "A") ||
      quantity <= 0n ||
      hlUnits(fill.startPosition, saved.market.sizeDecimals) !== signed ||
      (!liquidationOrderIds.has(fill.oid) &&
        (order.b ? price > hlUnits(order.p, 18) : price < hlUnits(order.p, 18)))
    ) {
      throw new ExecutionError(
        "not_ready",
        "The venue fills do not match the owned order's exact size, direction or price bounds.",
      );
    }
    const notional = (quantity * hlUnits(fill.px, 6, "up") + scale - 1n) / scale;
    if (
      !liquidationOrderIds.has(fill.oid) &&
      charged > 0n &&
      charged * 10000n > notional * BigInt(maximumFeeBps) + 10000n
    ) {
      throw new ExecutionError("limit", "The finalized venue fee exceeds its reviewed cap.");
    }
    const after = signed + (order.b ? quantity : -quantity);
    if (
      order.r &&
      (signed === 0n || (signed > 0n ? after < 0n || after >= signed : after > 0n || after <= signed))
    ) {
      throw new ExecutionError("conflict", "A protective order increased or reversed the owned position.");
    }
    if (!order.r) {
      entered += quantity;
    }
    if (order.c === parent.c || saved.role === "exit") {
      risk += notional + (charged > 0n ? charged : 0n);
    }
    signed = after;
    fee += charged;
  }
  const position = state.assetPositions.find((p) => p.position.coin === saved.market.name)?.position;
  const observed = position ? hlUnits(position.szi, saved.market.sizeDecimals) : 0n;
  if (
    state.assetPositions.some(
      (p) => p.position.coin !== saved.market.name && hlUnits(p.position.szi, 18) !== 0n,
    ) ||
    observed !== signed ||
    (initial > 0n && observed < 0n) ||
    (initial < 0n && observed > 0n)
  ) {
    throw new ExecutionError("not_ready", "The final venue position differs from its complete fill history.");
  }
  const quantity = signed < 0n ? -signed : signed;
  if (saved.role === "entry" && entered > BigInt(saved.requestedUnits)) {
    throw new ExecutionError("limit", "The venue filled more entry units than were approved.");
  }
  // Overlapping entry and partially filled native exit keep claims held until the exit's terminal state is known.
  if (saved.role === "entry" && quantity > 0n && quantity !== entered) {
    return null;
  }
  const cashAfter = hlUnits(state.crossMarginSummary.totalRawUsd, 6, "down"),
    delta = cashAfter - BigInt(saved.beforeCashUnits);
  if (cashAfter < 0n) {
    throw new ExecutionError("not_ready", "The venue account has negative cash.");
  }
  const debit = delta < 0n ? -delta : 0n,
    credit = delta > 0n ? delta : 0n;
  const collateral =
    saved.role === "entry"
      ? quantity === 0n
        ? 0n
        : debit - fee
      : BigInt(saved.beforeExposureUnits) === 0n
        ? 0n
        : (BigInt(saved.beforeCollateralUnits) * quantity) / BigInt(saved.beforeExposureUnits);
  if (collateral < 0n || (saved.role === "entry" && quantity > 0n && debit === 0n)) {
    throw new ExecutionError(
      "not_ready",
      "The isolated collateral movement could not be fully accounted for.",
    );
  }
  return { quantity, debit, credit, collateral, risk, fee, cashAfter };
}
