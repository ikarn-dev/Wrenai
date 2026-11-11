import "server-only";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { callViewFunction } from "@/server/near/rpc";
import { type IntentToken, intentTokens } from "@/server/research/intents";
import { WNEAR_ASSET_ID } from "@/shared/claims";

// Token identity and precision change only when 1Click relists a token; every claim quote re-verifies the route.
const REGISTRY_MAX_AGE_MS = 600_000;

/** NEAR-chain 1Click tokens, the only ones 1Click can pay to a NEAR wallet. */
export function walletPayoutTokens(tokens: readonly IntentToken[]): IntentToken[] {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token.assetId, (counts.get(token.assetId) ?? 0) + 1);
  }
  return tokens.filter(
    (token) =>
      token.blockchain === "near" && token.assetId.startsWith("nep141:") && counts.get(token.assetId) === 1,
  );
}

/**
 * Checks that the owner's wallet can receive `assetId`: a unique NEAR-chain registry token whose contract already
 * holds storage for the wallet. Storage is never funded automatically (Spec §4); wrap.near is the managed NEAR route.
 */
export async function assertWalletPayoutToken(accountId: string, assetId: string): Promise<IntentToken> {
  const { tokens } = await intentTokens(undefined, REGISTRY_MAX_AGE_MS);
  const token = walletPayoutTokens(tokens).find((candidate) => candidate.assetId === assetId);
  if (!token) {
    throw new ExecutionError(
      "not_ready",
      "Choose a NEAR token. Only NEAR tokens can be paid to your wallet.",
    );
  }
  if (assetId === WNEAR_ASSET_ID) {
    return token;
  }
  let registered: { readonly total: string } | null;
  try {
    const storage = await callViewFunction(assetId.slice("nep141:".length), "storage_balance_of", {
      account_id: accountId,
    });
    registered = z
      .object({ total: z.string().regex(/^\d+$/) })
      .nullable()
      .parse(storage.value);
  } catch {
    throw new ExecutionError(
      "not_ready",
      `Your wallet's ${token.symbol} registration could not be checked. Try again.`,
    );
  }
  if (registered === null || BigInt(registered.total) === 0n) {
    throw new ExecutionError(
      "not_ready",
      `Your wallet isn't registered for ${token.symbol}. Choose another token, or register it in your wallet first.`,
    );
  }
  return token;
}
