import { BrainCircuit, ChartNoAxesCombined, MessageCircle, ShieldCheck, Wallet } from "lucide-react";
import type { ReactElement } from "react";
import type { PortfolioPerformance } from "@/server/portfolio/performance";
import type { WalletBalanceReading } from "@/server/portfolio/wallet-balance";
import type { AgentSummary } from "@/shared/agents";
import { formatCompactMicroUsd } from "@/shared/money";
import type { TelegramLinkState } from "@/shared/telegram";
import { StatTile } from "./panel";
import { NearAmount, ReadTime } from "./wallet-cards";

interface PortfolioOverviewProps {
  readonly wallet: WalletBalanceReading;
  readonly agents: readonly AgentSummary[];
  readonly telegram: TelegramLinkState;
  readonly performance: PortfolioPerformance;
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
 * Wallet and agent facts. Different token budgets cannot be added into a fictional shared USD balance.
 */
export function PortfolioOverview({
  wallet,
  agents,
  telegram,
  performance,
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
      <StatTile icon={BrainCircuit} label="Agents" meta="Each agent has its own budget">
        {agentCount(agents)}
      </StatTile>
      <StatTile
        icon={ChartNoAxesCombined}
        label="Realized PnL"
        meta="From recorded fills; excludes unrealized changes"
      >
        {performance.totalMicroUsd !== null ? (
          formatCompactMicroUsd(performance.totalMicroUsd)
        ) : (
          <Quiet>{performance.count ? "Incomplete cost data" : "No recorded fills"}</Quiet>
        )}
      </StatTile>
      <StatTile icon={ShieldCheck} label="Budgets" meta="Exact tokens allocated during agent setup">
        Per agent
      </StatTile>
      <StatTile icon={MessageCircle} label="Telegram" meta="Alerts and approvals">
        {telegramValue(telegram)}
      </StatTile>
    </div>
  );
}
