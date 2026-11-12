import { z } from "zod";
import { refineStrategy, reviewStrategy } from "@/server/agents/review";
import { agentPost } from "@/server/http/agent-route";
import type { StrategyDraft, StrategyRefinement } from "@/shared/agents";

export const runtime = "nodejs";
// One attested parse (review) or one rewrite (refine); each inference call is bounded at 90 seconds.
export const maxDuration = 120;

const envelope = z.object({ mode: z.enum(["review", "refine"]), input: z.unknown() });

/** Strategy review and Refine. Review parses the rules; Refine only rewrites the text. */
export async function POST(request: Request): Promise<Response> {
  return agentPost<StrategyDraft | StrategyRefinement>(request, async (body) => {
    const parsed = envelope.safeParse(body);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: "The request could not be read. Try again." };
    }
    return parsed.data.mode === "refine"
      ? refineStrategy(parsed.data.input)
      : reviewStrategy(parsed.data.input);
  });
}
