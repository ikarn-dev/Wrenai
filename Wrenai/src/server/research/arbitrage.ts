import "server-only";
import type { ResearchInput, ResearchItem, ResearchSource } from "@/shared/research";
import {
  compare,
  type Decimal,
  decimal,
  displayDecimal,
  percent,
  price,
  ratio,
  subtract,
  tokenUnits,
} from "./decimal";
import { perpMarkets } from "./hyperliquid";
import { intentTokens, selectToken } from "./intents";
import { type RheaPool, rheaPools, rheaQuote } from "./rhea";
import { stakingReadings } from "./staking-lending";

interface Edge {
  readonly pool: RheaPool;
  readonly from: string;
  readonly to: string;
  readonly multiplier: Decimal;
}
interface Cycle {
  readonly edges: readonly Edge[];
  readonly multiplier: Decimal;
}

function edgesFor(pool: RheaPool): readonly Edge[] {
  if (pool.pool_kind !== "SIMPLE_POOL" || pool.token_account_ids.length !== 2) {
    return [];
  }
  const [a, b] = pool.token_account_ids,
    [x, y] = pool.amounts;
  if (!a || !b || !x || !y || BigInt(x) === 0n || BigInt(y) === 0n) {
    return [];
  }
  const fee = 10_000n - BigInt(pool.total_fee);
  return [
    { pool, from: a, to: b, multiplier: { n: BigInt(y) * fee, d: BigInt(x) * 10_000n } },
    { pool, from: b, to: a, multiplier: { n: BigInt(x) * fee, d: BigInt(y) * 10_000n } },
  ];
}
function multiply(a: Decimal, b: Decimal): Decimal {
  return { n: a.n * b.n, d: a.d * b.d };
}

/** Pool IDs identify actual independent reserves, not different frontends for the same liquidity. */
export function candidateCycles(
  pools: readonly RheaPool[],
  symbols: readonly string[] = [],
): readonly Cycle[] {
  const eligible = pools
    .filter((pool) => compare(decimal(pool.tvl), decimal("1000")) >= 0)
    .sort((a, b) => compare(decimal(b.tvl), decimal(a.tvl)))
    .slice(0, 80);
  const edges = eligible.flatMap(edgesFor);
  const cycles: Cycle[] = [];
  for (const a of edges.filter((edge) => edge.from === "wrap.near")) {
    for (const b of edges.filter((edge) => edge.from === a.to && edge.pool.id !== a.pool.id)) {
      const ab = multiply(a.multiplier, b.multiplier);
      if (b.to === "wrap.near") {
        if (compare(ab, { n: 1n, d: 1n }) > 0) {
          cycles.push({ edges: [a, b], multiplier: ab });
        }
        continue;
      }
      for (const c of edges.filter(
        (edge) =>
          edge.from === b.to &&
          edge.to === "wrap.near" &&
          edge.pool.id !== a.pool.id &&
          edge.pool.id !== b.pool.id,
      )) {
        const abc = multiply(ab, c.multiplier);
        if (compare(abc, { n: 1n, d: 1n }) > 0) {
          cycles.push({ edges: [a, b, c], multiplier: abc });
        }
      }
    }
  }
  return cycles
    .filter((cycle) =>
      symbols.every(
        (symbol) =>
          symbol.toUpperCase() === "NEAR" ||
          symbol.toUpperCase() === "WNEAR" ||
          cycle.edges.some(
            (edge) =>
              edge.pool.token_account_ids.includes(symbol) ||
              edge.pool.token_symbols?.some((value) => value.toUpperCase() === symbol.toUpperCase()),
          ),
      ),
    )
    .sort((a, b) => compare(b.multiplier, a.multiplier))
    .slice(0, 3);
}

async function quoteCycle(
  cycle: Cycle,
  initial: bigint,
  index: number,
  signal?: AbortSignal,
): Promise<{ readonly item: ResearchItem; readonly sources: readonly ResearchSource[] }> {
  let output = initial;
  const sources: ResearchSource[] = [];
  for (const edge of cycle.edges) {
    const quote = await rheaQuote(edge.pool.id, edge.from, edge.to, output, signal);
    output = quote.amountOut;
    sources.push(quote.source);
    if (output === 0n) {
      break;
    }
  }
  const delta = output - initial;
  return {
    item: {
      id: `cycle:${index}`,
      title: cycle.edges.length === 3 ? "RHEA triangular quote" : "RHEA cross-pool round trip",
      kind: "opportunity",
      status: delta > 0n ? "quoted" : "no_edge",
      metrics: [
        { label: "Sample input", value: `${displayDecimal({ n: initial, d: 10n ** 24n }, 8)} NEAR` },
        { label: "Quoted final output", value: `${displayDecimal({ n: output, d: 10n ** 24n }, 8)} NEAR` },
        {
          label: "Delta after pool fees, before other costs",
          value: `${displayDecimal({ n: delta, d: 10n ** 24n }, 8)} NEAR`,
        },
        { label: "Gross quote edge", value: percent({ n: delta, d: initial }) },
        { label: "Liquidity IDs", value: cycle.edges.map((edge) => `RHEA ${edge.pool.id}`).join(" → ") },
      ],
      note: "Current view quotes include pool fees/size impact. Gas, storage, account readiness, atomicity and quote movement are excluded; this is not a confirmed net-profit opportunity.",
      sourceIds: [...new Set(sources.map((source) => source.id))],
    },
    sources,
  };
}

export async function arbitrageScan(
  input: ResearchInput,
  signal?: AbortSignal,
): Promise<{
  readonly items: readonly ResearchItem[];
  readonly sources: readonly ResearchSource[];
  readonly limitations: readonly string[];
  readonly summary: string;
}> {
  const [poolResult, stakingResult, perpResult, tokenResult] = await Promise.allSettled([
    rheaPools(signal),
    stakingReadings(signal),
    perpMarkets(input.symbols.length ? input.symbols : ["NEAR", "BTC", "ETH", "SOL"], signal),
    intentTokens(signal),
  ]);
  let initial = tokenUnits(input.amount ?? "1", 24);
  if (input.amountAsset && !["NEAR", "WNEAR"].includes(input.amountAsset.toUpperCase())) {
    if (
      !["USD", "USDC", "USDT"].includes(input.amountAsset.toUpperCase()) ||
      tokenResult.status !== "fulfilled"
    ) {
      throw new RangeError("Specify the scan amount in NEAR.");
    }
    const near = selectToken(tokenResult.value.tokens, "NEAR");
    if (
      !near?.price ||
      !near.priceUpdatedAt ||
      !Number.isFinite(Date.parse(near.priceUpdatedAt)) ||
      Math.abs(Date.now() - Date.parse(near.priceUpdatedAt)) > 120_000 ||
      decimal(near.price).n <= 0n
    ) {
      throw new RangeError("A fresh NEAR reference price is required to convert the sample amount.");
    }
    const converted = ratio(decimal(input.amount ?? "1"), decimal(near.price));
    initial = (converted.n * 10n ** 24n) / converted.d;
  }
  if (initial <= 0n) {
    throw new RangeError("Use a positive NEAR sample amount.");
  }
  const items: ResearchItem[] = [],
    sources: ResearchSource[] = [],
    limitations: string[] = [];
  if (input.amountAsset && !["NEAR", "WNEAR"].includes(input.amountAsset.toUpperCase())) {
    limitations.push(
      "The NEAR sample was converted using a reference NEAR/USD price; USDC/USDT inputs assume a one-dollar reference, not a verified stablecoin exit quote.",
    );
  }
  let cyclesChecked = 0;
  if (poolResult.status === "fulfilled") {
    sources.push(poolResult.value.source);
    const candidates = candidateCycles(poolResult.value.pools, input.symbols);
    const quoted = await Promise.allSettled(
      candidates.map((cycle, index) => quoteCycle(cycle, initial, index, signal)),
    );
    for (const quote of quoted) {
      if (quote.status === "fulfilled") {
        items.push(quote.value.item);
        sources.push(...quote.value.sources);
        cyclesChecked += 1;
      }
    }
    if (quoted.some((result) => result.status === "rejected")) {
      limitations.push("Some candidate cycles could not return fresh view quotes.");
    }
    if (stakingResult.status === "fulfilled") {
      const discounts = await Promise.allSettled(
        stakingResult.value.slice(0, 2).map(async (staking) => {
          const pool = poolResult.value.pools
            .filter(
              (pool) =>
                pool.token_account_ids.includes("wrap.near") &&
                pool.token_account_ids.includes(staking.tokenId),
            )
            .sort((a, b) => compare(decimal(b.tvl), decimal(a.tvl)))[0];
          if (!pool) {
            return null;
          }
          const entry = await rheaQuote(pool.id, "wrap.near", staking.tokenId, initial, signal);
          const redemption = (entry.amountOut * staking.nearPerToken) / 10n ** 24n;
          return {
            item: {
              id: `staking-discount:${staking.tokenId}`,
              title: `${staking.symbol} market / redemption comparison`,
              kind: "opportunity" as const,
              status: "indicative" as const,
              metrics: [
                { label: "Sample input", value: `${displayDecimal({ n: initial, d: 10n ** 24n }, 4)} NEAR` },
                {
                  label: "Quoted receipt tokens",
                  value: displayDecimal({ n: entry.amountOut, d: 10n ** 24n }, 8),
                },
                {
                  label: "Gross protocol redemption value",
                  value: `${displayDecimal({ n: redemption, d: 10n ** 24n }, 8)} NEAR`,
                },
                { label: "Gross value difference", value: percent({ n: redemption - initial, d: initial }) },
              ],
              note: "Redemption value is not immediate cash. Exit delays, liquidity, gas and registration costs remain; this is staking basis/carry, not an atomic arbitrage.",
              sourceIds: [entry.source.id, staking.source.id],
            },
            sources: [entry.source, staking.source],
          };
        }),
      );
      for (const result of discounts) {
        if (result.status === "fulfilled" && result.value) {
          items.push(result.value.item);
          sources.push(...result.value.sources);
        }
      }
    }
  } else {
    limitations.push("RHEA pool discovery was unavailable; no pool-cycle conclusion can be made.");
  }
  if (perpResult.status === "fulfilled") {
    sources.push(perpResult.value.source);
    for (const { market, context } of perpResult.value.markets.slice(0, 3)) {
      const spot =
        tokenResult.status === "fulfilled" ? selectToken(tokenResult.value.tokens, market.name) : undefined;
      const metrics = [
        { label: "Perp mark", value: price(context.markPx) },
        { label: "Hourly funding", value: percent(decimal(context.funding)) },
      ];
      if (
        spot?.price &&
        spot.priceUpdatedAt &&
        Number.isFinite(Date.parse(spot.priceUpdatedAt)) &&
        Math.abs(Date.now() - Date.parse(spot.priceUpdatedAt)) <= 120_000 &&
        decimal(spot.price).n > 0n
      ) {
        metrics.push(
          { label: "Spot reference", value: price(spot.price) },
          {
            label: "Indicative mark / spot basis",
            value: percent(
              ratio(subtract(decimal(context.markPx), decimal(spot.price)), decimal(spot.price)),
            ),
          },
        );
      }
      items.push({
        id: `basis:${market.name}`,
        title: `${market.name} funding / basis observation`,
        kind: "opportunity",
        status: "indicative",
        metrics,
        note: "Funding is variable. Spot references and perp marks are not a matched executable pair; exact asset equivalence, fees, borrowing, collateral and exit costs are unverified.",
        sourceIds: [perpResult.value.source.id, ...(spot ? ["intents-tokens"] : [])],
      });
    }
  } else {
    limitations.push("Live perpetual market data was unavailable.");
  }
  if (tokenResult.status === "fulfilled") {
    sources.push(tokenResult.value.source);
  }
  const positive = items.filter((item) => item.kind === "opportunity" && item.status === "quoted").length;
  return {
    items: items.slice(0, 10),
    sources: [...new Map(sources.map((source) => [source.id, source])).values()].slice(0, 20),
    limitations: [
      ...limitations,
      "No confirmed net arbitrage is established until all excluded costs and execution conditions are verified.",
    ].slice(0, 5),
    summary: positive
      ? `${positive} positive quoted pool round trip(s) before gas/storage costs; ${cyclesChecked} cycles quoted. Other rows are indicative basis or staking comparisons.`
      : `No positive quoted pool round trip found in the checked sample (${cyclesChecked} cycles quoted). Report available staking, basis and funding observations separately; do not invent a profitable trade.`,
  };
}
