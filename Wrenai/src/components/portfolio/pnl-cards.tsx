import { Waypoints } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { AgentStatus } from "@/components/agents/agent-card";
import { AgentAvatar } from "@/components/agents/avatar";
import type { AgentSummary } from "@/shared/agents";
import { PortfolioPanel } from "./panel";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function AgentPerformanceCard({ agents }: { readonly agents: readonly AgentSummary[] }): ReactElement {
  return (
    <PortfolioPanel
      id="agent-performance"
      title="PnL by agent"
      className="xl:col-span-2"
      aside={
        <Link href="/agents" className="rounded-xs text-caption text-fg-muted hover:text-fg-strong">
          Manage agents
        </Link>
      }
    >
      <div data-lenis-prevent className="flex-1 overflow-x-auto">
        <table className="h-full w-full min-w-sm border-collapse text-body">
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
            {agents.length > 0 ? (
              agents.map((agent) => (
                <tr key={agent.id} className="border-b border-line-card last:border-0">
                  <th scope="row" className="py-4 text-left font-normal">
                    <Link
                      href={`/agents/${agent.id}`}
                      className="inline-flex items-center gap-3 rounded-xs hover:text-accent-text"
                    >
                      <AgentAvatar id={agent.id} running={agent.status === "running"} />
                      {agent.name}
                    </Link>
                  </th>
                  <td className="py-4 pl-4">
                    <AgentStatus agent={agent} />
                  </td>
                  <td className="py-4 pl-4 text-right font-mono text-fg-muted">
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">No recorded fills</span>
                  </td>
                  <td className="py-4 pl-4 text-right font-mono text-fg-muted">
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">Unavailable</span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="py-8 text-center align-middle">
                  <div className="mx-auto flex max-w-xs flex-col items-center gap-3">
                    <Waypoints
                      aria-hidden="true"
                      size={24}
                      strokeWidth={1.75}
                      absoluteStrokeWidth
                      className="text-fg-subtle"
                    />
                    <div className="flex flex-col gap-1.5">
                      <p className="text-body font-medium text-fg-strong">No agents yet</p>
                      <p className="text-small text-fg-muted">Create a strategy to see your agents here.</p>
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </PortfolioPanel>
  );
}

export function PnlCalendarCard(): ReactElement {
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
          aria-label={`${MONTH_LABEL.format(today)}. PnL data is unavailable.`}
          className="grid min-h-53 grid-cols-7 grid-rows-6 gap-1 font-mono text-small tabular-nums"
        >
          {WEEKDAYS.slice(0, offset).map((day) => (
            <li key={`offset-${day}`} aria-hidden="true" />
          ))}
          {dates.map(({ day, iso }) => (
            <li
              key={iso}
              aria-current={day === today.getUTCDate() ? "date" : undefined}
              className={`flex min-h-8 items-center justify-center rounded-xs ${day === today.getUTCDate() ? "text-accent-text ring-1 ring-accent-line ring-inset" : "text-fg-muted"}`}
            >
              <time dateTime={iso}>{day}</time>
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 text-caption">
        <p className="text-fg-subtle">PnL data unavailable</p>
        <span className="text-fg-subtle">UTC</span>
      </div>
    </PortfolioPanel>
  );
}
