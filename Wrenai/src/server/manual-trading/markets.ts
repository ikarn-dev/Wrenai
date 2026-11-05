import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { executionInventory } from "@/server/db/execution-schema";
import { manualTrades } from "@/server/db/manual-schema";
import { registryTradeAsset } from "@/server/execution/asset-review";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { readHlAccount, synchronizePerpsInventory } from "@/server/execution/hyperliquid/account-state";
import { hlDecimalSchema, hlSignedDecimalSchema } from "@/server/execution/hyperliquid/contracts";
import { hlMarketSchema } from "@/server/execution/hyperliquid/market";
import { hlInfo } from "@/server/execution/hyperliquid/transport";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { databaseTime } from "@/server/execution/records";
import { decimal, plainDecimal, product, ratio, subtract } from "@/server/research/decimal";
import { intentTokens } from "@/server/research/intents";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import type { ManualBalance } from "@/shared/manual-trading";
import type {
  ManualAccountView,
  PerpsMarketRow,
  SpotMarketToken,
  SpotMarketView,
  SpotMetricsView,
} from "@/shared/market-pages";
import { manualAvailableUnits } from "./balances";
import { displaySnapshot } from "./display-snapshot";
import { readManualPreview } from "./service";
import { manualSubject } from "./subject";
import { tokenMetrics } from "./token-metrics";

export const spotMarketCatalog = displaySnapshot(15_000, async (): Promise<SpotMarketView> => {
  const tokens = (await intentTokens()).tokens.filter((t) => /^nep141:[a-z0-9._-]+$/.test(t.assetId));
  const seen = new Set<string>();
  const rows = tokens.flatMap((t): SpotMarketToken[] => {
    if (seen.has(t.assetId)) {
      return [];
    }
    seen.add(t.assetId);
    const updated = t.priceUpdatedAt ? Date.parse(t.priceUpdatedAt) : Number.NaN;
    return [
      {
        ...registryTradeAsset(t),
        ...(t.coingeckoId ? { coinId: t.coingeckoId } : {}),
        price: t.price ?? null,
        priceUpdatedAt: Number.isFinite(updated) ? updated : null,
        metrics: null,
      },
    ];
  });
  return { tokens: rows.slice(0, 1000), metricsNotice: null };
});

async function metricsFor(tokens: readonly SpotMarketToken[]) {
  return tokenMetrics(tokens.flatMap((token) => (token.coinId ? [token.coinId] : [])));
}

export async function spotMarketMetrics(): Promise<SpotMetricsView> {
  const catalog = await spotMarketCatalog();
  const snapshot = await metricsFor(catalog.tokens);
  return { metrics: [...snapshot.byId.values()], notice: snapshot.notice };
}

export async function spotMarketView(): Promise<SpotMarketView> {
  const catalog = await spotMarketCatalog();
  const snapshot = await metricsFor(catalog.tokens);
  return {
    tokens: catalog.tokens.map((token) => ({
      ...token,
      metrics: token.coinId ? (snapshot.byId.get(token.coinId) ?? null) : null,
    })),
    metricsNotice: snapshot.notice,
  };
}
export const perpsMarketRows = displaySnapshot(5_000, async (): Promise<readonly PerpsMarketRow[]> => {
  const [meta, contexts] = z
    .tuple([
      z.object({ universe: z.array(hlMarketSchema).max(2000) }),
      z
        .array(
          z.object({
            markPx: hlDecimalSchema,
            funding: hlSignedDecimalSchema,
            prevDayPx: hlDecimalSchema,
            dayNtlVlm: hlDecimalSchema,
            openInterest: hlDecimalSchema,
          }),
        )
        .max(2000),
    ])
    .parse(await hlInfo({ type: "metaAndAssetCtxs" }));
  return meta.universe.flatMap((m, index) => {
    const c = contexts[index];
    if (!c || m.isDelisted) {
      return [];
    }
    const mark = decimal(c.markPx),
      previous = decimal(c.prevDayPx);
    return [
      {
        name: m.name,
        mark: c.markPx,
        funding: c.funding,
        maxLeverage: m.maxLeverage,
        sizeDecimals: m.szDecimals,
        // Display figures (whole USD, percent to two places); orders never read them.
        change24h:
          previous.n === 0n
            ? null
            : plainDecimal(product(ratio(subtract(mark, previous), previous), { n: 100n, d: 1n }), 2),
        volume24h: plainDecimal(decimal(c.dayNtlVlm), 0),
        openInterest: plainDecimal(product(decimal(c.openInterest), mark), 0),
      },
    ];
  });
});
export async function manualAccountView(db: AppDatabase, userId: string): Promise<ManualAccountView> {
  const subjectId = await manualSubject(db, userId),
    root = await activeTradingAccount(db, userId),
    perps = await readAgentTradingAccount(db, userId, subjectId);
  const session = await privateBalanceToken(db, userId);
  const refreshed = await Promise.allSettled([
    session ? synchronizePrivateInventory(db, userId) : Promise.resolve(),
    perps ? synchronizePerpsInventory(db, userId, subjectId) : Promise.resolve(),
  ]);
  const now = await databaseTime(db),
    rows = await db.select().from(executionInventory).where(eq(executionInventory.userId, userId));
  const balances: ManualBalance[] = [];
  for (const row of rows) {
    if (
      row.scope === "intents" ||
      row.observedAt === null ||
      now - row.observedAt > 15000 ||
      row.assetId === "native:near"
    ) {
      continue;
    }
    balances.push({
      assetId: row.assetId,
      units: row.balanceUnits.toString(),
      availableUnits: (
        await manualAvailableUnits(db, userId, subjectId, row.scope, row.assetId, now)
      ).toString(),
      scope: row.scope,
    });
  }
  const recent = await db
    .select({ id: manualTrades.id })
    .from(manualTrades)
    .where(eq(manualTrades.userId, userId))
    .orderBy(desc(manualTrades.createdAt))
    .limit(12);
  const positions = await db
    .select()
    .from(defiPositions)
    .where(
      and(
        eq(defiPositions.userId, userId),
        eq(defiPositions.agentId, subjectId),
        gt(defiPositions.quantityUnits, 0n),
      ),
    );
  const venue = perps ? await readHlAccount(perps.perpAddress) : null;
  const markets = positions.some((p) => p.kind === "perp_long" || p.kind === "perp_short")
    ? await perpsMarketRows()
    : [];
  return {
    nativeAccountId: root?.nativeAccountId ?? null,
    perpsAddress: perps?.perpAddress ?? null,
    recoveryReady:
      root?.backupConfirmedAt !== null && root?.backupConfirmedAt !== undefined && root.backupVersion >= 2,
    balances,
    balanceNotice: refreshed.some((r) => r.status === "rejected")
      ? "Some balances could not be refreshed. Confirmation always checks again."
      : session
        ? null
        : "Connect your private balance in Trading access to use NEAR Intents.",
    positions: positions.flatMap((p) => {
      if (p.kind !== "perp_long" && p.kind !== "perp_short") {
        return [];
      }
      const match = venue?.assetPositions.find((v) => p.instrumentId.endsWith(`:${v.position.coin}`)),
        market = match ? markets.find((m) => m.name === match.position.coin) : null;
      return market
        ? [
            {
              market: market.name,
              side: p.kind === "perp_long" ? ("long" as const) : ("short" as const),
              quantity: p.quantityUnits.toString(),
              decimals: market.sizeDecimals,
            },
          ]
        : [];
    }),
    orders: await Promise.all(recent.map((r) => readManualPreview(db, userId, r.id))),
  };
}
