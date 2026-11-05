import "server-only";
import { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentResult } from "@/shared/agents";

export async function fundingAction<T>(run: (user: SessionUser) => Promise<T>): Promise<AgentResult<T>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in to fund your agent." };
  }
  const rate = await consumeRateLimit(`wallet-funding:${user.id}`, 30, 60000);
  if (rate !== "allowed") {
    return {
      ok: false,
      code: rate === "limited" ? "rate_limited" : "unavailable",
      message: "Funding requests are unavailable. Try again shortly.",
    };
  }
  try {
    return { ok: true, value: await run(user) };
  } catch (error) {
    if (error instanceof AgentError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof ExecutionError) {
      return {
        ok: false,
        code: error.code === "not_found" ? "not_found" : "not_ready",
        message: error.message,
      };
    }
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        code: "invalid_input",
        message: "The deposit data could not be verified. Check the token amount and transaction hash.",
      };
    }
    return {
      ok: false,
      code: "unavailable",
      message: "Funding could not be confirmed. Check its status before sending again.",
    };
  }
}
