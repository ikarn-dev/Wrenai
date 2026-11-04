import "server-only";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { callViewFunction } from "@/server/near/rpc";
import { MEME_DCL, memePoolSchema } from "@/server/squint/near-profile";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import type { TradeAsset } from "@/shared/trade-preview";
import { assetUsdPrice, type InstructionPrice, instructionPrice } from "./instruction-price";

const wnear: TradeAsset = {
  assetId: "nep141:wrap.near",
  symbol: "nep141:wrap.near",
  tokenSymbol: "wNEAR",
  blockchain: "near",
  contractAddress: "wrap.near",
  decimals: 24,
};
/** Finalized DCL view quote, not a transaction simulation or promise of a future fill. */
export async function memeDclQuote(
  poolId: string,
  input: string,
  output: string,
  units: bigint,
  blockHash?: string,
): Promise<bigint> {
  const value = await callViewFunction(
    MEME_DCL,
    "quote",
    { pool_ids: [poolId], input_token: input, output_token: output, input_amount: units.toString() },
    undefined,
    blockHash,
  );
  return BigInt(z.object({ amount: positiveTokenUnitsSchema }).parse(value.value).amount);
}
export async function memeMarketPrice(
  base: TradeAsset,
  cash: TradeAsset,
  poolId: string,
  unit: "usd" | "quote_token",
): Promise<InstructionPrice> {
  const reading = await callViewFunction(MEME_DCL, "get_pool", { pool_id: poolId });
  const pool = memePoolSchema.parse(reading.value);
  const token = base.assetId.slice(7);
  if (
    !reading.blockHash ||
    pool.pool_id !== poolId ||
    ![pool.token_x, pool.token_y].includes(token) ||
    ![pool.token_x, pool.token_y].includes("wrap.near")
  ) {
    throw new ExecutionError("not_ready", "The hunter's exact independent price pool is unavailable.");
  }
  const output = await memeDclQuote(
    poolId,
    token,
    "wrap.near",
    10n ** BigInt(base.decimals),
    reading.blockHash,
  );
  const at = Date.now();
  if (unit === "quote_token" && cash.assetId === wnear.assetId) {
    return { n: output, d: 10n ** 24n, observedAt: at };
  }
  const reference =
    unit === "usd"
      ? await assetUsdPrice(wnear.assetId)
      : await instructionPrice(wnear, cash, 10n ** 24n, false, "quote_token");
  return {
    n: output * reference.n,
    d: 10n ** 24n * reference.d,
    observedAt: Math.min(at, reference.observedAt),
  };
}
