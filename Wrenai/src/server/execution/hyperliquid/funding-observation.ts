import "server-only";
import { z } from "zod";
import { ExecutionError } from "../contracts";
import type { HlAccountState } from "./account-state";
import type { PerpsCheckpoint } from "./checkpoint";
import { hlAddressSchema, hlSignedDecimalSchema } from "./contracts";
import { hlUnits } from "./decimal";
import type { PerpsFillAccounting } from "./fill-accounting";
import type { HlOrderRecord } from "./order-record";
import { hlInfo } from "./transport";

export const hlFundingSchema = z.object({
  time: z.number().int().positive().safe(),
  hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  delta: z.object({
    type: z.literal("funding"),
    coin: z.string().min(1).max(40),
    usdc: hlSignedDecimalSchema,
    szi: hlSignedDecimalSchema,
  }),
});
export type HlFunding = z.infer<typeof hlFundingSchema>;
export function observedIsolatedCollateral(state: HlAccountState): bigint {
  const equity = hlUnits(state.marginSummary.accountValue, 18),
    unrealized = state.assetPositions.reduce((sum, p) => sum + hlUnits(p.position.unrealizedPnl, 18), 0n),
    cash = hlUnits(state.crossMarginSummary.totalRawUsd, 18);
  const raw = equity - unrealized - cash;
  if (raw < 0n || raw % 10n ** 12n !== 0n) {
    throw new ExecutionError(
      "not_ready",
      "Exact isolated collateral could not be established from venue equity and unrealized PnL.",
    );
  }
  return raw / 10n ** 12n;
}
export async function readHlFunding(
  address: string,
  startTime: number,
  endTime: number,
): Promise<readonly HlFunding[]> {
  const rows = z
    .array(hlFundingSchema)
    .max(200)
    .parse(await hlInfo({ type: "userFunding", user: hlAddressSchema.parse(address), startTime, endTime }));
  if (
    rows.length >= 200 ||
    rows.some((row) => row.time < startTime || row.time > endTime) ||
    new Set(rows.map((row) => `${row.hash}:${row.time}:${row.delta.coin}`)).size !== rows.length
  ) {
    throw new ExecutionError("not_ready", "The venue funding history is incomplete or inconsistent.");
  }
  return rows;
}
export function fundingOnlyAccounting(
  saved: HlOrderRecord,
  checkpoint: PerpsCheckpoint,
  state: HlAccountState,
  base: PerpsFillAccounting,
  rows: readonly HlFunding[],
): PerpsFillAccounting {
  const signed = state.assetPositions.find((p) => p.position.coin === saved.market.name)?.position.szi ?? "0";
  if (
    base.quantity.toString() !== checkpoint.quantity ||
    rows.length === 0 ||
    rows.some(
      (row) =>
        row.delta.coin !== saved.market.name ||
        hlUnits(row.delta.szi, saved.market.sizeDecimals) !== hlUnits(signed, saved.market.sizeDecimals),
    )
  ) {
    throw new ExecutionError("not_ready", "Funding does not match the unchanged owned Perps position.");
  }
  const net = rows.reduce((sum, row) => sum + hlUnits(row.delta.usdc, 6), 0n),
    collateral = observedIsolatedCollateral(state);
  if (
    net === 0n ||
    base.cashAfter + collateral - BigInt(checkpoint.cash) - BigInt(checkpoint.collateral) !== net
  ) {
    throw new ExecutionError(
      "not_ready",
      "Venue cash and collateral changed beyond the confirmed funding payments.",
    );
  }
  return { ...base, collateral, risk: net < 0n ? -net : net, fee: 0n };
}
