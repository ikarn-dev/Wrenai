"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactElement } from "react";
import { TradingAccessFrame } from "@/components/portfolio/access-card";
import { MarketInsights } from "@/components/portfolio/market-insights";
import { MarketTicker } from "@/components/portfolio/market-ticker";
import { PortfolioOverviewLayout } from "@/components/portfolio/overview";
import { PortfolioSection } from "@/components/portfolio/panel";
import { AgentPerformanceCard, PnlCalendarCard } from "@/components/portfolio/pnl-cards";
import { RefreshPortfolioButton } from "@/components/portfolio/refresh-button";
import { NearAmount, WalletValueLayout } from "@/components/portfolio/wallet-cards";
import { Badge } from "@/components/ui/badge";
import type { PortfolioPerformance } from "@/server/portfolio/performance";
import { testnetPortfolioSchema } from "@/shared/agent-performance";
import { formatCompactMicroUsd } from "@/shared/money";
import { testnetAgentTool } from "@/shared/testnet-agents";
import { TestnetActivity } from "./activity";
import { testnetApi } from "./api";
import { useTestnetData } from "./data-provider";
import { TestnetFundsList } from "./funds-list";

export function TestnetPortfolio(): ReactElement | null {
  const { data } = useTestnetData();
  // Marked PnL refreshes every 30 s while the page is open: one dry Tidepool quote per agent with fills.
  const pnl = useQuery({
    queryKey: ["testnet-portfolio-pnl", data?.owner.id ?? null],
    queryFn: async () => testnetPortfolioSchema.parse(await testnetApi(undefined, "?view=portfolio")),
    enabled: data !== undefined,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  if (!data) {
    return null;
  }
  const native = data.balances.find((b) => b.assetId === "native:near");
  // Deleted agents leave the list at once, as on the Agents page; their funds still show in Claims.
  const visible = data.agents.filter((a) => a.state !== "deleted");
  const running = visible.filter((a) => a.state === "running").length;
  const rows = pnl.data?.agents ?? [];
  const performance: PortfolioPerformance = {
    agents: rows.map((row) => ({
      agentId: row.agentId,
      realizedPnlMicroUsd: row.pnlMicroUsd === null ? null : BigInt(row.pnlMicroUsd),
      basisMicroUsd: row.basisMicroUsd === null ? null : BigInt(row.basisMicroUsd),
      count: row.filled ? 1 : 0,
      unpriced: row.filled && row.pnlMicroUsd === null ? 1 : 0,
    })),
    days: [],
    totalMicroUsd: pnl.data?.totalMicroUsd == null ? null : BigInt(pnl.data.totalMicroUsd),
    count: pnl.data?.measuredCount ?? 0,
    unpriced: 0,
  };
  const agents = visible.map((a) => ({
    id: a.id,
    name: a.name,
    pack: testnetAgentTool(a.kind),
    status:
      a.state === "running"
        ? ("running" as const)
        : a.state === "blocked"
          ? ("error" as const)
          : ("stopped" as const),
    returningFunds: false,
  }));
  const total = performance.totalMicroUsd;
  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <h1 className="font-display text-page-title">Portfolio</h1>
        <RefreshPortfolioButton />
      </header>
      <div className="grid min-w-0 gap-stack lg:grid-cols-2">
        <PortfolioOverviewLayout
          wallet={
            <WalletValueLayout
              usd="—"
              near={<NearAmount amount={BigInt(native?.units ?? "0")} compact />}
              detail="Test tokens · no USD valuation"
            />
          }
          agents={`${running} of ${visible.length} running`}
          performance={
            pnl.isPending ? (
              <span className="block h-lh w-24 rounded-xs bg-surface-2 motion-safe:animate-pulse" />
            ) : total !== null ? (
              <span
                title="What each agent's fills are worth now, at Tidepool quotes, minus what it paid"
                className={`font-mono tabular-nums ${total < 0n ? "text-loss" : total > 0n ? "text-gain" : ""}`}
              >
                {total > 0n ? "+" : ""}
                {formatCompactMicroUsd(total)}
              </span>
            ) : performance.count > 0 ? (
              "Quote unavailable"
            ) : (
              "No filled orders"
            )
          }
          claims="Not applicable"
        />
        <TradingAccessFrame
          badge={
            <Badge tone="accent" dot>
              {data.owner.kind === "guest" ? "Guest" : "Wallet approval"}
            </Badge>
          }
          facts={<TestnetFundsList balances={data.balances} />}
          action={
            <Link
              href="/testnet/chat"
              className="inline-flex h-10 items-center justify-center rounded-sm bg-accent px-3 text-body font-medium text-accent-fg"
            >
              Open Jarvis
            </Link>
          }
        />
      </div>
      <PortfolioSection id="insights" title="Insights" aside={<Badge tone="neutral">Mainnet only</Badge>}>
        <div className="flex min-w-0 flex-col gap-stack">
          <MarketTicker />
          <MarketInsights />
        </div>
      </PortfolioSection>
      <PortfolioSection id="agents-overview" title="Agents">
        <div className="grid min-w-0 gap-stack xl:grid-cols-3">
          <AgentPerformanceCard testnet agents={agents} performance={performance} />
          <PnlCalendarCard performance={performance} />
        </div>
      </PortfolioSection>
      <PortfolioSection id="global-activity" title="Global activity">
        <TestnetActivity />
      </PortfolioSection>
    </div>
  );
}
