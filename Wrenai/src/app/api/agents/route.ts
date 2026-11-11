import { createAgent } from "@/server/agents/create";
import { listAgentCards, readTradingControls } from "@/server/agents/records";
import { currentUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { agentFailureResponse, agentPost } from "@/server/http/agent-route";
import type { AgentList } from "@/shared/agents";

export const runtime = "nodejs";

/** The Agents list and the global stop state, for refreshing the list in place after a change. */
export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) {
    return agentFailureResponse("signed_out", "Sign in again to see your agents.");
  }
  const db = database();
  const [agents, stop] = await Promise.all([listAgentCards(db, user.id), readTradingControls(db, user.id)]);
  const value: AgentList = { agents, stop };
  return Response.json({ ok: true, value }, { headers: { "Cache-Control": "private, no-store" } });
}

/** Creates the reviewed agent with its wallet reservation. Idempotent per request ID. */
export async function POST(request: Request): Promise<Response> {
  return agentPost(request, createAgent);
}
