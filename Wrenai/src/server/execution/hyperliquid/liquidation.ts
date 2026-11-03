import { ExecutionError } from "../contracts";
import type { HlOrder } from "./contracts";
import type { HlFill, IsolatedLiquidation } from "./observations";
import { perpsCloid } from "./order-plan";
import type { HlOrderRecord } from "./order-record";

/** Retrospective venue liquidation evidence, never an order passed to the Signer. Numeric ledger amounts are not used. */
export function corroboratePerpsLiquidations(
  saved: HlOrderRecord,
  fills: readonly HlFill[],
  ledger: readonly IsolatedLiquidation[],
  original: ReadonlyMap<number, HlOrder>,
): { readonly known: ReadonlyMap<number, HlOrder>; readonly forced: ReadonlySet<number> } {
  const known = new Map(original),
    forced = new Set<number>();
  for (const fill of fills) {
    if (known.has(fill.oid)) {
      continue;
    }
    const accountMatch = fill.liquidation?.liquidatedUser?.toLowerCase() === saved.address.toLowerCase();
    const ledgerMatch = ledger.some(
      (event) =>
        event.hash === fill.hash &&
        event.delta.liquidatedPositions.length === 1 &&
        event.delta.liquidatedPositions[0]?.coin === saved.market.name,
    );
    if (
      !fill.liquidation ||
      (!accountMatch && !ledgerMatch) ||
      fill.coin !== saved.market.name ||
      (fill.liquidation.liquidatedUser !== undefined && !accountMatch)
    ) {
      throw new ExecutionError(
        "not_ready",
        "An unrecognized venue fill needs review; it is not a proven liquidation of this agent's position.",
      );
    }
    known.set(fill.oid, {
      a: saved.market.asset,
      b: fill.side === "B",
      p: fill.px,
      s: fill.sz,
      r: true,
      t: { limit: { tif: "Ioc" } },
      c: perpsCloid(`liquidation:${fill.hash}:${fill.oid}`, "exit"),
    });
    forced.add(fill.oid);
  }
  if (
    ledger.some((event) =>
      event.delta.liquidatedPositions.some((position) => position.coin !== saved.market.name),
    )
  ) {
    throw new ExecutionError("not_ready", "Liquidation evidence includes an unmanaged market.");
  }
  return { known, forced };
}
