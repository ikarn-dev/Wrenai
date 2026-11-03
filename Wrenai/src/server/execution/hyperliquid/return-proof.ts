import "server-only";
import { z } from "zod";
import type { HlUsdSend } from "@/shared/perps-return";
import { ExecutionError } from "../contracts";
import { readHlAccount } from "./account-state";
import { hlAddressSchema, hlDecimalSchema } from "./contracts";
import { hlUnits } from "./decimal";
import { readHlFills, readHlOpenOrders } from "./observations";
import type { PerpsReturnRecord } from "./return-record";
import { hlInfo } from "./transport";

const entrySchema = z.object({
  time: z.coerce.number().int().positive().safe(),
  hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  delta: z.unknown(),
});
const transferSchema = z.object({
  type: z.literal("internalTransfer"),
  usdc: hlDecimalSchema,
  fee: hlDecimalSchema,
  user: hlAddressSchema,
  destination: hlAddressSchema,
});

/** Numeric ledger money is decoded as text at the HTTP boundary, never through JS floats. */
export async function verifyReturnSource(
  saved: PerpsReturnRecord,
  request: HlUsdSend,
  originHashes: readonly string[],
  refundUnits: bigint,
): Promise<void> {
  const end = Date.now(),
    start = Math.min(saved.quotedAt, request.time);
  const [account, orders, fills, raw] = await Promise.all([
    readHlAccount(saved.address),
    readHlOpenOrders(saved.address),
    readHlFills(saved.address, start, end),
    hlInfo(
      { type: "userNonFundingLedgerUpdates", user: saved.address, startTime: start, endTime: end },
      undefined,
      true,
    ),
  ]);
  const entries = z.array(entrySchema).max(2000).parse(raw);
  if (
    entries.length >= 2000 ||
    entries.some((entry) => entry.time < start || entry.time > end) ||
    new Set(entries.map((entry) => entry.hash)).size !== entries.length ||
    account.assetPositions.some((row) => /[1-9]/.test(row.position.szi)) ||
    orders.length !== 0 ||
    fills.length !== 0 ||
    account.time < request.time ||
    account.time > end + 1000
  ) {
    throw new ExecutionError("not_ready", "Complete closed-account transfer evidence is not available yet.");
  }
  const outbound = entries.filter((entry) => {
    const delta = transferSchema.safeParse(entry.delta);
    return (
      delta.success &&
      delta.data.user.toLowerCase() === saved.address.toLowerCase() &&
      delta.data.destination.toLowerCase() === request.destination.toLowerCase()
    );
  });
  const sent = outbound[0];
  if (
    outbound.length !== 1 ||
    !sent ||
    sent.time < request.time ||
    !originHashes.some((hash) => hash.toLowerCase() === sent.hash.toLowerCase())
  ) {
    throw new ExecutionError("not_ready", "The route has not proved this exact outbound venue transfer.");
  }
  const delta = transferSchema.parse(sent.delta),
    amount = hlUnits(delta.usdc, 6),
    fee = hlUnits(delta.fee, 6),
    gross = BigInt(saved.debitUnits);
  if (fee > 1_000_000n || (amount !== gross && amount + fee !== gross)) {
    throw new ExecutionError("conflict", "The venue debit differs from the confirmed return amount.");
  }
  let returned = 0n;
  for (const entry of entries) {
    if (entry === sent) {
      continue;
    }
    const refund = transferSchema.safeParse(entry.delta);
    if (
      !refund.success ||
      refund.data.destination.toLowerCase() !== saved.address.toLowerCase() ||
      refund.data.user.toLowerCase() !== saved.depositAddress.toLowerCase() ||
      entry.time < sent.time
    ) {
      throw new ExecutionError(
        "not_ready",
        "An unrelated account movement needs review before releasing return funds.",
      );
    }
    returned += hlUnits(refund.data.usdc, 6);
  }
  // Bridge refunds have eight decimals; only complete six-decimal units can reach venue cash.
  if (
    returned !== refundUnits / 100n ||
    hlUnits(account.crossMarginSummary.totalRawUsd, 6, "down") !==
      BigInt(saved.beforeCashUnits) - gross + returned ||
    hlUnits(account.withdrawable, 6, "down") !== hlUnits(account.crossMarginSummary.totalRawUsd, 6, "down")
  ) {
    throw new ExecutionError(
      "not_ready",
      "The venue cash change and route refund have not reconciled exactly.",
    );
  }
}
