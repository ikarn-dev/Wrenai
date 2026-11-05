import "server-only";

import { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import { currentUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentRuntimeStatus } from "@/shared/agent-runtime";
import type { AgentResult } from "@/shared/agents";
import { agentRuntimeStatus, reconcileAgentOrders } from "./status";

async function runtimeAction(raw: unknown, recover: boolean): Promise<AgentResult<AgentRuntimeStatus>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in to view trading status." };
  }
  const rate = await consumeRateLimit(
    `agent-runtime:${recover ? "recover" : "read"}:${user.id}`,
    recover ? 10 : 30,
    60_000,
  );
  if (rate !== "allowed") {
    return {
      ok: false,
      code: rate === "limited" ? "rate_limited" : "unavailable",
      message: "Trading status is unavailable. Try again shortly.",
    };
  }
  const input = z.strictObject({ agentId: z.uuid() }).safeParse(raw);
  if (!input.success) {
    return { ok: false, code: "invalid_input", message: "Choose a valid agent." };
  }
  try {
    const db = database();
    if (recover) {
      await reconcileAgentOrders(db, user.id, input.data.agentId);
    }
    return { ok: true, value: await agentRuntimeStatus(db, user.id, input.data.agentId) };
  } catch (error) {
    if (error instanceof AgentError || error instanceof ExecutionError) {
      return {
        ok: false,
        code: error.code === "not_found" ? "not_found" : "not_ready",
        message: error.message,
      };
    }
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        code: "not_ready",
        message: "The provider response could not be verified. Funds remain reserved.",
      };
    }
    return {
      ok: false,
      code: "unavailable",
      message: recover
        ? "The order status could not be confirmed. Unresolved funds remain reserved; try reconciliation again."
        : "Trading status could not be refreshed. Try again shortly.",
    };
  }
}

export async function readAgentRuntimeStatus(raw: unknown): Promise<AgentResult<AgentRuntimeStatus>> {
  return runtimeAction(raw, false);
}

export async function recoverAgentRuntime(raw: unknown): Promise<AgentResult<AgentRuntimeStatus>> {
  return runtimeAction(raw, true);
}
