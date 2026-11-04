import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AgentCatalog } from "@/components/agents/catalog";
import { AgentEditor } from "@/components/agents/editor";
import { setupBindingHash } from "@/server/agents/setup-binding";
import { requireUser } from "@/server/auth/session";
import { readAgentSetup } from "@/server/chat/agent-drafts";
import { database } from "@/server/db/client";
import { readManualPreview } from "@/server/manual-trading/service";
import { budgetTokenAmount } from "@/shared/agent-budget";
import { isActiveAgentTool } from "@/shared/agent-scope";
import { packSchema } from "@/shared/agents";
import { manualAgentBrief } from "@/shared/manual-agent-brief";
import { researchToolSchema } from "@/shared/research";

export const metadata: Metadata = { title: "New agent" };
export const maxDuration = 120;

export default async function NewAgentPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly setup?: string;
    readonly tool?: string;
    readonly manual?: string;
    readonly brief?: string;
  }>;
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
      return (
        <AgentEditor
          setup={{
            id: draft.id,
            hash: setupBindingHash(draft),
            pack: pack.data,
            brief: draft.brief,
            budget: draft.budget
              ? {
                  assetId: draft.budget.assetId,
                  amount: budgetTokenAmount(draft.budget.units, draft.budget.decimals),
                }
              : null,
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
    const pack = packSchema.safeParse(tool.data);
    if (!pack.success) {
      notFound();
    }
    const manual = z.uuid().safeParse(query.manual);
    const initialBrief = manual.success
      ? manualAgentBrief((await readManualPreview(database(), user.id, manual.data)).intent)
      : z
          .string()
          .trim()
          .max(3000)
          .catch("")
          .parse(query.brief ?? "");
    return <AgentEditor initialPack={pack.data} initialBrief={initialBrief} />;
  }
  return <AgentCatalog />;
}
