import "server-only";
import { z } from "zod";
import { minimumUnits } from "@/shared/token-units";
import { ExecutionError } from "../contracts";
import { hlDecimalSchema, hlSignedDecimalSchema } from "./contracts";
import { hlUnits } from "./decimal";
import { hlInfo } from "./transport";

export const hlMarketSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  szDecimals: z.number().int().min(0).max(6),
  maxLeverage: z.number().int().min(1).max(1000),
  isDelisted: z.boolean().optional(),
  marginTableId: z.number().int().nonnegative().optional(),
});
const tierSchema = z.object({ lowerBound: hlDecimalSchema, maxLeverage: z.number().int().positive() });
const metaSchema = z.object({
  universe: z.array(hlMarketSchema).min(1).max(2000),
  marginTables: z
    .array(z.tuple([z.number().int(), z.object({ marginTiers: z.array(tierSchema).min(1).max(50) })]))
    .max(2000),
});
const contextSchema = z.object({
  markPx: hlDecimalSchema,
  oraclePx: hlDecimalSchema,
  funding: hlSignedDecimalSchema,
});
const level = z.object({ px: hlDecimalSchema, sz: hlDecimalSchema, n: z.number().int().nonnegative() });
export const hlBookSchema = z.object({
  coin: z.string(),
  time: z.number().int().positive().safe(),
  levels: z.tuple([z.array(level).max(100), z.array(level).max(100)]),
});
export const hlMarketObservationSchema = z.strictObject({
  asset: z.number().int().min(0).max(1999),
  name: hlMarketSchema.shape.name,
  sizeDecimals: z.number().int().min(0).max(6),
  maxLeverage: z.number().int().positive(),
  mark: hlDecimalSchema,
  oracle: hlDecimalSchema,
  funding: hlSignedDecimalSchema,
  tiers: z.array(tierSchema).min(1).max(50),
  book: hlBookSchema,
  observedAt: z.number().int().positive().safe(),
});
export type HlMarket = z.infer<typeof hlMarketObservationSchema>;
export async function readHlMarket(market: string): Promise<HlMarket> {
  const requests = await Promise.allSettled([
    hlInfo({ type: "metaAndAssetCtxs" }),
    hlInfo({ type: "l2Book", coin: market }),
  ]);
  const metaResult = requests[0],
    bookResult = requests[1];
  if (metaResult?.status !== "fulfilled" || bookResult?.status !== "fulfilled") {
    throw new ExecutionError("not_ready", "The venue market metadata or order book is unavailable.");
  }
  const [meta, contexts] = z.tuple([metaSchema, z.array(contextSchema).max(2000)]).parse(metaResult.value);
  const matches = meta.universe
      .map((item, asset) => ({ item, asset }))
      .filter(({ item }) => item.name === market),
    match = matches[0];
  const context = match ? contexts[match.asset] : undefined,
    book = hlBookSchema.parse(bookResult.value),
    now = Date.now();
  if (
    matches.length !== 1 ||
    !match ||
    match.item.isDelisted ||
    !context ||
    contexts.length !== meta.universe.length ||
    book.coin !== market ||
    book.time > now + 1000 ||
    now - book.time >= 5000 ||
    hlUnits(context.markPx, 18) <= 0n ||
    hlUnits(context.oraclePx, 18) <= 0n
  ) {
    throw new ExecutionError(
      "not_ready",
      "Choose an active main-venue Perps market with a fresh, complete order book.",
    );
  }
  const tiers =
    match.item.marginTableId === undefined
      ? [{ lowerBound: "0", maxLeverage: match.item.maxLeverage }]
      : meta.marginTables.find(([id]) => id === match.item.marginTableId)?.[1].marginTiers;
  if (
    !tiers ||
    hlUnits(tiers[0]?.lowerBound ?? "1", 6) !== 0n ||
    tiers.some(
      (tier, index) =>
        index > 0 &&
        hlUnits(tier.lowerBound, 6, "up") <= hlUnits(tiers[index - 1]?.lowerBound ?? "0", 6, "up"),
    )
  ) {
    throw new ExecutionError("not_ready", "The venue's leverage tiers could not be verified.");
  }
  return {
    asset: match.asset,
    name: market,
    sizeDecimals: match.item.szDecimals,
    maxLeverage: match.item.maxLeverage,
    mark: context.markPx,
    oracle: context.oraclePx,
    funding: context.funding,
    tiers,
    book,
    observedAt: now,
  };
}
/** Depth is checked for the whole requested size, including partial fills at the marginal level. */
export function verifyHlDepth(market: HlMarket, buy: boolean, quantity: bigint, limitPrice: string): void {
  const levels = market.book.levels[buy ? 1 : 0],
    limit = hlUnits(limitPrice, 18);
  let remaining = quantity,
    previous = buy ? 0n : 10n ** 40n;
  if (quantity <= 0n) {
    throw new ExecutionError("limit", "A positive venue size is required.");
  }
  for (const level of levels) {
    const price = hlUnits(level.px, 18),
      size = hlUnits(level.sz, market.sizeDecimals);
    if (price <= 0n || size <= 0n || (buy ? price < previous : price > previous)) {
      throw new ExecutionError("not_ready", "The venue order book is inconsistent.");
    }
    previous = price;
    if (buy ? price > limit : price < limit) {
      break;
    }
    remaining -= minimumUnits(size, remaining);
    if (remaining === 0n) {
      return;
    }
  }
  throw new ExecutionError(
    "limit",
    "The requested order exceeds fresh book depth within the reviewed slippage cap.",
  );
}
