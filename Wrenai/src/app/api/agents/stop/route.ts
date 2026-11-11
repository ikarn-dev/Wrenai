import { setStop } from "@/server/agents/commands";
import { agentPost } from "@/server/http/agent-route";

export const runtime = "nodejs";

/** Stop all agents, or clear the stop. A route rather than a Server Action, so the page isn't re-rendered. */
export async function POST(request: Request): Promise<Response> {
  return agentPost(request, setStop);
}
