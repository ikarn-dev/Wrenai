import "server-only";
import { mainnetBudgetName, refineStrategyText } from "@/server/ai/strategy-refiner";
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
 * Rewrites the instructions clearly and returns only the text. Nothing is parsed, checked or saved: the verified
 * parse runs once, when the user continues, on whatever text they settle on.
 */
export async function refineStrategy(raw: unknown): Promise<AgentResult<StrategyRefinement>> {
  return agentAction(async () => {
    await agentUser("parse");
    const input = parseStrategyInputSchema.parse(raw);
    if (!isActiveAgentTool(input.pack)) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    const symbol = mainnetBudgetName(input.budget?.assetId);
    return refineStrategyText(input.pack, input.strategyText, {
      budget: symbol ? { symbol, amount: input.budget?.amount || null } : null,
      network: "mainnet",
    });
  });
}
