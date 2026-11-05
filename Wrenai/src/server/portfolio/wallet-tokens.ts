import "server-only";
import { z } from "zod";
import { ChatError } from "@/server/chat/errors";
import { callViewFunction, viewNearBudgetBalance } from "@/server/near/rpc";
import { marketJson } from "@/server/research/market-http";
import {
  MAX_WALLET_TOKEN_DECIMALS,
  nearAccountSchema,
  type WalletHolding,
  walletAssetSchema,
  walletHoldingSchema,
} from "@/shared/agent-budget";
import { tokenUnitsSchema } from "@/shared/token-units";
import { WALLET_SWAP_INPUT, WALLET_SWAP_USDC } from "@/shared/wallet-swap";

const NATIVE = "native:near";
const INDEXED_CONTRACT = z.object({ contract_id: nearAccountSchema });
export const WALLET_SCAN_TIMEOUT_MS = 15_000;

export async function walletTokenHolding(
  accountId: string,
  rawAsset: string,
  signal?: AbortSignal,
): Promise<WalletHolding> {
  nearAccountSchema.parse(accountId);
  const assetId = walletAssetSchema.parse(rawAsset);
  const holding = await readWalletHolding(accountId, assetId, signal, true);
  if (holding === null) {
    throw new ChatError("unavailable", "This token's wallet balance could not be verified.");
  }
  return holding;
}

async function readWalletHolding(
  accountId: string,
  assetId: string,
  signal: AbortSignal | undefined,
  includeEmpty: boolean,
): Promise<WalletHolding | null> {
  try {
    if (assetId === NATIVE) {
      const value = await viewNearBudgetBalance(accountId, true, signal);
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
    const contract = assetId.slice("nep141:".length);
    const [balance, exactMetadata] = await Promise.all([
      callViewFunction(contract, "ft_balance_of", { account_id: accountId }, signal),
      includeEmpty ? callViewFunction(contract, "ft_metadata", {}, signal) : null,
    ]);
    const units = tokenUnitsSchema.parse(balance.value);
    if (units === "0" && !includeEmpty) {
      return null;
    }
    const metadata = exactMetadata ?? (await callViewFunction(contract, "ft_metadata", {}, signal));
    const meta = z
      .object({ symbol: z.string().trim(), decimals: z.number().int().min(0).max(MAX_WALLET_TOKEN_DECIMALS) })
      .parse(metadata.value);
    return walletHoldingSchema.parse({
      assetId,
      ...meta,
      symbol: assetId === WALLET_SWAP_INPUT ? "wNEAR" : meta.symbol.slice(0, 64) || contract,
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
  signal = AbortSignal.timeout(WALLET_SCAN_TIMEOUT_MS),
): Promise<{
  readonly tokens: readonly WalletHolding[];
  readonly note: string;
  readonly complete: boolean;
}> {
  nearAccountSchema.parse(accountId);
  const explicit = new Set(extraAssets.map((asset) => walletAssetSchema.parse(asset)));
  const priorityAssets = new Set([NATIVE, ...explicit, WALLET_SWAP_USDC, WALLET_SWAP_INPUT]);
  const tokens: WalletHolding[] = [];
  let incomplete = false;
  async function readAssets(assets: readonly string[]): Promise<void> {
    // Bound provider fan-out for wallets that have touched many token contracts.
    for (let offset = 0; offset < assets.length; offset += 8) {
      if (signal.aborted) {
        incomplete = true;
        return;
      }
      const results = await Promise.allSettled(
        assets
          .slice(offset, offset + 8)
          .map((asset) => readWalletHolding(accountId, asset, signal, explicit.has(asset))),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (result.value && (result.value.balanceUnits !== "0" || explicit.has(result.value.assetId))) {
            tokens.push(result.value);
          }
        } else {
          incomplete = true;
        }
      }
    }
  }
  const priority = readAssets([...priorityAssets]);
  const candidates = new Set<string>();
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
        signal,
      },
    );
    const value = z
      .object({ account_id: nearAccountSchema, tokens: z.array(z.unknown()) })
      .parse(response.value);
    if (value.account_id !== accountId) {
      throw new Error("Wrong wallet");
    }
    for (const row of value.tokens) {
      const token = INDEXED_CONTRACT.safeParse(row);
      if (!token.success) {
        incomplete = true;
        continue;
      }
      // Even a zero from the indexer can be stale. Only the contract can rule out a balance.
      const asset = `nep141:${token.data.contract_id}`;
      if (!priorityAssets.has(asset)) {
        candidates.add(asset);
      }
    }
  } catch {
    incomplete = true;
  }
  await priority;
  await readAssets([...candidates]);
  if (tokens.length === 0 && incomplete) {
    throw new ChatError(
      "unavailable",
      "Wallet tokens could not be loaded. Retry or check a token by its NEAR contract.",
    );
  }
  return {
    tokens,
    complete: !incomplete,
    note: incomplete
      ? "Some tokens could not be listed. Check any missing token by its NEAR contract. Balances are rechecked when saving."
      : "NEAR keeps storage and 0.05 NEAR for gas. Balances are rechecked when saving.",
  };
}
