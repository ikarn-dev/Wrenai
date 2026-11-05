import type { AgentBudgetInput } from "./agent-budget";
import type { AgentSummary } from "./agents";

/**
 * What the Agents page's create dialog opens with: a chosen agent type and starting brief, or a saved setup bound
 * to the hash it was reviewed under.
 */
export interface CreateAgentRequest {
  readonly pack: AgentSummary["pack"];
  readonly brief: string;
  readonly setup: {
    readonly id: string;
    readonly hash: string;
    readonly budget: AgentBudgetInput | null;
  } | null;
}

/** `?create=agent` opens the dialog without a chosen type. */
export const ANY_AGENT_TYPE = "agent";

/** Identifies one opening of the dialog, so a repeated link reopens it and a re-render does not. */
export function createRequestKey(request: CreateAgentRequest): string {
  return request.setup ? `setup:${request.setup.id}` : `tool:${request.pack}:${request.brief}`;
}
