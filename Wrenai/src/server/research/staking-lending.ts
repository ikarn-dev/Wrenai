import "server-only";
import { z } from "zod";
import { callViewFunction } from "@/server/near/rpc";
import type { ResearchInput, ResearchItem, ResearchSource } from "@/shared/research";
import { compare, decimal, displayDecimal, percent } from "./decimal";
import { rheaPrices } from "./rhea";

const units = z.string().regex(/^\d{1,78}$/);
export interface StakingReading {
  readonly tokenId: string;
  readonly symbol: string;
  readonly nearPerToken: bigint;
  readonly item: ResearchItem;
  readonly source: ResearchSource;
}

export async function stakingReadings(signal?: AbortSignal): Promise<readonly StakingReading[]> {
  const results = await Promise.allSettled([
    callViewFunction("meta-pool.near", "get_contract_state", {}, signal),
    callViewFunction("linear-protocol.near", "get_summary", {}, signal),
  ]);
  const readings: StakingReading[] = [];
  const meta = results[0],
    linear = results[1];
  if (meta?.status === "fulfilled") {
    const state = z
      .object({
        st_near_price: units,
        nslp_liquidity: units,
        nslp_current_discount_basis_points: z.coerce.number().int().min(0).max(10_000),
      })
      .parse(meta.value.value);
    const source: ResearchSource = {
      id: "meta-pool",
      label: "Meta Pool final on-chain state",
      url: "https://www.metapool.app/",
      observedAt: Date.now(),
      blockHeight: meta.value.blockHeight,
    };
    readings.push({
      tokenId: "meta-pool.near",
      symbol: "stNEAR",
      nearPerToken: BigInt(state.st_near_price),
      source,
      item: {
        id: "staking:meta",
        title: "Meta Pool / stNEAR",
        kind: "protocol",
        status: "observed",
        metrics: [
          {
            label: "Protocol redemption value",
            value: `${displayDecimal({ n: BigInt(state.st_near_price), d: 10n ** 24n }, 8)} NEAR per stNEAR`,
          },
          {
            label: "Reported instant-exit pool liquidity",
            value: `${displayDecimal({ n: BigInt(state.nslp_liquidity), d: 10n ** 24n }, 4)} NEAR`,
          },
          {
            label: "Current instant-exit discount",
            value: percent({ n: BigInt(state.nslp_current_discount_basis_points), d: 10_000n }),
          },
        ],
        note: "An exchange rate is not an APY. Immediate exit uses pool liquidity/discounts; delayed redemption has different timing.",
        sourceIds: [source.id],
      },
    });
  }
  if (linear?.status === "fulfilled") {
    const state = z.object({ ft_price: units, total_staked_near_amount: units }).parse(linear.value.value);
    const source: ResearchSource = {
      id: "linear",
      label: "LiNEAR final on-chain summary",
      url: "https://linearprotocol.org/",
      observedAt: Date.now(),
      blockHeight: linear.value.blockHeight,
    };
    readings.push({
      tokenId: "linear-protocol.near",
      symbol: "LiNEAR",
      nearPerToken: BigInt(state.ft_price),
      source,
      item: {
        id: "staking:linear",
        title: "LiNEAR liquid staking",
        kind: "protocol",
        status: "observed",
        metrics: [
          {
            label: "Protocol redemption value",
            value: `${displayDecimal({ n: BigInt(state.ft_price), d: 10n ** 24n }, 8)} NEAR per LiNEAR`,
          },
          {
            label: "Reported staked NEAR",
            value: displayDecimal({ n: BigInt(state.total_staked_near_amount), d: 10n ** 24n }, 2),
          },
        ],
        note: "Immediate exits depend on market liquidity. Protocol delayed unstaking normally takes several epochs; this rate is not a current APY.",
        sourceIds: [source.id],
      },
    });
  }
  return readings;
}

export async function lendingMarkets(
  input: ResearchInput,
  signal?: AbortSignal,
): Promise<{ readonly items: readonly ResearchItem[]; readonly sources: readonly ResearchSource[] }> {
  const registry = await rheaPrices(signal);
  const requested = input.symbols.length ? input.symbols : ["NEAR", "USDC", "USDT", "stNEAR"];
  const ids = [
    ...new Set(
      requested.flatMap((symbol) =>
        symbol.toUpperCase() === "NEAR"
          ? ["wrap.near"]
          : Object.entries(registry.tokens)
              .filter(([id, token]) => id === symbol || token.symbol.toUpperCase() === symbol.toUpperCase())
              .map(([id]) => id),
      ),
    ),
  ].slice(0, 4);
  const results = await Promise.allSettled(
    ids.map((tokenId) =>
      callViewFunction("contract.main.burrow.near", "get_asset", { token_id: tokenId }, signal),
    ),
  );
  const items: ResearchItem[] = [],
    sources: ResearchSource[] = [];
  const rates = new Map<string, ReturnType<typeof decimal>>();
  for (const [index, result] of results.entries()) {
    const tokenId = ids[index];
    if (result.status !== "fulfilled" || !tokenId) {
      continue;
    }
    const parsed = z
      .object({
        token_id: z.string(),
        supply_apr: z.string(),
        borrow_apr: z.string(),
        config: z.object({
          can_deposit: z.boolean(),
          can_borrow: z.boolean(),
          can_withdraw: z.boolean(),
          can_use_as_collateral: z.boolean(),
        }),
      })
      .safeParse(result.value.value);
    if (!parsed.success) {
      continue;
    }
    const data = parsed.data;
    const source: ResearchSource = {
      id: `lending:${tokenId}`,
      label: "RHEA Lending detailed on-chain view",
      url: "https://app.rhea.finance/lending",
      observedAt: Date.now(),
      blockHeight: result.value.blockHeight,
    };
    sources.push(source);
    rates.set(source.id, decimal(data.supply_apr));
    const symbol = registry.tokens[tokenId]?.symbol ?? tokenId;
    items.push({
      id: source.id,
      title: symbol,
      kind: "protocol",
      status: "observed",
      metrics: [
        { label: "Supply APR, excluding incentives", value: percent(decimal(data.supply_apr)) },
        { label: "Borrow APR, excluding incentives", value: percent(decimal(data.borrow_apr)) },
        { label: "Deposits", value: data.config.can_deposit ? "Enabled" : "Disabled" },
        { label: "Borrowing", value: data.config.can_borrow ? "Enabled" : "Disabled" },
        {
          label: "Collateral eligibility",
          value: data.config.can_use_as_collateral ? "Eligible" : "Not eligible",
        },
      ],
      note: `Asset ${tokenId}. These are the protocol's variable APR fields, excluding farming incentives; no account health or borrow approval is established.`,
      sourceIds: [source.id],
    });
  }
  items.sort((a, b) => compare(rates.get(b.id) ?? decimal("0"), rates.get(a.id) ?? decimal("0")));
  return { items, sources };
}
