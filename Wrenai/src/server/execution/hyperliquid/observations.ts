import "server-only";
import { z } from "zod";
import { ExecutionError } from "../contracts";
import { cloidSchema, hlAddressSchema, hlDecimalSchema, hlSignedDecimalSchema } from "./contracts";
import { hlInfo } from "./transport";

export const hlOpenOrderSchema = z.object({
  coin: z.string().min(1).max(40),
  oid: z.number().int().nonnegative().safe(),
  side: z.enum(["A", "B"]),
  sz: hlDecimalSchema,
  origSz: hlDecimalSchema,
  limitPx: hlDecimalSchema,
  triggerPx: hlDecimalSchema,
  isTrigger: z.boolean(),
  reduceOnly: z.boolean(),
  cloid: cloidSchema.nullable().optional(),
});
const venueOrderSchema = z.object({
  coin: z.string().min(1).max(40),
  oid: z.number().int().nonnegative().safe(),
  side: z.enum(["A", "B"]),
  sz: hlDecimalSchema,
  origSz: hlDecimalSchema,
  limitPx: hlDecimalSchema,
  cloid: cloidSchema.nullable().optional(),
});
const statusSchema = z.union([
  z.object({ status: z.literal("unknownOid") }),
  z.object({
    status: z.literal("order"),
    order: z.object({
      order: venueOrderSchema,
      status: z.string().min(1).max(80),
      statusTimestamp: z.number().int().nonnegative().safe(),
    }),
  }),
]);
export type HlOrderStatus = z.infer<typeof statusSchema>;
export const hlFillSchema = z.object({
  coin: z.string().min(1).max(40),
  px: hlDecimalSchema,
  sz: hlDecimalSchema,
  startPosition: hlSignedDecimalSchema,
  closedPnl: hlSignedDecimalSchema,
  side: z.enum(["A", "B"]),
  hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  oid: z.number().int().nonnegative().safe(),
  tid: z.number().int().nonnegative().safe(),
  time: z.number().int().nonnegative().safe(),
  fee: hlSignedDecimalSchema,
  feeToken: z.literal("USDC"),
  liquidation: z
    .object({ liquidatedUser: hlAddressSchema.optional(), method: z.enum(["market", "backstop"]) })
    .optional(),
});
export type HlFill = z.infer<typeof hlFillSchema>;
export async function readHlOpenOrders(
  address: string,
): Promise<readonly z.infer<typeof hlOpenOrderSchema>[]> {
  const rows = z
    .array(hlOpenOrderSchema)
    .max(1000)
    .parse(await hlInfo({ type: "frontendOpenOrders", user: hlAddressSchema.parse(address) }));
  if (new Set(rows.map((row) => row.oid)).size !== rows.length) {
    throw new ExecutionError("not_ready", "The venue returned duplicate open orders.");
  }
  return rows;
}
export async function readHlOrderStatus(address: string, cloid: string): Promise<HlOrderStatus> {
  const result = statusSchema.parse(
    await hlInfo({
      type: "orderStatus",
      user: hlAddressSchema.parse(address),
      oid: cloidSchema.parse(cloid),
    }),
  );
  if (
    result.status === "order" &&
    result.order.order.cloid !== undefined &&
    result.order.order.cloid !== null &&
    result.order.order.cloid !== cloid
  ) {
    throw new ExecutionError("conflict", "The venue returned a different client order identity.");
  }
  return result;
}
export async function readHlFills(
  address: string,
  startTime: number,
  endTime: number,
): Promise<readonly HlFill[]> {
  const rows = z
    .array(hlFillSchema)
    .max(2000)
    .parse(
      await hlInfo({
        type: "userFillsByTime",
        user: hlAddressSchema.parse(address),
        startTime,
        endTime,
        aggregateByTime: false,
      }),
    );
  // A saturated response does not establish complete history; never price or clear a position from a truncated page.
  if (
    rows.length >= 2000 ||
    new Set(rows.map((row) => `${row.time}:${row.coin}:${row.tid}`)).size !== rows.length ||
    rows.some((row) => row.time < startTime || row.time > endTime)
  ) {
    throw new ExecutionError(
      "not_ready",
      "Complete venue fill history is unavailable for this reconciliation window.",
    );
  }
  return rows.toSorted((a, b) => a.time - b.time || a.tid - b.tid);
}
export const isolatedLiquidationSchema = z.object({
  time: z.number().int().nonnegative().safe(),
  hash: z.string(),
  delta: z.object({
    type: z.literal("liquidation"),
    leverageType: z.literal("Isolated"),
    liquidatedPositions: z
      .array(z.object({ coin: z.string().min(1).max(40) }))
      .min(1)
      .max(20),
  }),
});
export type IsolatedLiquidation = z.infer<typeof isolatedLiquidationSchema>;
export async function readHlTransfers(
  address: string,
  startTime: number,
  endTime: number,
): Promise<readonly IsolatedLiquidation[]> {
  const updates = z
    .array(z.object({ time: z.number().int().nonnegative().safe(), hash: z.string(), delta: z.unknown() }))
    .max(500)
    .parse(
      await hlInfo({
        type: "userNonFundingLedgerUpdates",
        user: hlAddressSchema.parse(address),
        startTime,
        endTime,
      }),
    );
  const liquidations: IsolatedLiquidation[] = [];
  for (const update of updates) {
    const liquidation = isolatedLiquidationSchema.safeParse(update);
    if (!liquidation.success || update.time < startTime || update.time > endTime || updates.length >= 500) {
      throw new ExecutionError(
        "not_ready",
        "An external deposit, withdrawal or account transfer needs reconciliation before new trading.",
      );
    }
    liquidations.push(liquidation.data);
  }
  return liquidations;
}
export async function verifyHlFee(address: string, maximumBps: number): Promise<void> {
  const fees = z
    .object({ userCrossRate: hlDecimalSchema })
    .parse(await hlInfo({ type: "userFees", user: hlAddressSchema.parse(address) }));
  const [whole = "0", fraction = ""] = fees.userCrossRate.split(".");
  const numerator = BigInt(whole + fraction),
    denominator = 10n ** BigInt(fraction.length);
  if (numerator * 10000n > BigInt(maximumBps) * denominator) {
    throw new ExecutionError("limit", "The venue's current taker fee exceeds this agent's reviewed fee cap.");
  }
}
