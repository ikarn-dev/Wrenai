"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { AgentError, agentFailure } from "@/server/agents/errors";
import { currentUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentResult } from "@/shared/agents";
import type { UserRiskPolicyRecord } from "@/shared/risk-policy";
import { readUserRiskPolicy, setUserRiskPolicy } from "./user-policy";

async function riskAction<T>(run: (userId: string) => Promise<T>): Promise<AgentResult<T>> {
  try {
    const user = await currentUser();
    if (user === null) {
      throw new AgentError("signed_out", "Sign in again to manage your trading limits.");
    }
    const decision = await consumeRateLimit(`agents:manage:${user.id}`, 30, 60_000);
    if (decision !== "allowed") {
      throw new AgentError(
        decision === "limited" ? "rate_limited" : "unavailable",
        decision === "limited"
          ? "Too many requests. Wait a minute and try again."
          : "Request protection is unavailable. Try again shortly.",
      );
    }
    return { ok: true, value: await run(user.id) };
  } catch (error) {
    if (error instanceof AgentError) {
      return agentFailure(error);
    }
    if (error instanceof z.ZodError) {
      return agentFailure(
        new AgentError("invalid_input", error.issues[0]?.message ?? "Check your limits and try again."),
      );
    }
    throw error;
  }
}

export async function readAccountRiskPolicy(raw: unknown): Promise<AgentResult<UserRiskPolicyRecord | null>> {
  return riskAction(async (userId) => {
    z.strictObject({}).parse(raw);
    return readUserRiskPolicy(database(), userId);
  });
}

export async function saveAccountRiskPolicy(raw: unknown): Promise<AgentResult<UserRiskPolicyRecord>> {
  return riskAction(async (userId) => {
    const saved = await setUserRiskPolicy(database(), userId, raw);
    refresh();
    return saved;
  });
}
