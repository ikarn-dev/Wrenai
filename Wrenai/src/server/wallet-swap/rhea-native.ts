import "server-only";
import { z } from "zod";
import { memeDclQuote } from "@/server/engine/meme-price";
import { ExecutionError } from "@/server/execution/contracts";
import { callViewFunction, finalBlockTime, readContractCodeHash } from "@/server/near/rpc";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import type { TradeAsset } from "@/shared/trade-preview";
import {
  WALLET_SWAP_NATIVE_OUTPUT,
  WALLET_SWAP_RHEA_DCL,
  WALLET_SWAP_RHEA_POOL,
  WALLET_SWAP_RHEA_WRAP,
  WALLET_SWAP_USDC,
} from "@/shared/wallet-swap";

const IMPLEMENTATIONS = [
  // DAO upgrade JXr2gBBLywhudazUmSGmB7HHm7CgPnNMf2DXNF3dYAJ. Native USDC payout covered by a captured receipt test.
  [WALLET_SWAP_RHEA_DCL, "3G34Nhjmir5JPYPtijaA9iCNnHDPR7h3wfC9H77woEGo"],
  [WALLET_SWAP_RHEA_WRAP, "DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1"],
  [WALLET_SWAP_USDC.slice("nep141:".length), "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q"],
] as const;

export const nativeNearAsset: TradeAsset = {
  assetId: WALLET_SWAP_NATIVE_OUTPUT,
  symbol: "NEAR",
  tokenSymbol: "NEAR",
  blockchain: "near",
  contractAddress: null,
  decimals: 24,
};

export function usdcAsset(): TradeAsset {
  return {
    assetId: WALLET_SWAP_USDC,
    symbol: "USDC",
    tokenSymbol: "USDC",
    blockchain: "near",
    contractAddress: WALLET_SWAP_USDC.slice("nep141:".length),
    decimals: 6,
  };
}

function hasPinnedCode(actual: Awaited<ReturnType<typeof readContractCodeHash>>, expected: string): boolean {
  return (
    actual.globalCodeAccount === null &&
    (actual.globalCodeHash === null
      ? actual.codeHash === expected
      : actual.globalCodeHash === expected && actual.codeHash === "11111111111111111111111111111111")
  );
}

export async function verifyRheaNativeContracts(blockHash?: string): Promise<string> {
  // Pin approval checks to one final block even when RPC requests straddle a block boundary.
  const [dcl, ...tokens] = IMPLEMENTATIONS;
  const head = blockHash ? undefined : await readContractCodeHash(dcl[0]);
  const observed = blockHash ?? head?.blockHash;
  const controls = head
    ? [head, ...(await Promise.all(tokens.map(([account]) => readContractCodeHash(account, observed))))]
    : await Promise.all(IMPLEMENTATIONS.map(([account]) => readContractCodeHash(account, observed)));
  if (controls.some((control, index) => !hasPinnedCode(control, IMPLEMENTATIONS[index]?.[1] ?? ""))) {
    throw new ExecutionError("not_ready", "The reviewed native swap contract has changed.");
  }
  if (!observed || controls.some((control) => control.blockHash !== observed)) {
    throw new ExecutionError("not_ready", "The native swap contract checks used different blocks.");
  }
  return observed;
}

export async function quoteRheaNative(
  inputUnits: string,
  slippageBps: number,
  maximumFeeBps: number,
  signal?: AbortSignal,
): Promise<{ outputUnits: string; minimumOutputUnits: string; blockHash: string }> {
  if (maximumFeeBps < 1) {
    throw new ExecutionError("limit", "This pool's 0.01% fee exceeds your fee limit.");
  }
  const reading = await callViewFunction(
    WALLET_SWAP_RHEA_DCL,
    "get_pool",
    { pool_id: WALLET_SWAP_RHEA_POOL },
    signal,
  );
  if (!reading.blockHash) {
    throw new ExecutionError("not_ready", "The finalized native swap quote is unavailable.");
  }
  const pool = z
    .object({
      pool_id: z.literal(WALLET_SWAP_RHEA_POOL),
      token_x: z.string(),
      token_y: z.string(),
      state: z.literal("Running"),
      total_liquidity: positiveTokenUnitsSchema,
      tax: z.null(),
      whitelist: z.null(),
    })
    .parse(reading.value);
  if (pool.token_x !== WALLET_SWAP_USDC.slice("nep141:".length) || pool.token_y !== WALLET_SWAP_RHEA_WRAP) {
    throw new ExecutionError("not_ready", "The native swap pool no longer matches USDC and NEAR.");
  }
  const [codeBlock, observedAt, quotedOutput] = await Promise.all([
    verifyRheaNativeContracts(reading.blockHash),
    finalBlockTime(reading.blockHash),
    memeDclQuote(
      WALLET_SWAP_RHEA_POOL,
      WALLET_SWAP_USDC.slice("nep141:".length),
      WALLET_SWAP_RHEA_WRAP,
      BigInt(positiveTokenUnitsSchema.parse(inputUnits)),
      reading.blockHash,
    ),
  ]);
  if (codeBlock !== reading.blockHash) {
    throw new ExecutionError("not_ready", "The native swap contract checks used different blocks.");
  }
  if (observedAt > Date.now() + 1000 || Date.now() - observedAt >= 15_000) {
    throw new ExecutionError("not_ready", "The finalized native swap quote is stale.");
  }
  const output = positiveTokenUnitsSchema.parse(quotedOutput.toString()),
    minimum = (BigInt(output) * BigInt(10_000 - slippageBps) + 9_999n) / 10_000n;
  return {
    outputUnits: output,
    minimumOutputUnits: positiveTokenUnitsSchema.parse(minimum.toString()),
    blockHash: reading.blockHash,
  };
}
