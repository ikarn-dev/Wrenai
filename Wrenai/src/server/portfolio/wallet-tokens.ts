import "server-only";
import { z } from "zod";
import { ChatError } from "@/server/chat/errors";
import { callViewFunction, viewNearBudgetBalance } from "@/server/near/rpc";
import { marketJson } from "@/server/research/market-http";
import {
  nearAccountSchema,
  type WalletHolding,
  walletAssetSchema,
  walletHoldingSchema,
} from "@/shared/agent-budget";
import { tokenUnitsSchema } from "@/shared/token-units";

export async function walletTokenHolding(accountId: string, rawAsset: string): Promise<WalletHolding> {
  nearAccountSchema.parse(accountId);
  const assetId = walletAssetSchema.parse(rawAsset);
  try {
    if (assetId === "native:near") {
      const value = await viewNearBudgetBalance(accountId);
      return walletHoldingSchema.parse({
        assetId,
        symbol: "NEAR",
        decimals: 24,
        balanceUnits: value.balance.toString(),
        spendableUnits: value.spendable.toString(),
        blockHeight: value.blockHeight,
        observedAt: Date.now(),
      });
    }
    const contract = nearAccountSchema.parse(assetId.slice("nep141:".length));
    const [balance, metadata] = await Promise.all([
      callViewFunction(contract, "ft_balance_of", { account_id: accountId }),
      callViewFunction(contract, "ft_metadata", {}),
    ]);
    const units = tokenUnitsSchema.parse(balance.value);
    const meta = z
      .object({ symbol: z.string().trim().min(1).max(64), decimals: z.number().int().min(0).max(36) })
      .parse(metadata.value);
    return walletHoldingSchema.parse({
      assetId,
      ...meta,
      balanceUnits: units,
      spendableUnits: units,
      blockHeight: balance.blockHeight,
      observedAt: Date.now(),
    });
  } catch {
    throw new ChatError(
      "unavailable",
      "This token's current wallet balance or token details could not be verified. Try again.",
    );
  }
}

/** FastNear discovers candidates only. Finalized RPC balances, not indexer amounts, authorize allocations. */
export async function walletTokenHoldings(
  accountId: string,
  extraAssets: readonly string[] = [],
): Promise<{
  readonly tokens: readonly WalletHolding[];
  readonly note: string;
}> {
  nearAccountSchema.parse(accountId);
  let candidates: readonly string[] = [];
  let incomplete = false;
  try {
    const { FASTNEAR_API_KEY } = process.env;
    const key = z
      .string()
      .trim()
      .min(1)
      .max(8000)
      .optional()
      .parse(FASTNEAR_API_KEY?.trim() || undefined);
    const response = await marketJson(
      "Wallet tokens",
      `https://api.fastnear.com/v1/account/${encodeURIComponent(accountId)}/ft`,
      {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      },
    );
    const value = z
      .object({
        account_id: nearAccountSchema,
        tokens: z
          .array(
            z.object({
              contract_id: nearAccountSchema,
              balance: tokenUnitsSchema.nullish(),
            }),
          )
          .max(5000),
      })
      .parse(response.value);
    if (value.account_id !== accountId) {
      throw new Error("Wrong wallet");
    }
    candidates = [
      ...new Set(
        value.tokens.filter((token) => token.balance !== "0").map((token) => `nep141:${token.contract_id}`),
      ),
    ];
    incomplete = candidates.length > 100;
  } catch {
    incomplete = true;
  }
  const assets = [
    ...new Set([
      "native:near",
      ...extraAssets.map((asset) => walletAssetSchema.parse(asset)),
      ...candidates.slice(0, 100),
    ]),
  ];
  const tokens: WalletHolding[] = [];
  // Bounded provider fan-out; a wallet with hundreds of touched contracts must not exhaust the RPC quota.
  for (let offset = 0; offset < assets.length; offset += 8) {
    const results = await Promise.allSettled(
      assets.slice(offset, offset + 8).map((asset) => walletTokenHolding(accountId, asset)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.balanceUnits !== "0" || extraAssets.includes(result.value.assetId)) {
          tokens.push(result.value);
        }
      } else {
        incomplete = true;
      }
    }
  }
  if (tokens.length === 0 && incomplete) {
    throw new ChatError(
      "unavailable",
      "Wallet tokens could not be loaded. Retry or check a token by its NEAR contract.",
    );
  }
  return {
    tokens,
    note: incomplete
      ? "Some tokens could not be listed. Check any missing token by its NEAR contract. Balances are rechecked when saving."
      : "NEAR keeps storage and 0.05 NEAR for gas. Balances are rechecked when saving.",
  };
}
