import {
  defaultShouldDehydrateQuery,
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";
import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountActivity } from "@/components/activity/account-activity";
import { ActivitySkeleton } from "@/components/activity/skeleton";
import { TradingAccessPane, TradingAccessSkeleton } from "@/components/portfolio/access-card";
import { MarketInsights } from "@/components/portfolio/market-insights";
import { MarketTicker } from "@/components/portfolio/market-ticker";
import { PortfolioOverview } from "@/components/portfolio/overview";
import { PortfolioSection } from "@/components/portfolio/panel";
import { AgentPerformanceCard, PnlCalendarCard } from "@/components/portfolio/pnl-cards";
import { RefreshPortfolioButton } from "@/components/portfolio/refresh-button";
import { listAgents } from "@/server/agents/records";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { readPortfolioPerformance } from "@/server/portfolio/performance";
import { readWalletValueView } from "@/server/portfolio/valuation";
import { readWalletBalanceView } from "@/server/portfolio/wallet-balance";
import { readTelegramLinkState } from "@/server/telegram/linking";
import { PORTFOLIO_WALLET_BALANCE_KEY, PORTFOLIO_WALLET_VALUE_KEY } from "@/shared/portfolio-wallet";

export const metadata: Metadata = { title: "Portfolio" };

async function Access({
  accountId,
  keyReading,
}: {
  readonly accountId: string;
  readonly keyReading: ReturnType<typeof readDelegatedKey>;
}) {
  return <TradingAccessPane accountId={accountId} reading={await keyReading} />;
}

async function AgentResults({
  agents,
  performance,
}: {
  readonly agents: ReturnType<typeof listAgents>;
  readonly performance: ReturnType<typeof readPortfolioPerformance>;
}) {
  const [list, report] = await Promise.all([agents, performance]);
  return (
    <>
      <AgentPerformanceCard agents={list} performance={report} />
      <PnlCalendarCard performance={report} />
    </>
  );
}

const PANEL_PLACEHOLDER = "min-h-72 card-shine rounded-lg motion-safe:animate-pulse";

function prefetchWallet(accountId: string) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  void cache.prefetchQuery({
    queryKey: PORTFOLIO_WALLET_BALANCE_KEY,
    queryFn: ({ signal }) => readWalletBalanceView(accountId, signal),
  });
  void cache.prefetchQuery({
    queryKey: PORTFOLIO_WALLET_VALUE_KEY,
    queryFn: ({ signal }) => readWalletValueView(accountId, signal),
  });
  // Stream each result into the browser cache without waiting to render the dashboard shell.
  return dehydrate(cache, {
    shouldDehydrateQuery: (query) => defaultShouldDehydrateQuery(query) || query.state.status === "pending",
  });
}

// Docs/DESIGN.md → Screens → Portfolio: an overview (facts left, the trading-access pane right), then titled
// sections of neutral cards. Mint marks only status and actions.
export default async function PortfolioPage() {
  const user = await requireUser();
  const wallet = prefetchWallet(user.accountId);
  const db = database();
  const agentKey = readDelegatedKey(user);
  const agents = listAgents(db, user.id);
  const telegram = readTelegramLinkState(db, user.id);
  const performance = readPortfolioPerformance(db, user.id);
  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <h1 className="font-display text-page-title">Portfolio</h1>
        <RefreshPortfolioButton />
      </header>
      {/* One gap token between and inside the columns; the pane stretches to the overview's height. */}
      <div className="grid min-w-0 gap-stack lg:grid-cols-2">
        <HydrationBoundary state={wallet}>
          <PortfolioOverview agents={agents} telegram={telegram} performance={performance} />
        </HydrationBoundary>
        <Suspense fallback={<TradingAccessSkeleton />}>
          <Access accountId={user.accountId} keyReading={agentKey} />
        </Suspense>
      </div>
      {/* The ticker opens the market section it belongs to, above the cards that detail it. */}
      <PortfolioSection id="insights" title="Insights">
        <div className="flex min-w-0 flex-col gap-stack">
          <MarketTicker />
          <MarketInsights />
        </div>
      </PortfolioSection>
      <PortfolioSection id="agents-overview" title="Agents">
        <div className="grid min-w-0 gap-stack xl:grid-cols-3">
          <Suspense
            fallback={
              <>
                <div
                  role="status"
                  aria-label="Loading agent performance"
                  className={`${PANEL_PLACEHOLDER} xl:col-span-2`}
                />
                <div aria-hidden="true" className={PANEL_PLACEHOLDER} />
              </>
            }
          >
            <AgentResults agents={agents} performance={performance} />
          </Suspense>
        </div>
      </PortfolioSection>
      <PortfolioSection id="global-activity" title="Global activity">
        <Suspense fallback={<ActivitySkeleton />}>
          <AccountActivity ownerId={user.id} />
        </Suspense>
      </PortfolioSection>
    </div>
  );
}
