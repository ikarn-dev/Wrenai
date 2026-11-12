import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { manualTrades } from "@/server/db/manual-schema";
import { connectedBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError } from "@/server/execution/contracts";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { NATIVE_GAS_ASSET } from "@/server/execution/rhea/contracts";
import { manualEnvelope } from "@/server/manual-trading/record";
import { balanceReferenceValue } from "@/server/portfolio/valuation";
import { readWalletWnear } from "@/server/portfolio/wallet-balance";
import { type IntentToken, intentTokens } from "@/server/research/intents";
import type { AgentPerformance } from "@/shared/agent-performance";
import {
  type ClaimAmount,
  type ClaimRecovery,
  type ClaimRow,
  type ClaimsView,
  WNEAR_ASSET_ID,
} from "@/shared/claims";
import { type AgentFunds, readAgentFunds, readFreePrivateBalances } from "./agent-funds";
import { walletPayoutTokens } from "./payout-token";

// The screen answers from the database at once; slow provider reads get this long, then show as unavailable.
const SLOW_READ_MS = 2500;
// Prices must stay under the 120 s reference-price age, so the shared registry copy may be up to a minute old.
const REGISTRY_MAX_AGE_MS = 60_000;
// Common payout tokens first; the rest follow alphabetically.
const PREFERRED = ["wNEAR", "USDC", "USDT"];

function withinTime<T>(read: Promise<T>): Promise<T | null> {
  // The read keeps running past the deadline, so a slow registry download still fills the shared cache.
  return Promise.race([
    read.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SLOW_READ_MS)),
  ]);
}

function describe(assetId: string, tokens: readonly IntentToken[], units: bigint): ClaimAmount {
  if (assetId === NATIVE_GAS_ASSET) {
    return { assetId, symbol: "NEAR", decimals: 24, units: units.toString() };
  }
  if (assetId.startsWith("hyperliquid:usdc:")) {
    return { assetId, symbol: "USDC", decimals: 6, units: units.toString() };
  }
  const token = tokens.find((t) => t.assetId === assetId);
  if (assetId === WNEAR_ASSET_ID) {
    return { assetId, symbol: "wNEAR", decimals: 24, units: units.toString() };
  }
  return token
    ? { assetId, symbol: token.symbol, decimals: token.decimals, units: units.toString() }
    : {
        assetId,
        symbol: assetId.replace(/^nep141:/, "").slice(0, 64),
        decimals: null,
        units: units.toString(),
      };
}

/** Rounded down, like every reference value; null when any token is unpriced or the registry is unavailable. */
function heldValue(
  held: readonly { readonly assetId: string; readonly units: bigint }[],
  tokens: readonly IntentToken[] | null,
  now: number,
): bigint | null {
  let total = 0n;
  for (const lot of held) {
    // Perps venue cash is six-decimal USDC, valued at face value (Spec §10).
    const value = lot.assetId.startsWith("hyperliquid:usdc:")
      ? lot.units
      : tokens === null
        ? null
        : balanceReferenceValue({ assetId: lot.assetId, quantity: lot.units }, tokens, now);
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

function merged(amounts: readonly ClaimAmount[]): ClaimAmount[] {
  const byAsset = new Map<string, ClaimAmount>();
  for (const amount of amounts) {
    const seen = byAsset.get(amount.assetId);
    byAsset.set(
      amount.assetId,
      seen ? { ...seen, units: (BigInt(seen.units) + BigInt(amount.units)).toString() } : amount,
    );
  }
  return [...byAsset.values()];
}

function agentRow(agent: AgentFunds, tokens: readonly IntentToken[] | null, now: number): ClaimRow {
  const known = tokens ?? [];
  const value = agent.openPosition ? null : heldValue(agent.held, tokens, now);
  // PnL needs both sides in USD: a deposit without principal can't be measured, so it stays unavailable.
  const pnl =
    value === null || agent.unvaluedDeposit || agent.heldPrincipalMicroUsd === 0n
      ? null
      : value - agent.heldPrincipalMicroUsd;
  return {
    id: `agent:${agent.id}`,
    source: "agent",
    agent: {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      revision: agent.revision,
      claimingSince: agent.claimingSince,
      deleted: agent.deleted,
      returnAssetId: agent.returnAssetId,
      openPosition: agent.openPosition,
      reason: agent.reason.slice(0, 400),
    },
    deposited: merged(
      agent.deposits.map((lot) => {
        const amount = describe(lot.assetId, known, lot.units);
        return lot.assetId === WNEAR_ASSET_ID && agent.nativeNearDeposit
          ? { ...amount, symbol: "NEAR" }
          : amount;
      }),
    ),
    depositedMicroUsd: agent.unvaluedDeposit ? null : agent.depositedMicroUsd.toString(),
    claimable: merged(agent.held.map((lot) => describe(lot.assetId, known, lot.units))),
    claimableMicroUsd: value === null ? null : value.toString(),
    principalMicroUsd: pnl === null ? null : agent.heldPrincipalMicroUsd.toString(),
    pnlMicroUsd: pnl === null ? null : pnl.toString(),
    observedAt: null,
  };
}

function receiveOptions(tokens: readonly IntentToken[] | null): ClaimsView["receiveOptions"] {
  return walletPayoutTokens(tokens ?? [])
    .map((t) => ({
      assetId: t.assetId,
      symbol: t.assetId === WNEAR_ASSET_ID ? "wNEAR" : t.symbol,
      decimals: t.decimals,
    }))
    .toSorted((a, b) => {
      const rank = (symbol: string) => {
        const index = PREFERRED.indexOf(symbol);
        return index === -1 ? PREFERRED.length : index;
      };
      return rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 400);
}

async function unresolvedManualClaims(db: AppDatabase, userId: string): Promise<ClaimRecovery[]> {
  const records = await db
    .select({ trade: manualTrades, status: executionActions.status })
    .from(manualTrades)
    .innerJoin(
      executionActions,
      and(eq(executionActions.userId, manualTrades.userId), eq(executionActions.id, manualTrades.actionId)),
    )
    .where(
      and(
        eq(manualTrades.userId, userId),
        eq(manualTrades.source, "portfolio"),
        eq(manualTrades.status, "confirmed"),
        inArray(executionActions.status, ["reserved", "submitting", "submitted", "unknown"]),
      ),
    )
    .orderBy(desc(manualTrades.createdAt))
    .limit(20);
  return records.flatMap(({ trade, status }) => {
    const envelope = manualEnvelope(trade);
    if (
      envelope.kind !== "wallet_return" ||
      trade.actionId === null ||
      trade.confirmedAt === null ||
      envelope.preview.input === null
    ) {
      return [];
    }
    const input = envelope.preview.input;
    const row: ClaimRow = {
      id: `private:${input.assetId}`,
      source: "private",
      agent: null,
      deposited: [],
      depositedMicroUsd: null,
      claimable: [
        {
          assetId: input.assetId,
          symbol: input.tokenSymbol,
          decimals: input.decimals,
          units: envelope.preview.inputUnits,
        },
      ],
      claimableMicroUsd: envelope.plan.notionalMicroUsd,
      principalMicroUsd: null,
      pnlMicroUsd: null,
      observedAt: null,
    };
    return [
      {
        id: trade.id,
        row,
        order: { ...envelope.preview, actionId: trade.actionId, status },
        confirmedAt: trade.confirmedAt,
        unwrap: envelope.preview.output?.assetId === WNEAR_ASSET_ID,
      },
    ];
  });
}

/**
 * Every claim for the owner, from the database plus two bounded reads (prices, the wallet's wNEAR). Private
 * balances are the last observed values; `refreshPrivateClaims` updates them and every claim re-reads before it
 * quotes. Unavailable reads are named in `notice`, never shown as zero.
 */
export async function readClaims(
  db: AppDatabase,
  userId: string,
  accountId: string,
  signal: AbortSignal,
): Promise<ClaimsView> {
  const [registry, wallet, funds, free, recoveries] = await Promise.all([
    withinTime(intentTokens(undefined, REGISTRY_MAX_AGE_MS).then((read) => read.tokens)),
    withinTime(readWalletWnear(accountId, signal)),
    readAgentFunds(db, userId),
    readFreePrivateBalances(db, userId),
    unresolvedManualClaims(db, userId),
  ]);
  const now = Date.now(),
    known = registry ?? [],
    activeSources = new Set(recoveries.map((recovery) => recovery.row.id));
  const rows: ClaimRow[] = funds.map((agent) => agentRow(agent, registry, now));
  for (const balance of free) {
    if (activeSources.has(`private:${balance.assetId}`)) {
      continue;
    }
    const value = heldValue([balance], registry, now);
    rows.push({
      id: `private:${balance.assetId}`,
      source: "private",
      agent: null,
      deposited: [],
      depositedMicroUsd: null,
      claimable: [describe(balance.assetId, known, balance.units)],
      claimableMicroUsd: value === null ? null : value.toString(),
      principalMicroUsd: null,
      pnlMicroUsd: null,
      observedAt: balance.observedAt,
    });
  }
  if (wallet !== null && wallet !== "0") {
    const value = heldValue([{ assetId: WNEAR_ASSET_ID, units: BigInt(wallet) }], registry, now);
    rows.push({
      id: "wallet:wnear",
      source: "wallet",
      agent: null,
      deposited: [],
      depositedMicroUsd: null,
      claimable: [describe(WNEAR_ASSET_ID, known, BigInt(wallet))],
      claimableMicroUsd: value === null ? null : value.toString(),
      principalMicroUsd: null,
      pnlMicroUsd: null,
      observedAt: null,
    });
  }
  return {
    rows: rows.slice(0, 100),
    recoveries,
    receiveOptions: receiveOptions(registry),
    notice:
      registry === null
        ? "Prices are still loading. Values fill in on the next refresh."
        : wallet === null
          ? "Your wallet's wNEAR could not be checked."
          : null,
  };
}

function unmeasured(agent: AgentFunds | undefined, registry: readonly IntentToken[] | null): string | null {
  if (!agent || agent.held.length === 0) {
    return "This agent holds no funds.";
  }
  if (agent.openPosition) {
    return "An open Perps position is valued on the venue; its result shows once it closes.";
  }
  if (agent.unvaluedDeposit || agent.heldPrincipalMicroUsd === 0n) {
    return "A deposit has no recorded USD value, so its result can't be measured.";
  }
  return registry === null ? "Prices are still loading. Values fill in on the next refresh." : null;
}

/**
 * One agent's result for its page: what it holds at reference prices minus the principal still attributed to it,
 * the same figures Claims shows. Owner-scoped through the lots query; another owner's agent reads as holding nothing.
 */
export async function readAgentPerformance(
  db: AppDatabase,
  userId: string,
  agentId: string,
): Promise<AgentPerformance> {
  const [registry, funds] = await Promise.all([
    withinTime(intentTokens(undefined, REGISTRY_MAX_AGE_MS).then((read) => read.tokens)),
    readAgentFunds(db, userId, agentId),
  ]);
  const now = Date.now(),
    agent = funds[0],
    row = agent ? agentRow(agent, registry, now) : null,
    note = unmeasured(agent, registry);
  return {
    unit: { kind: "usd" },
    invested: agent && note === null ? agent.heldPrincipalMicroUsd.toString() : null,
    value: row?.claimableMicroUsd ?? null,
    pnl: row?.pnlMicroUsd ?? null,
    source: "reference_prices",
    observedAt: now,
    note,
  };
}

/**
 * Re-reads the private balance with the stored balance session. A display refresh never signs in with the
 * trading key; without a live session it reports that nothing was refreshed.
 */
export async function refreshPrivateClaims(db: AppDatabase, userId: string): Promise<{ refreshed: boolean }> {
  if ((await connectedBalanceToken(db, userId)) === null) {
    return { refreshed: false };
  }
  try {
    await synchronizePrivateInventory(db, userId);
    return { refreshed: true };
  } catch (error) {
    // Another refresh or an order holds the inventory lease; the next refresh reads it.
    if (error instanceof ExecutionError && error.code === "conflict") {
      return { refreshed: false };
    }
    throw error;
  }
}
