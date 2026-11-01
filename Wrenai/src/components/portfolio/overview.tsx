import { ChartNoAxesCombined, Globe, KeyRound, Lock, Wallet, Waypoints } from "lucide-react";
import type { ReactElement } from "react";
import type { DelegatedKeyReading } from "@/server/delegation/delegated-key";
import type { WalletBalanceReading } from "@/server/portfolio/wallet-balance";
import type { AgentSummary } from "@/shared/agents";
import { KEY_STATUS } from "./access-card";
import { StatTile } from "./panel";
import { NearAmount, ReadTime } from "./wallet-cards";

interface PortfolioOverviewProps {
  readonly wallet: WalletBalanceReading;
  readonly agentKey: DelegatedKeyReading;
  readonly agents: readonly AgentSummary[];
}

function Unavailable({ label }: { readonly label: string }): ReactElement {
  return <span className="text-fg-muted">{label}</span>;
}

function agentCount(agents: readonly AgentSummary[]): string {
  if (agents.length === 0) {
    return "No agents yet";
  }
  const running = agents.filter((agent) => agent.status === "running").length;
  return `${running} of ${agents.length} running`;
}

/**
 * Six facts in a two-column grid: where the money is, whether agents can trade, and how they're doing. Values
 * that aren't measured yet say so instead of showing a number.
 */
export function PortfolioOverview({ wallet, agentKey, agents }: PortfolioOverviewProps): ReactElement {
  const key = KEY_STATUS[agentKey.state.kind];
  return (
    <div className="grid gap-stack sm:grid-cols-2">
      <StatTile icon={Wallet} label="NEAR wallet" meta={<ReadTime reading={wallet} />}>
        {wallet.kind === "unavailable" ? (
          <Unavailable label="Unavailable" />
        ) : (
          <NearAmount amount={wallet.kind === "balance" ? wallet.yocto : 0n} compact />
        )}
      </StatTile>
      <StatTile
        icon={KeyRound}
        label="Trading access"
        meta={agentKey.checked ? "On intents.near" : "Not verified"}
      >
        {key.label}
      </StatTile>
      <StatTile icon={Globe} label="Public Intents" meta="Shown once balances sync">
        <Unavailable label="Not available yet" />
      </StatTile>
      <StatTile icon={Lock} label="Confidential" meta="Shown once balances sync">
        <Unavailable label="Not available yet" />
      </StatTile>
      <StatTile icon={Waypoints} label="Agents" meta="Each agent has its own budget">
        {agentCount(agents)}
      </StatTile>
      <StatTile icon={ChartNoAxesCombined} label="Net PnL" meta="From recorded fills">
        <Unavailable label="No trades yet" />
      </StatTile>
    </div>
  );
}
