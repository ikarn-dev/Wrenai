import type { ReactElement } from "react";
import { PortfolioPanel } from "@/components/portfolio/panel";
import { TradingRecovery } from "@/components/settings/trading-recovery";
import { agentHistory } from "@/server/agents/queries";
import type { SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { agentRuntimeStatus } from "@/server/engine/status";
import { readAgentTradeAssets } from "@/server/execution/asset-review";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { tradingAccountSummary } from "@/server/trading-accounts/vault";
import type { AgentSummary } from "@/shared/agents";
import { PerpsReturnFunds } from "./perps-return";
import { AgentRuntimePanel } from "./runtime-status";
import { StrategySummary } from "./strategy-summary";

// Each section streams in on its own, so the agent page shows its header and controls without waiting for the
// slowest read (token metadata from NEAR RPC or the 1Click registry, history, venue accounts).

const BLOCK = "block rounded-xs bg-surface-2 motion-safe:animate-pulse";

function timestamp(value: number): string {
  return new Date(value).toISOString().slice(0, 16).replace("T", " ");
}

export function RuntimeSkeleton(): ReactElement {
  return (
    <div role="status" aria-label="Loading agent status" className="flex flex-col gap-3">
      <span aria-hidden="true" className={`${BLOCK} h-6 w-64`} />
      <span aria-hidden="true" className={`${BLOCK} h-10 w-48`} />
    </div>
  );
}

export async function RuntimeSection({
  agent,
  ownerId,
  executionAvailable,
}: {
  readonly agent: AgentSummary;
  readonly ownerId: string;
  readonly executionAvailable: boolean;
}): Promise<ReactElement> {
  const runtime = await agentRuntimeStatus(database(), ownerId, agent.id);
  return (
    <AgentRuntimePanel
      agent={agent}
      ownerId={ownerId}
      initial={runtime}
      executionAvailable={executionAvailable}
    />
  );
}

export function StrategySkeleton(): ReactElement {
  return (
    <div role="status" aria-label="Loading the strategy" className="flex flex-col gap-3">
      {["a", "b", "c", "d"].map((row) => (
        <span key={row} aria-hidden="true" className={`${BLOCK} h-6 w-full`} />
      ))}
    </div>
  );
}

/** Token names and decimals for the summary. Display only: when they can't be read, the summary falls back to
 * well-known tokens and contract names; every trade reads its assets itself. */
export async function StrategySection({
  agent,
  ownerId,
}: {
  readonly agent: AgentSummary;
  readonly ownerId: string;
}): Promise<ReactElement> {
  // Token names only change when 1Click lists a new token, so the page accepts a registry copy up to ten minutes
  // old instead of downloading the whole list on every view. Display only; trades read their own fresh copy.
  const assets =
    "format" in agent.strategy
      ? await readAgentTradeAssets(database(), ownerId, agent.id, agent.revision, 600_000).then(
          (read) => read.reviewed,
          () => [],
        )
      : [];
  return <StrategySummary strategy={agent.strategy} assets={assets} />;
}

export async function PerpsSection({
  agent,
  user,
}: {
  readonly agent: AgentSummary;
  readonly user: SessionUser;
}): Promise<ReactElement> {
  const db = database();
  const [venueAccount, recovery, runtime] = await Promise.all([
    readAgentTradingAccount(db, user.id, agent.id),
    tradingAccountSummary(db, user.id),
    agentRuntimeStatus(db, user.id, agent.id),
  ]);
  return (
    <PortfolioPanel id="perps-account" title="Perps trading account">
      <p className="text-small text-fg-muted">
        Starting converts this agent’s funds into USDC at its own Hyperliquid address. Venue balances, orders
        and fills are public. The recovery backup is required before funding.
      </p>
      {venueAccount ? (
        <p className="mt-3 break-all font-mono text-small tabular-nums">{venueAccount.perpAddress}</p>
      ) : null}
      {!recovery?.derivedBackupConfirmed ? (
        <div className="mt-4">
          <TradingRecovery
            accountId={user.accountId}
            agents={[{ id: agent.id, name: agent.name }]}
            initial={recovery}
          />
        </div>
      ) : (
        <p className="mt-3 text-small text-accent-text">Recovery backup saved.</p>
      )}
      {venueAccount ? (
        <PerpsReturnFunds
          agentId={agent.id}
          revision={agent.revision}
          running={agent.status === "running"}
          pending={runtime.pending.length > 0}
        />
      ) : null}
    </PortfolioPanel>
  );
}

export async function HistorySection({
  agentId,
  ownerId,
}: {
  readonly agentId: string;
  readonly ownerId: string;
}): Promise<ReactElement> {
  const history = await agentHistory(ownerId, agentId);
  return (
    <div className="grid min-w-0 gap-stack xl:grid-cols-2">
      <PortfolioPanel id="versions" title="Strategy versions">
        <ol className="flex flex-col gap-5">
          {history.versions.map((version) => (
            <li key={version.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-small font-medium">Version {version.version}</h3>
                <time
                  dateTime={new Date(version.createdAt).toISOString()}
                  className="font-mono text-caption text-fg-subtle"
                >
                  {timestamp(version.createdAt)} UTC
                </time>
              </div>
              <p className="text-small leading-relaxed text-fg-muted">{version.strategyText}</p>
            </li>
          ))}
        </ol>
      </PortfolioPanel>
      <PortfolioPanel id="history" title="Agent history">
        <ol className="flex flex-col gap-5">
          {history.events.map((event) => (
            <li key={event.id} className="flex flex-col gap-1">
              <p className="text-small text-fg">{event.message}</p>
              <time
                dateTime={new Date(event.createdAt).toISOString()}
                className="font-mono text-caption text-fg-subtle"
              >
                {timestamp(event.createdAt)} UTC
              </time>
            </li>
          ))}
        </ol>
      </PortfolioPanel>
    </div>
  );
}
