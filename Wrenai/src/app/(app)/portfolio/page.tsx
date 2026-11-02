import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountActivity } from "@/components/activity/account-activity";
import { ActivitySkeleton } from "@/components/activity/skeleton";
import { TradingAccessPane } from "@/components/portfolio/access-card";
import { InsightCards } from "@/components/portfolio/insight-cards";
import { PortfolioOverview } from "@/components/portfolio/overview";
import { PortfolioSection } from "@/components/portfolio/panel";
import { AgentPerformanceCard, PnlCalendarCard } from "@/components/portfolio/pnl-cards";
import { RefreshPortfolioButton } from "@/components/portfolio/refresh-button";
import { listAgents } from "@/server/agents/records";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { readPortfolioPerformance } from "@/server/portfolio/performance";
import { readWalletBalance } from "@/server/portfolio/wallet-balance";
import { readTelegramLinkState } from "@/server/telegram/linking";

export const metadata: Metadata = { title: "Portfolio" };

// Docs/DESIGN.md → Screens → Portfolio: an overview (facts left, the trading-access pane right), then titled
// sections of neutral cards. Mint marks only status and actions.
export default async function PortfolioPage() {
  const user = await requireUser();
  const [wallet, agentKey, agents, telegram, performance] = await Promise.all([
    readWalletBalance(user.accountId),
    readDelegatedKey(user),
    listAgents(database(), user.id),
    readTelegramLinkState(database(), user.id),
    readPortfolioPerformance(database(), user.id),
  ]);
  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <h1 className="font-display text-page-title">Portfolio</h1>
        <RefreshPortfolioButton />
      </header>
      {/* One gap token between and inside the columns; the pane stretches to the overview's height. */}
      <div className="grid min-w-0 gap-stack lg:grid-cols-2">
        <PortfolioOverview wallet={wallet} agents={agents} telegram={telegram} performance={performance} />
        <TradingAccessPane accountId={user.accountId} reading={agentKey} />
      </div>
      <PortfolioSection id="insights" title="Insights">
        <InsightCards performance={performance} />
      </PortfolioSection>
      <PortfolioSection id="agents-overview" title="Agents">
        <div className="grid min-w-0 gap-stack xl:grid-cols-3">
          <AgentPerformanceCard agents={agents} performance={performance} />
          <PnlCalendarCard performance={performance} />
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
