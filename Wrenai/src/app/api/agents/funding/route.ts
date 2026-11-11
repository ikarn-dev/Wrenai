import { runFundingCommand } from "@/server/funding/actions";
import { agentPost } from "@/server/http/agent-route";

export const runtime = "nodejs";

/** A wallet funding step (review, deposit proof, tracking) without re-rendering the page that sent it. */
export async function POST(request: Request): Promise<Response> {
  return agentPost(request, runFundingCommand);
}
