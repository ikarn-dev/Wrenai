import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AgentCatalog } from "@/components/agents/catalog";
import { AgentEditor } from "@/components/agents/editor";
import { NewAgentSetup } from "@/components/agents/new-setup";
import { requireUser } from "@/server/auth/session";
import { readAgentSetup } from "@/server/chat/agent-drafts";
import { database } from "@/server/db/client";
import { packSchema } from "@/shared/agents";
import { researchToolSchema } from "@/shared/research";

export const metadata: Metadata = { title: "New agent" };
export const maxDuration = 120;

export default async function NewAgentPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly setup?: string; readonly tool?: string }>;
}) {
  const user = await requireUser();
  const query = await searchParams;
  const id = z.uuid().safeParse(query.setup);
  if (id.success) {
    const draft = await readAgentSetup(database(), user.id, id.data);
    const pack = packSchema.safeParse(draft.tool);
    if (pack.success) {
      return <AgentEditor setup={{ pack: pack.data, brief: draft.brief }} />;
    }
    redirect(`/agents/setup/${id.data}`);
  }
  if (query.setup) {
    notFound();
  }
  if (query.tool) {
    const tool = researchToolSchema.safeParse(query.tool);
    if (!tool.success) {
      notFound();
    }
    return <NewAgentSetup tool={tool.data} />;
  }
  return <AgentCatalog />;
}
