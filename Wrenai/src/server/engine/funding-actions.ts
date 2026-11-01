"use server";
import { refresh } from "next/cache";
import { z } from "zod";
import { currentUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentResult } from "@/shared/agents";
import { allocatePreviewBalance } from "./funding";

export async function allocateAgentBalance(raw: unknown): Promise<AgentResult<null>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in to allocate trading funds." };
  }
  const rate = await consumeRateLimit(`agent-funding:${user.id}`, 10, 60_000);
  if (rate !== "allowed") {
    return {
      ok: false,
      code: rate === "limited" ? "rate_limited" : "unavailable",
      message: "Allocation requests are unavailable. Try again shortly.",
    };
  }
  try {
    await allocatePreviewBalance(database(), user.id, raw);
    refresh();
    return { ok: true, value: null };
  } catch (error) {
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
        message: "Check the capital limits and request a fresh preview.",
      };
    }
    throw error;
  }
}
