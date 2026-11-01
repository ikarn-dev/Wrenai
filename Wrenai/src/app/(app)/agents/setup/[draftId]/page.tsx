import { notFound } from "next/navigation";
import { z } from "zod";
import { AgentSetupReview } from "@/components/agents/setup-review";
import { requireUser } from "@/server/auth/session";
import { readAgentSetup } from "@/server/chat/agent-drafts";
import { ChatError } from "@/server/chat/errors";
import { database } from "@/server/db/client";
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
    return <AgentSetupReview draft={await readAgentSetup(database(), user.id, id.data)} />;
  } catch (error) {
    if (error instanceof ChatError && error.code === "not_found") {
      notFound();
    }
    throw error;
  }
}
