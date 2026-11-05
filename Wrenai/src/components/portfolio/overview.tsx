import { BrainCircuit, ChartNoAxesCombined, MessageCircle, ShieldCheck, Wallet } from "lucide-react";
import { type ReactElement, Suspense } from "react";
import type { PortfolioPerformance } from "@/server/portfolio/performance";
import type { AgentSummary } from "@/shared/agents";
import { formatCompactMicroUsd } from "@/shared/money";
import type { TelegramLinkState } from "@/shared/telegram";
import { StatTile } from "./panel";
import { WalletValue } from "./wallet-cards";

interface PortfolioOverviewProps {
  readonly agents: Promise<readonly AgentSummary[]>;
  readonly telegram: Promise<TelegramLinkState>;
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

async function TelegramValue({
  data,
}: {
  readonly data: PortfolioOverviewProps["telegram"];
}): Promise<ReactElement> {
  return telegramValue(await data);
}

/**
 * Wallet and agent facts. Different token budgets cannot be added into a fictional shared USD balance.
 */
export function PortfolioOverview({ agents, telegram, performance }: PortfolioOverviewProps): ReactElement {
  // Rows stretch to the trading-access pane's height beside it, so both columns end on the same line.
  return (
    <div className="grid gap-stack sm:grid-cols-2">
      <div className="grid sm:col-span-2">
        <StatTile icon={Wallet} label="NEAR wallet">
          <WalletValue />
        </StatTile>
      </div>
      <StatTile icon={BrainCircuit} label="Agents">
        <Suspense fallback={<TileLoading />}>
          <AgentsValue data={agents} />
        </Suspense>
      </StatTile>
      <StatTile icon={ChartNoAxesCombined} label="Realized PnL">
        <Suspense fallback={<TileLoading />}>
          <PerformanceValue data={performance} />
        </Suspense>
      </StatTile>
      <StatTile icon={ShieldCheck} label="Budgets">
        Per agent
      </StatTile>
      <StatTile icon={MessageCircle} label="Telegram">
        <Suspense fallback={<TileLoading />}>
          <TelegramValue data={telegram} />
        </Suspense>
      </StatTile>
    </div>
  );
}
