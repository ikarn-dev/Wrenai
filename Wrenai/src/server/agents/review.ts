import "server-only";
import { refineStrategyText } from "@/server/ai/strategy-refiner";
import { isActiveAgentTool, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import {
  type AgentResult,
  parseStrategyInputSchema,
  type StrategyDraft,
  type StrategyRefinement,
} from "@/shared/agents";
import { agentAction, agentUser, withAssets } from "./action-result";
import { prepareStrategyDraft } from "./drafts";
import { AgentError } from "./errors";

/** Verifies strategy text into reviewed rules. Idempotent per request ID. */
export async function reviewStrategy(raw: unknown): Promise<AgentResult<StrategyDraft>> {
  return agentAction(async () => {
    const user = await agentUser("parse");
    const input = parseStrategyInputSchema.parse(raw);
    if (!isActiveAgentTool(input.pack)) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    return withAssets(await prepareStrategyDraft(user.id, input));
  });
}

/**
 * Rewrites the instructions clearly, then runs the same verified parse Deploy uses on the rewrite. A pass returns
 * the stored draft, so Deploy reuses it at once; a rule problem comes back as text to fix before deploying.
 */
export async function refineStrategy(raw: unknown): Promise<AgentResult<StrategyRefinement>> {
  return agentAction(async () => {
    const user = await agentUser("parse");
    const input = parseStrategyInputSchema.parse(raw);
    if (!isActiveAgentTool(input.pack)) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    const text = await refineStrategyText(input.pack, input.strategyText, input.budget?.assetId);
    try {
      const draft = await prepareStrategyDraft(user.id, { ...input, strategyText: text });
      return { text, draft: await withAssets(draft), problem: null };
    } catch (error) {
      if (error instanceof AgentError && error.code === "invalid_input") {
        return { text, draft: null, problem: error.message };
      }
      throw error;
    }
  });
}
