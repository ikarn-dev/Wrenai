import { BrainCircuit } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { AgentStatus } from "@/components/agents/agent-card";
import { AgentAvatar } from "@/components/agents/avatar";
import type { PortfolioPerformance } from "@/server/portfolio/performance";
import type { AgentSummary } from "@/shared/agents";
import { formatCompactMicroUsd, formatUnits } from "@/shared/money";
import { PortfolioPanel } from "./panel";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function AgentPerformanceCard({
  agents,
  performance,
  testnet = false,
}: {
  readonly agents: readonly Pick<AgentSummary, "id" | "name" | "pack" | "status" | "returningFunds">[];
  readonly performance: PortfolioPerformance;
  readonly testnet?: boolean;
}): ReactElement {
  return (
    <PortfolioPanel
      id="agent-performance"
      title="PnL by agent"
      className="xl:col-span-2"
      aside={
        <Link
          href={testnet ? "/testnet/agents" : "/agents"}
          className="rounded-xs text-caption text-fg-muted hover:text-fg-strong"
        >
          Manage agents
        </Link>
      }
    >
      {/* Sideways only, so no data-lenis-prevent: it would contain vertical wheels and stop the page. The table
          keeps its own height, so rows sit under the header from the top however tall the card is; only the
          empty state centers in the leftover space. */}
      <div className="flex flex-1 flex-col overflow-x-auto">
        <table className="w-full min-w-sm border-collapse text-body">
          <caption className="sr-only">Your agents. Performance needs recorded fills.</caption>
          <thead className="h-8">
            <tr className="border-b border-line-card font-mono text-eyebrow uppercase text-fg-subtle">
              <th scope="col" className="pb-3 text-left font-medium">
                Agent
              </th>
              <th scope="col" className="pb-3 pl-4 text-left font-medium">
                Status
              </th>
              <th scope="col" className="pb-3 pl-4 text-right font-medium">
                Net PnL
              </th>
              <th scope="col" className="pb-3 pl-4 text-right font-medium">
                Return
              </th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const value = performance.agents.find((row) => row.agentId === agent.id);
              const pnl = value?.realizedPnlMicroUsd;
              const basis = value?.basisMicroUsd;
              return (
                <tr key={agent.id} className="border-b border-line-card last:border-0">
                  <th scope="row" className="py-4 text-left font-normal">
                    <Link
                      href={testnet ? `/testnet/agents/${agent.id}` : `/agents/${agent.id}`}
                      className="inline-flex items-center gap-3 rounded-xs hover:text-accent-text"
                    >
                      <AgentAvatar running={agent.status === "running"} />
                      {agent.name}
                    </Link>
                  </th>
                  <td className="py-4 pl-4">
                    <AgentStatus agent={agent} />
                  </td>
                  <td className="py-4 pl-4 text-right font-mono text-fg-muted">
                    {pnl === null || pnl === undefined ? (
                      <span title={value?.count ? "Incomplete cost or fee data" : "No recorded fills"}>
                        —
                      </span>
                    ) : (
                      <span className={pnl < 0n ? "text-loss" : pnl > 0n ? "text-gain" : ""}>
                        {formatCompactMicroUsd(pnl)}
                      </span>
                    )}
                  </td>
                  <td className="py-4 pl-4 text-right font-mono text-fg-muted">
                    {pnl !== null &&
                    pnl !== undefined &&
                    basis !== null &&
                    basis !== undefined &&
                    basis > 0n ? (
                      `${formatUnits((pnl * 10_000n) / basis, { decimals: 2, fractionDigits: 2 })}%`
                    ) : (
                      <span title="Unavailable">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {agents.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center">
            <BrainCircuit
              aria-hidden="true"
              size={24}
              strokeWidth={1.75}
              absoluteStrokeWidth
              className="text-fg-subtle"
            />
            <div className="flex max-w-xs flex-col gap-1.5">
              <p className="text-body font-medium text-fg-strong">No agents yet</p>
              <p className="text-small text-fg-muted">Create a strategy to see your agents here.</p>
            </div>
          </div>
        ) : null}
      </div>
    </PortfolioPanel>
  );
}

export function PnlCalendarCard({
  performance,
}: {
  readonly performance: PortfolioPerformance;
}): ReactElement {
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const firstDay = new Date(Date.UTC(year, month, 1));
  const offset = (firstDay.getUTCDay() + 6) % 7;
  const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dates = Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(Date.UTC(year, month, index + 1));
    return { day: index + 1, iso: date.toISOString().slice(0, 10) };
  });
  return (
    <PortfolioPanel
      id="pnl-calendar"
      title="PnL calendar"
      aside={<span className="text-caption text-fg-muted">{MONTH_LABEL.format(today)}</span>}
    >
      <div className="flex flex-col gap-2">
        <div aria-hidden="true" className="grid grid-cols-7 gap-1 text-center text-small text-fg-subtle">
          {WEEKDAYS.map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <ol
          aria-label={`${MONTH_LABEL.format(today)} realized PnL, in UTC.`}
          className="grid min-h-53 grid-cols-7 grid-rows-6 gap-1 font-mono text-small tabular-nums"
        >
          {WEEKDAYS.slice(0, offset).map((day) => (
            <li key={`offset-${day}`} aria-hidden="true" />
          ))}
          {dates.map(({ day, iso }) => {
            const record = performance.days.find((value) => value.date === iso);
            return (
              <li
                key={iso}
                aria-current={day === today.getUTCDate() ? "date" : undefined}
                title={
                  record
                    ? record.pnlMicroUsd === null
                      ? `${iso}: incomplete cost or fee data`
                      : `${iso}: ${formatCompactMicroUsd(record.pnlMicroUsd)} realized`
                    : `${iso}: no recorded fills`
                }
                className={`flex min-h-8 items-center justify-center rounded-xs ${day === today.getUTCDate() ? "text-accent-text ring-1 ring-accent-line ring-inset" : "text-fg-muted"}`}
              >
                <time dateTime={iso} className="flex flex-col items-center gap-1">
                  <span>{day}</span>
                  {record ? (
                    <span
                      className={`text-eyebrow ${record.pnlMicroUsd !== null && record.pnlMicroUsd < 0n ? "text-loss" : "text-fg-muted"}`}
                    >
                      {record.pnlMicroUsd === null ? "—" : formatCompactMicroUsd(record.pnlMicroUsd)}
                    </span>
                  ) : null}
                </time>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 text-caption">
        <p className="text-fg-subtle">
          {performance.days.length
            ? "Recorded realized PnL · hover for details"
            : "No recorded fills this month"}
        </p>
        <span className="text-fg-subtle">UTC</span>
      </div>
    </PortfolioPanel>
  );
}
