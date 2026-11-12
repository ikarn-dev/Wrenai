import { BrainCircuit, ChartNoAxesCombined, HandCoins, ShieldCheck, Wallet } from "lucide-react";
import { type ReactElement, type ReactNode, Suspense } from "react";
import { PendingClaimsValue } from "@/components/claims/pending-claims-value";
import type { PortfolioPerformance } from "@/server/portfolio/performance";
import type { AgentSummary } from "@/shared/agents";
import { formatCompactMicroUsd } from "@/shared/money";
import { StatTile } from "./panel";
import { WalletValue } from "./wallet-cards";

interface PortfolioOverviewProps {
  readonly agents: Promise<readonly AgentSummary[]>;
  readonly performance: Promise<PortfolioPerformance>;
}

function Quiet({ children }: { readonly children: string }): ReactElement {
  return <span className="text-fg-muted">{children}</span>;
}

function agentCount(agents: readonly AgentSummary[]): string {
  if (agents.length === 0) {
    return "No agents yet";
  }
  const running = agents.filter((agent) => agent.status === "running").length;
  return `${running} of ${agents.length} running`;
}

/** Exactly one line of the tile's value text tall (`h-lh`), so the tile keeps its height when the value arrives. */
function TileLoading(): ReactElement {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="block h-lh w-24 rounded-xs bg-surface-2 motion-safe:animate-pulse"
    />
  );
}

async function AgentsValue({
  data,
}: {
  readonly data: PortfolioOverviewProps["agents"];
}): Promise<ReactElement> {
  return <>{agentCount(await data)}</>;
}

async function PerformanceValue({
  data,
}: {
  readonly data: PortfolioOverviewProps["performance"];
}): Promise<ReactElement> {
  const performance = await data;
  return performance.totalMicroUsd !== null ? (
    <span className="font-mono tabular-nums">{formatCompactMicroUsd(performance.totalMicroUsd)}</span>
  ) : (
    <Quiet>{performance.count ? "Incomplete cost data" : "No recorded fills"}</Quiet>
  );
}

/**
 * Wallet and agent facts. Different token budgets cannot be added into a fictional shared USD balance.
 */
export function PortfolioOverviewLayout({
  wallet,
  agents,
  performance,
  claims,
}: {
  readonly wallet: ReactNode;
  readonly agents: ReactNode;
  readonly performance: ReactNode;
  readonly claims: ReactNode;
}): ReactElement {
  return (
    <div className="grid gap-stack sm:grid-cols-2">
      <div className="grid sm:col-span-2">
        <StatTile icon={Wallet} label="NEAR wallet">
          {wallet}
        </StatTile>
      </div>
      <StatTile icon={BrainCircuit} label="Agents">
        {agents}
      </StatTile>
      <StatTile icon={ChartNoAxesCombined} label="Realized PnL">
        {performance}
      </StatTile>
      <StatTile icon={ShieldCheck} label="Budgets">
        Per agent
      </StatTile>
      <StatTile icon={HandCoins} label="Pending claims">
        {claims}
      </StatTile>
    </div>
  );
}
export function PortfolioOverview({ agents, performance }: PortfolioOverviewProps): ReactElement {
  return (
    <PortfolioOverviewLayout
      wallet={<WalletValue />}
      agents={
        <Suspense fallback={<TileLoading />}>
          <AgentsValue data={agents} />
        </Suspense>
      }
      performance={
        <Suspense fallback={<TileLoading />}>
          <PerformanceValue data={performance} />
        </Suspense>
      }
      claims={<PendingClaimsValue />}
    />
  );
}
