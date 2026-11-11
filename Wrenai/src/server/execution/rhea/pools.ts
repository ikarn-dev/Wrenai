import "server-only";
import { z } from "zod";
import { callViewFunction } from "@/server/near/rpc";
import type { IntentToken } from "@/server/research/intents";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import { RHEA_DCL } from "./contracts";
import { nativeTokenAsset } from "./inventory";

// Fee tiers present on dclv2.ref-labs.near (list_pools, November 2026). Pool IDs order the two contracts
// ascending, then the fee, so a pair has at most one pool per tier.
const DCL_FEES = [100, 400, 1000, 2000, 10000, 20000, 30000, 40000] as const;
// The quote path requires an untaxed, open pool; anything else is not a candidate.
const poolSchema = z.object({
  pool_id: z.string().max(200),
  token_x: z.string(),
  token_y: z.string(),
  state: z.literal("Running"),
  total_liquidity: positiveTokenUnitsSchema,
  tax: z.null(),
  whitelist: z.null(),
});

/** The pair's running RHEA DCL pool with the most liquidity, or null when RHEA has none. */
export async function findDclPool(a: string, b: string): Promise<string | null> {
  const [x, y] = [a, b].toSorted();
  if (!x || !y || x === y) {
    return null;
  }
  const reads = await Promise.all(
    DCL_FEES.map((fee) => callViewFunction(RHEA_DCL, "get_pool", { pool_id: `${x}|${y}|${fee}` })),
  );
  let best: z.infer<typeof poolSchema> | null = null;
  for (const reading of reads) {
    const pool = poolSchema.safeParse(reading.value);
    if (
      pool.success &&
      pool.data.token_x === x &&
      pool.data.token_y === y &&
      (best === null || BigInt(pool.data.total_liquidity) > BigInt(best.total_liquidity))
    ) {
      best = pool.data;
    }
  }
  return best?.pool_id ?? null;
}

/** Exact identities and finalized `ft_metadata` decimals for tokens traded outside the 1Click registry. */
export async function publicRouteTokens(ids: readonly string[]): Promise<readonly IntentToken[]> {
  return Promise.all(
    ids
      .filter((id) => id.startsWith("nep141:"))
      .map(async (id) => {
        const asset = await nativeTokenAsset(id);
        return {
          assetId: id,
          symbol: asset.tokenSymbol,
          blockchain: "near",
          decimals: asset.decimals,
          contractAddress: asset.contractAddress,
        };
      }),
  );
}

/** NEAR contracts named in strategy text, such as `token.tkn.near`, as asset IDs. */
export function namedContracts(text: string): readonly string[] {
  const found = text
    .toLowerCase()
    .match(/(?:nep141:)?\b(?:[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:near|tg)|[a-f0-9]{64})\b/g);
  return [...new Set((found ?? []).map((name) => `nep141:${name.replace(/^nep141:/, "")}`))];
}
