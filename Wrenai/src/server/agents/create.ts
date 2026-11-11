import "server-only";
import { and, eq } from "drizzle-orm";
import { agents, strategyDrafts } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { instructionRouteTokens } from "@/server/execution/asset-review";
import { intentTokens } from "@/server/research/intents";
import { isActiveAgentTool, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import { type AgentResult, saveAgentWithBudgetSchema, strategySchema } from "@/shared/agents";
import { agentAction, agentUser } from "./action-result";
import { AgentError } from "./errors";
import { recoverCreatedAgent, saveAgentWithBudget } from "./simple-setup";
import { prepareAgentBudget } from "./token-budgets";

/** The created agent's identity and revision, so Deploy can fund and start it without reloading the page. */
export interface CreatedAgent {
  readonly agentId: string;
  readonly revision: number;
}

async function created(userId: string, agentId: string): Promise<CreatedAgent> {
  const [row] = await database()
    .select({ revision: agents.revision })
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.id, agentId)))
    .limit(1);
  if (!row) {
    throw new AgentError("not_found", "The new agent could not be found. Refresh and check your agents.");
  }
  return { agentId, revision: row.revision };
}

/**
 * Saves the reviewed agent with its exact wallet reservation. The token identities and the wallet balance are
 * independent reads, so they run together before the owner lock; the page is not re-rendered.
 */
export async function createAgent(raw: unknown): Promise<AgentResult<CreatedAgent>> {
  return agentAction(async () => {
    const user = await agentUser("manage");
    const input = saveAgentWithBudgetSchema.parse(raw);
    const recovered = await recoverCreatedAgent(database(), user.id, input);
    if (recovered) {
      return created(user.id, recovered);
    }
    const [draft] = await database()
      .select({ pack: strategyDrafts.pack, configJson: strategyDrafts.configJson })
      .from(strategyDrafts)
      .where(and(eq(strategyDrafts.userId, user.id), eq(strategyDrafts.id, input.draftId)))
      .limit(1);
    if (!draft) {
      throw new AgentError("not_found", "The strategy review could not be found.");
    }
    if (!isActiveAgentTool(draft.pack)) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    if (!input.budget) {
      throw new AgentError("invalid_input", "Choose the token and amount for this agent.");
    }
    const strategy = strategySchema.parse(JSON.parse(draft.configJson));
    const [tokens, prepared] = await Promise.all([
      "format" in strategy ? instructionRouteTokens(strategy) : intentTokens().then((read) => read.tokens),
      prepareAgentBudget(database(), user.id, input.budget),
    ]);
    return created(
      user.id,
      await saveAgentWithBudget(database(), user.id, input, tokens, undefined, prepared),
    );
  });
}
