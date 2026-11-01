import { ChartNoAxesCombined, Wallet, Waypoints } from "lucide-react";
import type { ReactElement } from "react";
import type { WalletBalanceReading } from "@/server/portfolio/wallet-balance";
import type { AgentSummary } from "@/shared/agents";
import { StatTile } from "./panel";
import { NearAmount, ReadTime } from "./wallet-cards";

interface PortfolioOverviewProps {
  readonly wallet: WalletBalanceReading;
  readonly agents: readonly AgentSummary[];
}

function agentCount(agents: readonly AgentSummary[]): string {
  if (agents.length === 0) {
    return "No agents yet";
  }
  const running = agents.filter((agent) => agent.status === "running").length;
  return `${running} of ${agents.length} running`;
}

/**
 * The three facts a user checks first: what's in the wallet, what the agents are doing, and how they've done.
 * Trading access lives in the pane beside this, so it isn't repeated. The grid stretches to the pane's height.
 */
export function PortfolioOverview({ wallet, agents }: PortfolioOverviewProps): ReactElement {
  return (
    <div className="grid content-start gap-stack sm:grid-cols-2">
      <div className="sm:col-span-2">
        <StatTile icon={Wallet} label="NEAR wallet" meta={<ReadTime reading={wallet} />}>
          {wallet.kind === "unavailable" ? (
            <span className="text-fg-muted">Unavailable</span>
          ) : (
            <NearAmount amount={wallet.kind === "balance" ? wallet.yocto : 0n} large />
          )}
        </StatTile>
      </div>
      <StatTile icon={Waypoints} label="Agents" meta="Each agent has its own budget">
        {agentCount(agents)}
      </StatTile>
      <StatTile icon={ChartNoAxesCombined} label="Net PnL" meta="From recorded fills">
        <span className="text-fg-muted">No trades yet</span>
      </StatTile>
    </div>
  );
}
