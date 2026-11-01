import type { Metadata } from "next";
import { TradingAccessPane } from "@/components/portfolio/access-card";
import { InsightCards } from "@/components/portfolio/insight-cards";
import { PortfolioOverview } from "@/components/portfolio/overview";
import { PortfolioSection } from "@/components/portfolio/panel";
import { AgentPerformanceCard, PnlCalendarCard } from "@/components/portfolio/pnl-cards";
import { RefreshPortfolioButton } from "@/components/portfolio/refresh-button";
import { AssetsCard } from "@/components/portfolio/wallet-cards";
import { listAgents } from "@/server/agents/records";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { readWalletBalance } from "@/server/portfolio/wallet-balance";

export const metadata: Metadata = { title: "Portfolio" };

// Docs/DESIGN.md → Screens → Portfolio: an overview (facts left, the trading-access pane right), then titled
// sections of neutral cards. Mint marks only status and actions.
export default async function PortfolioPage() {
  const user = await requireUser();
  const [wallet, agentKey, agents] = await Promise.all([
    readWalletBalance(user.accountId),
    readDelegatedKey(user),
    listAgents(database(), user.id),
  ]);
  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-h1">Portfolio</h1>
          <p className="text-small text-fg-muted">Balances, agents and trading access</p>
        </div>
        <RefreshPortfolioButton />
      </header>
      <div className="grid min-w-0 gap-8 lg:grid-cols-2">
        <PortfolioOverview wallet={wallet} agentKey={agentKey} agents={agents} />
        <TradingAccessPane accountId={user.accountId} reading={agentKey} />
      </div>
      <PortfolioSection id="insights" title="Insights">
        <InsightCards />
      </PortfolioSection>
      <PortfolioSection id="agents-overview" title="Agents">
        <div className="grid min-w-0 gap-stack xl:grid-cols-3">
          <AgentPerformanceCard agents={agents} />
          <PnlCalendarCard />
        </div>
      </PortfolioSection>
      <PortfolioSection id="holdings" title="Holdings">
        <AssetsCard reading={wallet} />
      </PortfolioSection>
    </div>
  );
}
