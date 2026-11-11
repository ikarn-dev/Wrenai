import { isActiveAgentTool } from "./agent-scope";
import { type AgentSummary, packSchema } from "./agents";
import { researchToolSchema } from "./research";

/** What the Agents page's create dialog opens with: a chosen agent type and starting instructions. */
export interface CreateAgentRequest {
  readonly pack: AgentSummary["pack"];
  readonly brief: string;
}

/** `?create=agent` opens the dialog without a chosen type. */
export const ANY_AGENT_TYPE = "agent";
const DEFAULT_PACK: AgentSummary["pack"] = "spot_trader";

/** Identifies one opening of the dialog, so a repeated link reopens it and a re-render does not. */
export function createRequestKey(request: CreateAgentRequest): string {
  return `tool:${request.pack}:${request.brief}`;
}

/** The pack a `?create=` value opens, or null for an unknown or inactive type. */
export function createRequestPack(value: unknown): AgentSummary["pack"] | null {
  if (value === ANY_AGENT_TYPE) {
    return DEFAULT_PACK;
  }
  const tool = researchToolSchema.safeParse(value);
  if (!tool.success || !isActiveAgentTool(tool.data)) {
    return null;
  }
  const pack = packSchema.safeParse(tool.data);
  return pack.success ? pack.data : null;
}

/** Manual trades and briefs need server reads; a bare `?create=<type>` opens in the browser. */
export function needsServerRequest(query: { readonly get: (name: string) => string | null }): boolean {
  return query.get("manual") !== null || query.get("brief") !== null;
}
