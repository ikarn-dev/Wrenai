import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AgentSetupReview } from "@/components/agents/setup-review";
import { requireUser } from "@/server/auth/session";
import { readAgentSetup } from "@/server/chat/agent-drafts";
import { ChatError } from "@/server/chat/errors";
import { database } from "@/server/db/client";
import { isActiveAgentTool } from "@/shared/agent-scope";
export default async function AgentSetupPage({
  params,
}: {
  readonly params: Promise<{ readonly draftId: string }>;
}) {
  const user = await requireUser();
  const id = z.uuid().safeParse((await params).draftId);
  if (!id.success) {
    notFound();
  }
  try {
    const draft = await readAgentSetup(database(), user.id, id.data);
    if (isActiveAgentTool(draft.tool)) {
      redirect(draft.agentId ? `/agents/${draft.agentId}` : `/agents/new?setup=${draft.id}`);
    }
    return <AgentSetupReview draft={draft} />;
  } catch (error) {
    if (error instanceof ChatError && error.code === "not_found") {
      notFound();
    }
    throw error;
  }
}
