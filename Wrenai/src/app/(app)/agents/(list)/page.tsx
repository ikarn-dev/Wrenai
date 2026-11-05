import { BrainCircuit } from "lucide-react";
import type { Metadata } from "next";
import { type ReactElement, Suspense } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentListSkeleton } from "@/components/agents/agent-list-skeleton";
import { AgentsHeader, EMPTY_AGENTS_CARD } from "@/components/agents/agents-header";
import { AgentCatalog } from "@/components/agents/catalog";
import { GlobalStop } from "@/components/agents/controls";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { SetupCard } from "@/components/agents/setup-card";
import { PortfolioSection } from "@/components/portfolio/panel";
import { type CreateAgentQuery, resolveCreateRequest } from "@/server/agents/create-request";
import { listAgents, readTradingControls } from "@/server/agents/records";
import { requireUser } from "@/server/auth/session";
import { listAgentSetups } from "@/server/chat/agent-drafts";
import { database } from "@/server/db/client";

export const metadata: Metadata = { title: "Agents" };
// The create dialog's strategy verification and save run as this page's Server Actions.
export const maxDuration = 120;

type AgentListRead = ReturnType<typeof listAgents>;

async function AgentList({ data }: { readonly data: AgentListRead }): Promise<ReactElement> {
  const agents = await data;
  return (
    <>
      {agents.length === 0 ? (
        <div className={EMPTY_AGENTS_CARD}>
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
          <BrainCircuit
            size={20}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
            className="relative text-accent-text"
          />
          <p className="relative text-body text-fg-strong">No agents yet</p>
          <p className="relative text-small text-fg-muted">Pick a type below to set one up.</p>
        </div>
      ) : (
        <div className="grid min-w-0 auto-rows-fr gap-stack md:grid-cols-2 2xl:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </>
  );
}

async function StopControl({
  agents,
  controls,
}: {
  readonly agents: AgentListRead;
  readonly controls: ReturnType<typeof readTradingControls>;
}): Promise<ReactElement | null> {
  const [list, state] = await Promise.all([agents, controls]);
  return list.length > 0 || state.engaged ? (
    <GlobalStop engaged={state.engaged} revision={state.revision} />
  ) : null;
}

async function SavedSetups({
  data,
}: {
  readonly data: ReturnType<typeof listAgentSetups>;
}): Promise<ReactElement | null> {
  const setups = await data;
  return setups.length ? (
    <PortfolioSection
      id="saved-setups"
      title="Saved setups"
      aside={<span className="text-caption text-fg-subtle">Drafts, not running</span>}
    >
      <div className="grid gap-stack md:grid-cols-2 2xl:grid-cols-3">
        {setups.map((setup) => (
          <SetupCard key={setup.id} setup={setup} />
        ))}
      </div>
    </PortfolioSection>
  ) : null;
}

async function CreateDialog({
  userId,
  searchParams,
}: {
  readonly userId: string;
  readonly searchParams: Promise<CreateAgentQuery>;
}): Promise<ReactElement | null> {
  const query = await searchParams;
  if (query["create"] === undefined && query["setup"] === undefined) {
    return null;
  }
  return <CreateAgentDialog request={await resolveCreateRequest(userId, query)} />;
}

export default async function AgentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<CreateAgentQuery>;
}): Promise<ReactElement> {
  const user = await requireUser();
  const db = database();
  const agents = listAgents(db, user.id);
  const controls = readTradingControls(db, user.id);
  const setups = listAgentSetups(db, user.id);
  const counts = agents.then((list) => ({
    live: list.filter((agent) => agent.status === "running").length,
    total: list.length,
  }));
  return (
    <div className="flex min-w-0 flex-col gap-12">
      <AgentsHeader counts={counts} />
      <PortfolioSection
        id="your-agents"
        title="Your agents"
        aside={
          <Suspense fallback={null}>
            <StopControl agents={agents} controls={controls} />
          </Suspense>
        }
      >
        <Suspense fallback={<AgentListSkeleton />}>
          <AgentList data={agents} />
        </Suspense>
      </PortfolioSection>
      <Suspense fallback={null}>
        <SavedSetups data={setups} />
      </Suspense>
      <AgentCatalog />
      <Suspense fallback={null}>
        <CreateDialog userId={user.id} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
