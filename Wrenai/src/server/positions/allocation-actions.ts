"use server";
import { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentResult } from "@/shared/agents";
import type { AgentAllocationView } from "@/shared/allocation";
import { manageAgentAllocation, readAgentAllocations } from "./allocation-management";

async function protectedAllocation<T>(run: (user: SessionUser) => Promise<T>): Promise<AgentResult<T>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in to manage allocations." };
  }
  const rate = await consumeRateLimit(`allocations:${user.id}`, 20, 60_000);
  if (rate !== "allowed") {
    return {
      ok: false,
      code: rate === "limited" ? "rate_limited" : "unavailable",
      message: "Allocation requests are unavailable. Try again shortly.",
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
      return { ok: false, code: "invalid_input", message: "Check the token amount and refresh allocations." };
    }
    return {
      ok: false,
      code: "unavailable",
      message: "Allocations could not be verified. No unconfirmed funds are released.",
    };
  }
}
export async function loadAgentAllocations(raw: unknown): Promise<AgentResult<AgentAllocationView>> {
  return protectedAllocation((user) =>
    readAgentAllocations(database(), user.id, z.strictObject({ agentId: z.uuid() }).parse(raw).agentId),
  );
}
export async function changeAgentAllocation(raw: unknown): Promise<AgentResult<null>> {
  return protectedAllocation(async (user) => {
    await manageAgentAllocation(database(), user, raw);
    return null;
  });
}
