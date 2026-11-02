import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AgentEditor } from "@/components/agents/editor";
import { AgentError } from "@/server/agents/errors";
import { readAgent } from "@/server/agents/mutations";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { isRemovedExecutablePack } from "@/shared/agent-scope";
import type { AgentSummary } from "@/shared/agents";

export const maxDuration = 120;

export default async function EditAgentPage({
  params,
}: {
  readonly params: Promise<{ readonly agentId: string }>;
}) {
  const user = await requireUser();
  const { agentId } = await params;
  if (!z.uuid().safeParse(agentId).success) {
    notFound();
  }
  let agent: AgentSummary;
  try {
    agent = await readAgent(database(), user.id, agentId);
  } catch (error) {
    if (error instanceof AgentError && error.code === "not_found") {
      notFound();
    }
    throw error;
  }
  if (isRemovedExecutablePack(agent.pack)) {
    redirect(`/agents/${agent.id}`);
  }
  return agent.status === "running" ? (
    <p className="text-body text-fg-muted">Pause this agent before editing its strategy.</p>
  ) : (
    <AgentEditor agent={agent} />
  );
}
