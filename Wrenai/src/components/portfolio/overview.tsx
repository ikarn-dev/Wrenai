import { ChartNoAxesCombined, MessageCircle, ShieldCheck, Wallet, Waypoints } from "lucide-react";
import type { ReactElement } from "react";
import type { WalletBalanceReading } from "@/server/portfolio/wallet-balance";
import type { AgentSummary } from "@/shared/agents";
import type { UserRiskPolicyRecord } from "@/shared/risk-policy";
import type { TelegramLinkState } from "@/shared/telegram";
import { StatTile } from "./panel";
import { NearAmount, ReadTime } from "./wallet-cards";

interface PortfolioOverviewProps {
  readonly wallet: WalletBalanceReading;
  readonly agents: readonly AgentSummary[];
  readonly riskPolicy: UserRiskPolicyRecord | null;
  readonly telegram: TelegramLinkState;
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

function telegramValue(telegram: TelegramLinkState): ReactElement {
  switch (telegram.kind) {
    case "linked":
      return (
        <>
          {telegram.account.username === null ? telegram.account.firstName : `@${telegram.account.username}`}
        </>
      );
    case "waiting":
    case "confirm":
      return <Quiet>Finishing link</Quiet>;
    case "unlinked":
      return <Quiet>Not connected</Quiet>;
    case "unavailable":
      return <Quiet>Unavailable</Quiet>;
    default: {
      const unhandled: never = telegram;
      throw new Error(`Unhandled Telegram state: ${String(unhandled)}`);
    }
  }
}

/**
 * What a user checks first: the wallet, then four facts in a 2×2 grid (agents, PnL, the spending limit every
 * agent trades inside, and whether Telegram alerts reach them). Trading access lives in the pane beside this.
 */
export function PortfolioOverview({
  wallet,
  agents,
  riskPolicy,
  telegram,
}: PortfolioOverviewProps): ReactElement {
  return (
    <div className="grid content-start gap-stack sm:grid-cols-2">
      <div className="sm:col-span-2">
        <StatTile icon={Wallet} label="NEAR wallet" meta={<ReadTime reading={wallet} />}>
          {wallet.kind === "unavailable" ? (
            <Quiet>Unavailable</Quiet>
          ) : (
            <NearAmount amount={wallet.kind === "balance" ? wallet.yocto : 0n} large />
          )}
        </StatTile>
      </div>
      <StatTile icon={Waypoints} label="Agents" meta="Each agent has its own budget">
        {agentCount(agents)}
      </StatTile>
      <StatTile icon={ChartNoAxesCombined} label="Net PnL" meta="From recorded fills">
        <Quiet>No trades yet</Quiet>
      </StatTile>
      <StatTile icon={ShieldCheck} label="Daily limit" meta="Shared by all your agents">
        {riskPolicy === null ? <Quiet>Not set</Quiet> : `$${riskPolicy.policy.dailyCapUsd} per day`}
      </StatTile>
      <StatTile icon={MessageCircle} label="Telegram" meta="Alerts and approvals">
        {telegramValue(telegram)}
      </StatTile>
    </div>
  );
}
