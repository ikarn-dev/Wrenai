"use server";

import { and, eq } from "drizzle-orm";
import { strategyDrafts } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { instructionRouteTokens } from "@/server/execution/asset-review";
import { type IntentToken, intentTokens } from "@/server/research/intents";
import { isActiveAgentTool, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import { type AgentResult, saveAgentSchema, strategySchema } from "@/shared/agents";
import { agentAction, agentUser } from "./action-result";
import { AgentError } from "./errors";
import { saveAgent } from "./mutations";

/** Tokens to resolve a reviewed draft against: its route's tokens, or the registry for older strategy kinds. */
async function draftTokens(configJson: string): Promise<readonly IntentToken[]> {
  const strategy = strategySchema.parse(JSON.parse(configJson));
  return "format" in strategy ? instructionRouteTokens(strategy) : (await intentTokens()).tokens;
}

export async function saveAgentStrategy(raw: unknown): Promise<AgentResult<{ readonly agentId: string }>> {
  return agentAction(async () => {
    const user = await agentUser("manage");
    const input = saveAgentSchema.parse(raw);
    const [draft] = await database()
      .select({ pack: strategyDrafts.pack, configJson: strategyDrafts.configJson })
      .from(strategyDrafts)
      .where(and(eq(strategyDrafts.id, input.draftId), eq(strategyDrafts.userId, user.id)))
      .limit(1);
    if (!draft) {
      throw new AgentError("not_found", "The strategy review could not be found.");
    }
    if (draft && !isActiveAgentTool(draft.pack)) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    const tokens = await draftTokens(draft.configJson);
    const agentId = await saveAgent(database(), user.id, input, undefined, tokens);
    return { agentId };
  });
}
