"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactElement } from "react";
import { AgentPageHeader, AgentToolbar } from "@/components/agents/agent-header";
import type { LiveModel, LivePhase } from "@/components/agents/live-model";
import { AgentLiveView } from "@/components/agents/live-view";
import { PerformanceTiles } from "@/components/agents/performance-tiles";
import { PortfolioPanel, PortfolioSection } from "@/components/portfolio/panel";
import { Badge } from "@/components/ui/badge";
import { agentPerformanceSchema } from "@/shared/agent-performance";
import { type TestnetSnapshot, testnetAsset } from "@/shared/testnet";
import { testnetAgentTool, testnetRuleText } from "@/shared/testnet-agents";
import { ordersThatFit, plannedOrders } from "@/shared/testnet-schedule";
import { TestnetAgentControls } from "./agent-controls";
import { testnetApi } from "./api";
import { useTestnetData, useTestnetLivePolling } from "./data-provider";
import { TestnetOrderRows } from "./order-rows";

type Agent = TestnetSnapshot["agents"][number];
type Order = TestnetSnapshot["orders"][number];
// Orders that moved funds or still might: placed, settled or awaiting review. Unconfirmed quotes and failures didn't.
const PLACED: ReadonlySet<string> = new Set(["queued", "prepared", "submitted", "settled", "needs_review"]);

function phaseOf(agent: Agent, orders: readonly Order[]): LivePhase {
  const inFlight = orders.find(
    (o) => o.state === "queued" || o.state === "prepared" || o.state === "submitted",
  );
  if (agent.state === "blocked") {
    return "blocked";
  }
  if (inFlight) {
    return inFlight.state === "submitted" ? "settling" : "submitting";
  }
  if (agent.state !== "running") {
    return agent.state === "completed" ? "completed" : "stopped";
  }
  return agent.rule.kind === "dip" || agent.rule.kind === "profit" ? "watching" : "waiting";
}

/** The live view from the snapshot: the same records the worker reads, refreshed every five seconds while live. */
function liveModel(agent: Agent, orders: readonly Order[]): LiveModel {
  const placed = orders.filter((o) => PLACED.has(o.state)),
    asset = testnetAsset(agent.rule.assetId);
  return {
    phase: phaseOf(agent, orders),
    nextAt: agent.nextAt,
    cadenceMs: agent.rule.kind === "dca" ? agent.rule.intervalSeconds * 1000 : null,
    startedAt: agent.createdAt,
    endsAt: agent.rule.expiresAt,
    done: placed.length,
    planned: plannedOrders(agent.rule),
    fits: ordersThatFit(agent.rule, agent.createdAt),
    budget: `${agent.rule.budget} ${asset.symbol}`,
    orderTimes: placed.map((o) => o.createdAt),
    // A running agent whose slot is due and carries a reason is waiting out an outage (agent-tick.ts → deferTick).
    retrying: agent.state === "running" && agent.reason !== null && agent.nextAt <= Date.now(),
  };
}
const STATE_LABEL: Readonly<Record<string, string>> = {
  running: "Running",
  stopped: "Stopped",
  completed: "Completed",
  blocked: "Needs review",
};

/** Live PnL from the agent's filled orders at a dry Tidepool quote, refreshed every 30 seconds while in view. */
function Performance({ agent }: { readonly agent: Agent }): ReactElement {
  const query = useQuery({
    queryKey: ["testnet-performance", agent.id],
    queryFn: async () =>
      agentPerformanceSchema.parse(
        await testnetApi(undefined, `?view=performance&id=${encodeURIComponent(agent.id)}`),
      ),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return (
    <PerformanceTiles
      performance={query.data}
      error={query.isError ? "PnL couldn’t refresh. Retrying in 30 s." : null}
    />
  );
}

function Detail({ label, children }: { readonly label: string; readonly children: string }): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-small text-fg-muted">{label}</dt>
      <dd className="text-right font-mono text-small text-fg-strong tabular-nums">{children}</dd>
    </div>
  );
}

const BLOCK = "block rounded-xs bg-surface-2 motion-safe:animate-pulse";

/** The detail page's own shape while the testnet snapshot loads. */
export function TestnetAgentSkeleton(): ReactElement {
  return (
    <div role="status" aria-label="Loading agent" className="flex min-w-0 flex-col gap-6">
      <div aria-hidden="true" className="flex flex-col gap-4">
        <span className={`${BLOCK} h-5 w-24`} />
        <div className="flex items-center gap-3">
          <span className={`${BLOCK} size-8 rounded-full`} />
          <span className={`${BLOCK} h-8 w-56`} />
          <span className={`${BLOCK} h-6 w-16 rounded-full`} />
        </div>
      </div>
      <div
        aria-hidden="true"
        className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-y border-line-subtle py-3"
      >
        <span className={`${BLOCK} h-6 w-64`} />
        <span className={`${BLOCK} h-8 w-56`} />
      </div>
      <PerformanceTiles performance={undefined} error={null} />
      <div aria-hidden="true" className="grid min-w-0 gap-stack xl:grid-cols-2">
        {["strategy", "allocation"].map((panel) => (
          <div key={panel} className="flex min-h-40 flex-col gap-3 card-shine rounded-lg p-card">
            <span className={`${BLOCK} h-4 w-28`} />
            <span className={`${BLOCK} h-6 w-full`} />
            <span className={`${BLOCK} h-6 w-3/4`} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TestnetAgentDetail({ id }: { readonly id: string }): ReactElement | null {
  const { data, refresh } = useTestnetData();
  const agent = data?.agents.find((a) => a.id === id);
  const live =
    agent !== undefined &&
    (agent.state === "running" ||
      (data?.orders ?? []).some(
        (o) => o.bucket === id && (o.state === "queued" || o.state === "prepared" || o.state === "submitted"),
      ));
  useTestnetLivePolling(data?.owner.id ?? null, live);
  if (!data || !agent) {
    return <p className="text-small text-fg-muted">This agent is unavailable in this testnet session.</p>;
  }
  if (agent.state === "deleted") {
    return (
      <p className="text-small text-fg-muted">
        This agent is deleted. Its funds wait in{" "}
        <Link href="/testnet/claims" className="text-accent-text underline-offset-4 hover:underline">
          Claims
        </Link>
        .
      </p>
    );
  }
  const asset = testnetAsset(agent.rule.assetId),
    orders = data.orders.filter((o) => o.bucket === id);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AgentPageHeader
        name={agent.name}
        pack={testnetAgentTool(agent.kind)}
        running={agent.state === "running"}
        backHref="/testnet/agents"
        testnet
      />
      <AgentToolbar
        status={
          <Badge
            tone={agent.state === "running" ? "accent" : agent.state === "blocked" ? "warn" : "neutral"}
            dot
          >
            {STATE_LABEL[agent.state] ?? agent.state}
          </Badge>
        }
        reason={agent.reason}
      >
        <TestnetAgentControls agent={agent} />
      </AgentToolbar>
      <AgentLiveView model={liveModel(agent, orders)} />
      <Performance agent={agent} />
      <div className="grid min-w-0 gap-stack xl:grid-cols-2">
        <PortfolioPanel id="strategy" title="What it does">
          <p className="text-small text-fg">{testnetRuleText(agent.rule)}</p>
        </PortfolioPanel>
        <PortfolioPanel id="allocation" title="Allocation">
          <dl className="divide-y divide-line-card">
            <Detail label="Budget">{`${agent.rule.budget} ${asset.symbol}`}</Detail>
            <Detail label="Each order">{`${agent.rule.amount} ${asset.symbol}`}</Detail>
            <Detail label="Balance">{agent.rule.location === "intents" ? "Public Intents" : "Wallet"}</Detail>
          </dl>
        </PortfolioPanel>
      </div>
      <PortfolioSection id="orders" title="Orders">
        <TestnetOrderRows orders={orders} onChanged={refresh} />
      </PortfolioSection>
    </div>
  );
}
