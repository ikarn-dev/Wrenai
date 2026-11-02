import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AgentCatalog } from "@/components/agents/catalog";
import { AgentEditor } from "@/components/agents/editor";
import { NewAgentSetup } from "@/components/agents/new-setup";
import { setupBindingHash } from "@/server/agents/setup-binding";
import { requireUser } from "@/server/auth/session";
import { readAgentSetup } from "@/server/chat/agent-drafts";
import { database } from "@/server/db/client";
import { budgetTokenAmount } from "@/shared/agent-budget";
import { isActiveAgentTool } from "@/shared/agent-scope";
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
    if (!isActiveAgentTool(draft.tool)) {
      redirect(`/agents/setup/${id.data}`);
    }
    const pack = packSchema.safeParse(draft.tool);
    if (pack.success) {
      if (draft.agentId) {
        redirect(`/agents/${draft.agentId}`);
      }
      const allocation = draft.budget
        ? `\nReviewed spending allocation: ${budgetTokenAmount(draft.budget.units, draft.budget.decimals)} ${draft.budget.symbol}; exact wallet asset ${draft.budget.assetId}; decimals ${draft.budget.decimals}; smallest units ${draft.budget.units}.\nThis identifies the spending token only; do not invent any other token identity or price.`
        : "";
      return (
        <AgentEditor
          setup={{
            id: draft.id,
            hash: setupBindingHash(draft),
            pack: pack.data,
            brief: `${draft.brief}${allocation}`.slice(0, 4000),
          }}
        />
      );
    }
    redirect(`/agents/setup/${id.data}`);
  }
  if (query.setup) {
    notFound();
  }
  if (query.tool) {
    const tool = researchToolSchema.safeParse(query.tool);
    if (!tool.success || !isActiveAgentTool(tool.data)) {
      notFound();
    }
    return <NewAgentSetup tool={tool.data} />;
  }
  return <AgentCatalog />;
}
