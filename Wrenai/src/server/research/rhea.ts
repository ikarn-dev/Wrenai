import "server-only";
import { z } from "zod";
import { callViewFunction } from "@/server/near/rpc";
import type { ResearchItem, ResearchSource } from "@/shared/research";
import { compare, decimal, displayDecimal, price } from "./decimal";
import { marketJson } from "./market-http";

const account = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const amount = z.string().regex(/^\d{1,78}$/);
const poolSchema = z.object({
  id: z.coerce.string().regex(/^\d{1,10}$/),
  pool_kind: z.string(),
  token_account_ids: z.array(account).min(2).max(8),
  amounts: z.array(amount).max(8),
  total_fee: z.coerce.number().int().min(0).max(10_000),
  tvl: z.string().max(512),
  token_symbols: z.array(z.string().max(200)).optional(),
  farming: z.boolean().optional(),
});
export type RheaPool = z.infer<typeof poolSchema>;
const priceSchema = z.record(
  z.string(),
  z.object({
    price: z.string().max(512),
    symbol: z.string().max(200),
    decimal: z.coerce.number().int().min(0).max(36),
  }),
);
export type RheaPrices = z.infer<typeof priceSchema>;

export async function rheaPools(
  signal?: AbortSignal,
): Promise<{ readonly pools: readonly RheaPool[]; readonly source: ResearchSource }> {
  const response = await marketJson("RHEA", "https://indexer.ref.finance/list-top-pools", {
    cacheMs: 15_000,
    ...(signal ? { signal } : {}),
  });
  const rows = z.array(z.unknown()).max(10_000).parse(response.value);
  const pools = rows.flatMap((row) => {
    const parsed = poolSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    pools,
    source: {
      id: "rhea-pools",
      label: "RHEA pool indexer",
      url: "https://app.rhea.finance/pools",
      observedAt: response.capturedAt,
    },
  };
}
export async function rheaPrices(
  signal?: AbortSignal,
): Promise<{ readonly tokens: RheaPrices; readonly source: ResearchSource }> {
  const response = await marketJson("RHEA prices", "https://indexer.ref.finance/list-token-price", {
    cacheMs: 15_000,
    ...(signal ? { signal } : {}),
  });
  return {
    tokens: priceSchema.parse(response.value),
    source: {
      id: "rhea-prices",
      label: "RHEA reference prices",
      url: "https://app.rhea.finance/",
      observedAt: response.capturedAt,
    },
  };
}
export function poolSymbol(pool: RheaPool, index: number): string {
  const symbol = pool.token_symbols?.[index];
  return symbol && /^[A-Za-z0-9 ._$+-]{1,24}$/.test(symbol)
    ? symbol
    : (pool.token_account_ids[index] ?? "Unknown token");
}
export function poolItems(
  pools: readonly RheaPool[],
  symbols: readonly string[],
  limit = 5,
): readonly ResearchItem[] {
  return pools
    .filter(
      (pool) =>
        symbols.length === 0 ||
        symbols.some(
          (symbol) =>
            pool.token_account_ids.includes(symbol) ||
            pool.token_symbols?.some((value) => value.toUpperCase() === symbol.toUpperCase()) ||
            (symbol.toUpperCase() === "NEAR" && pool.token_account_ids.includes("wrap.near")),
        ),
    )
    .sort((a, b) => compare(decimal(b.tvl), decimal(a.tvl)))
    .slice(0, limit)
    .map((pool) => ({
      id: `rhea:${pool.id}`,
      title: pool.token_account_ids.map((_value, index) => poolSymbol(pool, index)).join(" / "),
      kind: "market",
      status: "observed",
      metrics: [
        { label: "Pool", value: pool.id },
        { label: "Reported liquidity", value: price(pool.tvl) },
        { label: "Pool fee", value: `${displayDecimal({ n: BigInt(pool.total_fee), d: 100n }, 2)}%` },
        { label: "Type", value: pool.pool_kind },
      ],
      note: "Indexer liquidity is reference data. A fresh size-specific quote is required for a trade.",
      sourceIds: ["rhea-pools"],
    }));
}
export async function rheaQuote(
  poolId: string,
  tokenIn: string,
  tokenOut: string,
  units: bigint,
  signal?: AbortSignal,
): Promise<{ readonly amountOut: bigint; readonly source: ResearchSource }> {
  const id = z.coerce.number().int().min(0).max(10_000_000).parse(poolId);
  const reading = await callViewFunction(
    "v2.ref-finance.near",
    "get_return",
    {
      pool_id: id,
      token_in: account.parse(tokenIn),
      token_out: account.parse(tokenOut),
      amount_in: amount.parse(units.toString()),
    },
    signal,
  );
  return {
    amountOut: BigInt(amount.parse(reading.value)),
    source: {
      id: `rhea-quote-${id}`,
      label: `RHEA pool ${id} view quote`,
      url: `https://app.rhea.finance/pool/${id}`,
      observedAt: Date.now(),
      blockHeight: reading.blockHeight,
    },
  };
}
