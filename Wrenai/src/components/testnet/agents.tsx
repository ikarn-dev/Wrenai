"use client";
import { BrainCircuit } from "lucide-react";
import type { ReactElement } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentsHeader, EMPTY_AGENTS_CARD } from "@/components/agents/agents-header";
import { AgentCatalog } from "@/components/agents/catalog";
import { PortfolioSection } from "@/components/portfolio/panel";
import { Badge } from "@/components/ui/badge";
import { testnetAsset } from "@/shared/testnet";
import { testnetAgentTool, testnetAgentToolSchema, testnetRuleText } from "@/shared/testnet-agents";
import { TestnetAgentSetup } from "./agent-setup";
import { useTestnetData } from "./data-provider";

export function TestnetAgents(): ReactElement | null {
  const { data } = useTestnetData();
  // A deleted agent leaves the list at once; anything it still holds waits in Claims.
  const agents = (data?.agents ?? []).filter((a) => a.state !== "deleted"),
    live = agents.filter((a) => a.state === "running").length;
  return (
    <div className="flex min-w-0 flex-col gap-12">
      <AgentsHeader testnet />
      <PortfolioSection
        id="your-agents"
        title="Your agents"
        aside={
          <Badge tone={live ? "accent" : "neutral"} dot>
            {live} live of {agents.length}
          </Badge>
        }
      >
        {agents.length ? (
          <div className="grid min-w-0 auto-rows-fr gap-stack md:grid-cols-2 2xl:grid-cols-3">
            {agents.map((a) => (
              <AgentCard
                key={a.id}
                href={`/testnet/agents/${a.id}`}
                agent={{
                  id: a.id,
                  name: a.name,
                  pack: testnetAgentTool(a.kind),
                  status: a.state === "running" ? "running" : a.state === "blocked" ? "error" : "stopped",
                  reason: a.reason ?? "",
                  strategyText: testnetRuleText(a.rule),
                  returningFunds: false,
                }}
                budgetLabel={`${a.rule.budget} ${testnetAsset(a.rule.assetId).symbol}`}
              />
            ))}
          </div>
        ) : (
          <div className={EMPTY_AGENTS_CARD}>
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
            <BrainCircuit size={20} className="relative text-accent-text" />
            <p className="relative text-body text-fg-strong">No agents yet</p>
            <p className="relative text-small text-fg-muted">Pick a type below to set one up.</p>
          </div>
        )}
      </PortfolioSection>
      <AgentCatalog tools={testnetAgentToolSchema.options} testnet />
      <TestnetAgentSetup />
    </div>
  );
}
