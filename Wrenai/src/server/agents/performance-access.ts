import "server-only";
import { z } from "zod";
import { currentUser } from "@/server/auth/session";
import { readAgentPerformance } from "@/server/claims/pending";
import { database } from "@/server/db/client";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentPerformance } from "@/shared/agent-performance";
import type { AgentResult } from "@/shared/agents";

/** The signed-in owner's agent result for its page. Read-only; polled while the page is open. */
export async function readAgentPerformanceAccess(raw: unknown): Promise<AgentResult<AgentPerformance>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in to view this agent." };
  }
  const rate = await consumeRateLimit(`agent-performance:${user.id}`, 30, 60_000);
  if (rate !== "allowed") {
    return {
      ok: false,
      code: rate === "limited" ? "rate_limited" : "unavailable",
      message: "PnL is unavailable. Try again shortly.",
    };
  }
  const input = z.strictObject({ agentId: z.uuid() }).safeParse(raw);
  if (!input.success) {
    return { ok: false, code: "invalid_input", message: "Choose a valid agent." };
  }
  try {
    return { ok: true, value: await readAgentPerformance(database(), user.id, input.data.agentId) };
  } catch (error) {
    // A display read: the page keeps the last figures and says they couldn't refresh.
    return {
      ok: false,
      code: "unavailable",
      message:
        error instanceof z.ZodError
          ? "A recorded amount could not be read."
          : "PnL could not be refreshed. Try again shortly.",
    };
  }
}
