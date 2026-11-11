import "server-only";
import { ExecutionError } from "@/server/execution/contracts";
import type { IntentToken } from "@/server/research/intents";
import { WALLET_SWAP_INPUT } from "@/shared/wallet-swap";

export const NATIVE_NEAR = "native:near";
export const NATIVE_NEAR_OUTPUT_UNAVAILABLE =
  "Native NEAR payouts are currently available for USDC swaps from your wallet.";

function normalizeTokenName(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bnative near\b/g, NATIVE_NEAR)
    .replace(/\bwrapped near\b/g, "wnear")
    .replace(/\b(?:usd|us dollar) coin\b/g, "usdc");
}

function tokenSymbol(token: IntentToken): string {
  return token.assetId === WALLET_SWAP_INPUT ? "wnear" : token.symbol.toLowerCase();
}

function matchesContract(token: IntentToken, name: string): boolean {
  return (
    token.assetId === name ||
    (token.blockchain.toLowerCase() === "near" &&
      (token.contractAddress === name || token.assetId === `nep141:${name}`))
  );
}

export function exactToken(tokens: readonly IntentToken[], hint: string): string {
  const name = normalizeTokenName(hint.trim());
  if (name === "near" || name === NATIVE_NEAR) {
    return NATIVE_NEAR;
  }
  const contracts = tokens.filter((token) => matchesContract(token, name));
  const matches = contracts.length
    ? contracts
    : tokens.filter((token) => token.blockchain.toLowerCase() === "near" && tokenSymbol(token) === name);
  if (matches.length !== 1 || !matches[0]) {
    throw new ExecutionError(
      "not_ready",
      `Specify the exact supported token contract for ${hint.slice(0, 60)}.`,
    );
  }
  return matches[0].assetId;
}

/** A ticker authorizes only its unique NEAR identity. An explicit contract can disambiguate a ticker. */
export function explicitTokenIds(tokens: readonly IntentToken[], text: string): ReadonlySet<string> {
  const names = new Set(
    normalizeTokenName(text)
      .replace(/\bon (?:the )?(?:near(?: mainnet| network| chain)?|rhea)\b|\bnear wallet\b/g, " ")
      .match(/[a-z0-9]+(?:[._:-][a-z0-9]+)*/g) ?? [],
  );
  const ids = new Set<string>();
  const symbols = new Map<string, string | null>();
  const namedOtherChain =
    /\b(?:on|from|in) (?:the )?(?:solana|ethereum|base|arbitrum|optimism|polygon|bsc|avalanche)\b/i.test(
      text,
    );
  if (names.has("near") || names.has(NATIVE_NEAR)) {
    ids.add(NATIVE_NEAR);
  }
  for (const token of tokens) {
    const near = token.blockchain.toLowerCase() === "near";
    if (
      names.has(token.assetId) ||
      (near &&
        ((token.assetId.startsWith("nep141:") && names.has(token.assetId.slice(7))) ||
          (token.contractAddress && names.has(token.contractAddress))))
    ) {
      ids.add(token.assetId);
    }
    const symbol = tokenSymbol(token);
    if (!namedOtherChain && near && symbol !== "near" && names.has(symbol)) {
      symbols.set(symbol, symbols.has(symbol) ? null : token.assetId);
    }
  }
  for (const id of symbols.values()) {
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

export function namesBudgetToken(token: IntentToken, text: string): boolean {
  return (
    explicitTokenIds([token], text).has(token.assetId) ||
    /\b(?:selected|chosen|allocated) (?:funding |budget )?token\b/i.test(text)
  );
}

/**
 * Whether the user's text names this asset. "NEAR" names native NEAR and also the private route's NEAR asset
 * (`nep141:wrap.near`), the only form in which that route holds NEAR.
 */
export function namesToken(explicit: ReadonlySet<string>, assetId: string): boolean {
  return explicit.has(assetId) || (assetId === "nep141:wrap.near" && explicit.has(NATIVE_NEAR));
}
