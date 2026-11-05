import "server-only";
import { redirect } from "next/navigation";
import { z } from "zod";
import { setupBindingHash } from "@/server/agents/setup-binding";
import { readAgentSetup } from "@/server/chat/agent-drafts";
import { database } from "@/server/db/client";
import { readManualPreview } from "@/server/manual-trading/service";
import { budgetTokenAmount } from "@/shared/agent-budget";
import { ANY_AGENT_TYPE, type CreateAgentRequest } from "@/shared/agent-create-request";
import { isActiveAgentTool } from "@/shared/agent-scope";
import { type AgentSummary, packSchema } from "@/shared/agents";
import { manualAgentBrief } from "@/shared/manual-agent-brief";
import { researchToolSchema } from "@/shared/research";

export type CreateAgentQuery = Readonly<Record<string, string | string[] | undefined>>;

const DEFAULT_PACK: AgentSummary["pack"] = "spot_trader";

function activePack(value: unknown): AgentSummary["pack"] | null {
  const tool = researchToolSchema.safeParse(value);
  if (!tool.success || !isActiveAgentTool(tool.data)) {
    return null;
  }
  const pack = packSchema.safeParse(tool.data);
  return pack.success ? pack.data : null;
}

async function initialBrief(userId: string, query: CreateAgentQuery): Promise<string> {
  const manual = z.uuid().safeParse(query["manual"]);
  if (manual.success) {
    return manualAgentBrief((await readManualPreview(database(), userId, manual.data)).intent);
  }
  return z
    .string()
    .trim()
    .max(3000)
    .catch("")
    .parse(query["brief"] ?? "");
}

async function setupRequest(userId: string, id: string): Promise<CreateAgentRequest | null> {
  const draft = await readAgentSetup(database(), userId, id);
  const pack = isActiveAgentTool(draft.tool) ? packSchema.safeParse(draft.tool) : null;
  if (!pack?.success) {
    redirect(`/agents/setup/${id}`);
  }
  // A setup that already became an agent opens nothing: the agent is in the list. The create action's own page
  // refresh lands here too, so this must not navigate away from the dialog's result.
  if (draft.agentId) {
    return null;
  }
  return {
    pack: pack.data,
    brief: draft.brief,
    setup: {
      id: draft.id,
      hash: setupBindingHash(draft),
      budget: draft.budget
        ? {
            assetId: draft.budget.assetId,
            amount: budgetTokenAmount(draft.budget.units, draft.budget.decimals),
          }
        : null,
    },
  };
}

/**
 * Reads the Agents page's `?create=<tool|agent>` (with optional `brief` or `manual`) or `?setup=<id>` into the
 * dialog's starting state. Unknown or inactive types open nothing.
 */
export async function resolveCreateRequest(
  userId: string,
  query: CreateAgentQuery,
): Promise<CreateAgentRequest | null> {
  const setupId = z.uuid().safeParse(query["setup"]);
  if (setupId.success) {
    return setupRequest(userId, setupId.data);
  }
  const create = query["create"];
  if (create === undefined) {
    return null;
  }
  const pack = create === ANY_AGENT_TYPE ? DEFAULT_PACK : activePack(create);
  return pack === null ? null : { pack, brief: await initialBrief(userId, query), setup: null };
}
