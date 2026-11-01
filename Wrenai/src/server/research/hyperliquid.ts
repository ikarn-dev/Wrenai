import "server-only";
import { z } from "zod";
import type { ResearchItem, ResearchSource } from "@/shared/research";
import { compare, decimal, percent, price } from "./decimal";
import { marketJson } from "./market-http";

const marketSchema = z.object({
  name: z.string().max(60),
  szDecimals: z.coerce.number().int().min(0).max(18),
  maxLeverage: z.coerce.number().int().min(1).max(1000),
  isDelisted: z.boolean().optional(),
});
const contextSchema = z.object({
  markPx: z.string(),
  oraclePx: z.string().optional(),
  funding: z.string(),
  openInterest: z.string(),
  dayNtlVlm: z.string(),
});
export interface PerpMarket {
  readonly market: z.infer<typeof marketSchema>;
  readonly context: z.infer<typeof contextSchema>;
}

export async function perpMarkets(
  symbols: readonly string[],
  signal?: AbortSignal,
): Promise<{
  readonly markets: readonly PerpMarket[];
  readonly source: ResearchSource;
  readonly items: readonly ResearchItem[];
}> {
  const response = await marketJson("Hyperliquid", "https://api.hyperliquid.xyz/info", {
    body: { type: "metaAndAssetCtxs" },
    cacheMs: 5_000,
    ...(signal ? { signal } : {}),
  });
  const [meta, contexts] = z
    .tuple([z.object({ universe: z.array(marketSchema).max(2_000) }), z.array(contextSchema).max(2_000)])
    .parse(response.value);
  const selected = meta.universe
    .flatMap((market, index) => {
      const context = contexts[index];
      return context &&
        !market.isDelisted &&
        (symbols.length === 0 || symbols.some((symbol) => symbol.toUpperCase() === market.name.toUpperCase()))
        ? [{ market, context }]
        : [];
    })
    .sort((a, b) => compare(decimal(b.context.dayNtlVlm), decimal(a.context.dayNtlVlm)))
    .slice(0, 6);
  const source: ResearchSource = {
    id: "hyperliquid-perps",
    label: "Hyperliquid live perpetual markets",
    url: "https://app.hyperliquid.xyz/",
    observedAt: response.capturedAt,
  };
  return {
    markets: selected,
    source,
    items: selected.map(({ market, context }) => ({
      id: `hl:${market.name}`,
      title: `${market.name} perpetual`,
      kind: "market",
      status: "indicative",
      metrics: [
        { label: "Mark price", value: price(context.markPx) },
        { label: "Oracle price", value: context.oraclePx ? price(context.oraclePx) : "Unavailable" },
        { label: "Current hourly funding", value: percent(decimal(context.funding)) },
        {
          label: "Funding direction",
          value:
            decimal(context.funding).n > 0n
              ? "Longs pay shorts"
              : decimal(context.funding).n < 0n
                ? "Shorts pay longs"
                : "No current funding",
        },
        { label: "24h notional volume", value: price(context.dayNtlVlm) },
      ],
      note: "Mark/oracle values are not executable prices. Funding is variable; fees, collateral, liquidation and basis risk remain.",
      sourceIds: [source.id],
    })),
  };
}

export async function perpBook(symbol: string, signal?: AbortSignal): Promise<ResearchItem> {
  const coin = z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,60}$/)
    .parse(symbol);
  const response = await marketJson("Hyperliquid book", "https://api.hyperliquid.xyz/info", {
    body: { type: "l2Book", coin },
    ...(signal ? { signal } : {}),
  });
  const level = z.object({ px: z.string(), sz: z.string() });
  const book = z
    .object({
      coin: z.string(),
      time: z.coerce.number().int().positive(),
      levels: z.tuple([z.array(level).max(100), z.array(level).max(100)]),
    })
    .parse(response.value);
  const bid = book.levels[0][0],
    ask = book.levels[1][0];
  return {
    id: `hl-book:${coin}`,
    title: `${coin} top-of-book snapshot`,
    kind: "quote",
    status: "indicative",
    metrics: [
      { label: "Best bid", value: bid ? price(bid.px) : "Empty" },
      { label: "Bid size", value: bid?.sz ?? "Unavailable" },
      { label: "Best ask", value: ask ? price(ask.px) : "Empty" },
      { label: "Ask size", value: ask?.sz ?? "Unavailable" },
      { label: "Venue time", value: new Date(book.time).toISOString() },
    ],
    note: "Top-of-book only; a size-specific fill estimate and actual fee tier are still required.",
    sourceIds: ["hyperliquid-perps"],
  };
}

export async function publicFills(
  address: string,
  signal?: AbortSignal,
): Promise<{ readonly items: readonly ResearchItem[]; readonly source: ResearchSource }> {
  const user = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .parse(address);
  const response = await marketJson("Hyperliquid public fills", "https://api.hyperliquid.xyz/info", {
    body: { type: "userFills", user },
    ...(signal ? { signal } : {}),
  });
  const fills = z
    .array(
      z.object({
        coin: z.string().max(60),
        px: z.string(),
        sz: z.string(),
        time: z.coerce.number().int().positive(),
        side: z.enum(["A", "B"]),
        hash: z.string().max(200),
        fee: z.string().optional(),
      }),
    )
    .max(2_000)
    .parse(response.value);
  const source: ResearchSource = {
    id: "leader-fills",
    label: "Hyperliquid public account fills",
    url: `https://app.hyperliquid.xyz/explorer/address/${user}`,
    observedAt: response.capturedAt,
  };
  return {
    source,
    items: fills.slice(0, 5).map((fill, index) => ({
      id: `fill:${fill.hash}:${index}`,
      title: `${fill.side === "B" ? "Buy" : "Sell"} ${fill.coin}`,
      kind: "account",
      status: "observed",
      metrics: [
        { label: "Filled price", value: price(fill.px) },
        { label: "Filled size", value: fill.sz },
        { label: "Time", value: new Date(fill.time).toISOString() },
        { label: "Reported fee", value: fill.fee ?? "Not supplied" },
      ],
      note: "Historical public fills do not establish the leader's profitability or a price a follower can obtain now.",
      sourceIds: [source.id],
    })),
  };
}
