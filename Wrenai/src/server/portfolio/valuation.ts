import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { walletFundings } from "@/server/db/funding-schema";
import { agentTradingAccounts, tradingAccounts } from "@/server/db/trading-account-schema";
import { connectedBalanceToken } from "@/server/execution/balance-session";
import { readHlAccount } from "@/server/execution/hyperliquid/account-state";
import { hlUnits } from "@/server/execution/hyperliquid/decimal";
import { readPrivateBalances } from "@/server/execution/private-inventory";
import { decimal } from "@/server/research/decimal";
import { type IntentToken, intentTokens } from "@/server/research/intents";
import type { WalletValueView } from "@/shared/portfolio-wallet";
import { readPublicIntentsInventory } from "./public-intents";
import { WALLET_SCAN_TIMEOUT_MS, walletTokenHoldings } from "./wallet-tokens";

export interface PortfolioLocationValue {
  readonly id: string;
  readonly label: string;
  readonly knownMicroUsd: bigint;
  readonly complete: boolean;
  readonly note: string;
  readonly balances: number;
  /** The tokens behind the value. Venue equity (Perps) has none: it is valued as one USD figure. */
  readonly holdings: readonly PortfolioHolding[];
}
/** One token at one location, as read; value is null when no fresh exact price exists. */
export interface PortfolioHolding {
  readonly assetId: string;
  readonly symbol: string;
  readonly quantity: bigint;
  readonly decimals: number | null;
  readonly valueMicroUsd: bigint | null;
}
export interface PortfolioValuation {
  readonly locations: readonly PortfolioLocationValue[];
  readonly knownMicroUsd: bigint;
  readonly totalMicroUsd: bigint | null;
  readonly settling: boolean;
  readonly observedAt: number;
}
interface Balance {
  readonly assetId: string;
  readonly quantity: bigint;
  readonly decimals?: number;
  readonly symbol?: string;
}

function holdingFor(
  balance: Balance,
  tokens: readonly IntentToken[],
  value: bigint | null,
): PortfolioHolding {
  const registryId = balance.assetId === "native:near" ? "nep141:wrap.near" : balance.assetId;
  const matches = tokens.filter((token) => token.assetId === registryId);
  const token = matches.length === 1 ? matches[0] : undefined;
  return {
    assetId: balance.assetId,
    symbol: balance.assetId === "native:near" ? "NEAR" : (balance.symbol ?? token?.symbol ?? balance.assetId),
    quantity: balance.quantity,
    decimals: balance.decimals ?? token?.decimals ?? null,
    valueMicroUsd: value,
  };
}

/** Registry prices are display estimates only. Exact identity, matching precision and a dated price are mandatory. */
export function balanceReferenceValue(
  balance: Balance,
  tokens: readonly IntentToken[],
  now: number,
): bigint | null {
  if (balance.quantity < 0n) {
    return null;
  }
  if (balance.quantity === 0n) {
    return 0n;
  }
  const assetId = balance.assetId === "native:near" ? "nep141:wrap.near" : balance.assetId;
  const matches = tokens.filter((token) => token.assetId === assetId),
    token = matches[0];
  if (
    matches.length !== 1 ||
    !token?.price ||
    !token.priceUpdatedAt ||
    (balance.decimals !== undefined && balance.decimals !== token.decimals) ||
    (balance.assetId === "native:near" && (token.blockchain !== "near" || token.decimals !== 24))
  ) {
    return null;
  }
  const at = Date.parse(token.priceUpdatedAt);
  if (!Number.isFinite(at) || at > now + 1000 || now - at >= 120_000) {
    return null;
  }
  try {
    const price = decimal(token.price);
    if (price.n <= 0n) {
      return null;
    }
    return (balance.quantity * price.n * 1_000_000n) / (price.d * 10n ** BigInt(token.decimals));
  } catch {
    return null;
  }
}
function valuedLocation(
  id: string,
  label: string,
  balances: readonly Balance[],
  tokens: readonly IntentToken[],
  complete: boolean,
  note: string,
): PortfolioLocationValue {
  let knownMicroUsd = 0n,
    priced = true;
  const holdings: PortfolioHolding[] = [];
  for (const balance of balances) {
    const value = balanceReferenceValue(balance, tokens, Date.now());
    if (value === null) {
      priced = false;
    } else {
      knownMicroUsd += value;
    }
    if (balance.quantity > 0n) {
      holdings.push(holdingFor(balance, tokens, value));
    }
  }
  return {
    id,
    label,
    knownMicroUsd,
    complete: complete && priced,
    balances: balances.length,
    note: !priced ? "Some token prices are unavailable or stale" : note,
    holdings,
  };
}
function unavailable(id: string, label: string, note: string): PortfolioLocationValue {
  return { id, label, knownMicroUsd: 0n, complete: false, note, balances: 0, holdings: [] };
}
async function walletValue(
  account: string,
  id: string,
  label: string,
  tokens: readonly IntentToken[],
): Promise<PortfolioLocationValue> {
  const holdings = await walletTokenHoldings(account);
  return valueWalletHoldings(id, label, holdings, tokens);
}

function valueWalletHoldings(
  id: string,
  label: string,
  holdings: Awaited<ReturnType<typeof walletTokenHoldings>>,
  tokens: readonly IntentToken[],
): PortfolioLocationValue {
  return valuedLocation(
    id,
    label,
    holdings.tokens.map((token) => ({
      assetId: token.assetId,
      quantity: BigInt(token.balanceUnits),
      decimals: token.decimals,
      symbol: token.symbol,
    })),
    tokens,
    holdings.complete,
    holdings.complete ? "Finalized balances; reference prices" : "Token discovery is incomplete",
  );
}

/** The wallet tile depends only on finalized wallet balances and display reference prices. */
export async function readConnectedWalletValue(
  accountId: string,
  signal: AbortSignal,
): Promise<PortfolioLocationValue> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(WALLET_SCAN_TIMEOUT_MS)]);
  const [holdings, registry] = await Promise.all([
    walletTokenHoldings(accountId, [], deadline),
    intentTokens(deadline).catch(() => null),
  ]);
  return valueWalletHoldings("wallet", "NEAR wallet", holdings, registry?.tokens ?? []);
}

export async function readWalletValueView(accountId: string, signal: AbortSignal): Promise<WalletValueView> {
  const value = await readConnectedWalletValue(accountId, signal);
  return {
    knownMicroUsd: value.knownMicroUsd.toString(),
    complete: value.complete,
    otherTokens: value.holdings.filter((holding) => holding.assetId !== "native:near").length,
  };
}

async function privateValue(
  db: AppDatabase,
  userId: string,
  tokens: readonly IntentToken[],
): Promise<PortfolioLocationValue> {
  const token = await connectedBalanceToken(db, userId);
  if (!token) {
    return unavailable("private", "Private balance", "Connect the private balance to include it");
  }
  const rows = await readPrivateBalances(token);
  return valuedLocation(
    "private",
    "Private balance",
    rows.map((row) => ({ assetId: row.tokenId, quantity: BigInt(row.available) })),
    tokens,
    true,
    "Provider balances; reference prices",
  );
}
async function trackedIntentsValue(
  _db: AppDatabase,
  user: SessionUser,
  tokens: readonly IntentToken[],
): Promise<PortfolioLocationValue> {
  const inventory = await readPublicIntentsInventory(user.accountId);
  return valuedLocation(
    "intents",
    "Public Intents",
    inventory.balances,
    tokens,
    inventory.complete,
    inventory.complete
      ? "Finalized complete token inventory; reference prices"
      : "Public token inventory exceeds the supported page limit",
  );
}
async function perpsValue(db: AppDatabase, userId: string): Promise<PortfolioLocationValue> {
  const accounts = await db
    .select({ address: agentTradingAccounts.perpAddress })
    .from(agentTradingAccounts)
    .where(eq(agentTradingAccounts.userId, userId))
    .limit(33);
  let knownMicroUsd = 0n,
    complete = accounts.length <= 32;
  for (let offset = 0; offset < Math.min(accounts.length, 32); offset += 4) {
    const values = await Promise.allSettled(
      accounts.slice(offset, Math.min(32, offset + 4)).map((account) => readHlAccount(account.address)),
    );
    for (const value of values) {
      if (value.status === "rejected") {
        complete = false;
      }
      // accountValue already includes isolated collateral and unrealized PnL. Never add its positions again.
      else {
        knownMicroUsd += hlUnits(value.value.marginSummary.accountValue, 6, "down");
      }
    }
  }
  return {
    id: "perps",
    label: "Perps accounts",
    knownMicroUsd,
    complete,
    balances: accounts.length,
    note: complete ? "Venue equity includes unrealized PnL" : "Some venue accounts could not be valued",
    holdings: [],
  };
}
async function nativeTradingValue(
  db: AppDatabase,
  userId: string,
  tokens: readonly IntentToken[],
): Promise<PortfolioLocationValue> {
  const accounts = await db
    .select({ address: tradingAccounts.nativeAccountId })
    .from(tradingAccounts)
    .where(eq(tradingAccounts.userId, userId))
    .limit(9);
  const values = await Promise.allSettled(
    accounts.slice(0, 8).map((account) => walletValue(account.address, "native", "Trading wallets", tokens)),
  );
  return {
    id: "native",
    label: "Trading wallets",
    knownMicroUsd: values.reduce(
      (sum, value) => sum + (value.status === "fulfilled" ? value.value.knownMicroUsd : 0n),
      0n,
    ),
    complete:
      accounts.length <= 8 && values.every((value) => value.status === "fulfilled" && value.value.complete),
    balances: accounts.length,
    note: "Dedicated wallets only; allocated funds are not added twice",
    holdings: values.flatMap((value) => (value.status === "fulfilled" ? value.value.holdings : [])),
  };
}

/** Owner-scoped display reads. No inventory sync, budget mutation, key decryption or signing. */
export async function readPortfolioValuation(
  db: AppDatabase,
  user: SessionUser,
): Promise<PortfolioValuation> {
  const [registry, pending, funding] = await Promise.allSettled([
    intentTokens(),
    db
      .select({ id: executionActions.id })
      .from(executionActions)
      .where(and(eq(executionActions.userId, user.id), isNull(executionActions.reservationReleasedAt)))
      .limit(1),
    db
      .select({ id: walletFundings.id })
      .from(walletFundings)
      .where(
        and(
          eq(walletFundings.userId, user.id),
          ne(walletFundings.state, "prepared"),
          ne(walletFundings.state, "complete"),
          ne(walletFundings.state, "abandoned"),
        ),
      )
      .limit(1),
  ]);
  const tokens = registry.status === "fulfilled" ? registry.value.tokens : [];
  const specs = [
    { id: "wallet", label: "NEAR wallet" },
    { id: "private", label: "Private balance" },
    { id: "intents", label: "Public Intents" },
    { id: "native", label: "Trading wallets" },
    { id: "perps", label: "Perps accounts" },
  ];
  const values = await Promise.allSettled([
    walletValue(user.accountId, "wallet", "NEAR wallet", tokens),
    privateValue(db, user.id, tokens),
    trackedIntentsValue(db, user, tokens),
    nativeTradingValue(db, user.id, tokens),
    perpsValue(db, user.id),
  ]);
  const locations = specs.map((spec, index) => {
    const value = values[index];
    return value?.status === "fulfilled"
      ? value.value
      : unavailable(spec.id, spec.label, "Balance data is unavailable");
  });
  const knownMicroUsd = locations.reduce((sum, location) => sum + location.knownMicroUsd, 0n),
    settling =
      pending.status !== "fulfilled" ||
      pending.value.length > 0 ||
      funding.status !== "fulfilled" ||
      funding.value.length > 0;
  return {
    locations,
    knownMicroUsd,
    totalMicroUsd: !settling && locations.every((location) => location.complete) ? knownMicroUsd : null,
    settling,
    observedAt: Date.now(),
  };
}
