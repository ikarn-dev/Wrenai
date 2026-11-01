"use server";
import { z } from "zod";
import { AgentError, agentFailure } from "@/server/agents/errors";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentResult } from "@/shared/agents";
import type { RecoveryChallenge, RecoveryExport, TradingAccountSummary } from "@/shared/trading-recovery";
import { confirmTradingBackup, exportTradingRecovery, issueRecoveryChallenge } from "./recovery";
import { tradingAccountSummary } from "./vault";

async function recoveryAction<T>(run: (user: SessionUser) => Promise<T>): Promise<AgentResult<T>> {
  const user = await currentUser();
  if (!user) {
    return agentFailure(new AgentError("signed_out", "Sign in to manage account recovery."));
  }
  const rate = await consumeRateLimit(`trading-recovery:${user.id}`, 10, 60_000);
  if (rate !== "allowed") {
    return agentFailure(
      new AgentError(
        rate === "limited" ? "rate_limited" : "unavailable",
        "Recovery requests are unavailable. Try again shortly.",
      ),
    );
  }
  try {
    return { ok: true, value: await run(user) };
  } catch (error) {
    if (error instanceof AgentError) {
      return agentFailure(error);
    }
    if (error instanceof ExecutionError) {
      return agentFailure(
        new AgentError(error.code === "not_found" ? "not_found" : "not_ready", error.message),
      );
    }
    if (error instanceof z.ZodError) {
      return agentFailure(new AgentError("invalid_input", "The recovery request could not be validated."));
    }
    throw error;
  }
}
export async function requestRecoveryBackup(raw: unknown): Promise<AgentResult<RecoveryChallenge>> {
  return recoveryAction((user) => issueRecoveryChallenge(database(), user, raw));
}
export async function exportRecoveryBackup(raw: unknown): Promise<AgentResult<RecoveryExport>> {
  return recoveryAction((user) => exportTradingRecovery(database(), user, raw));
}
export async function confirmRecoveryBackup(
  raw: unknown,
): Promise<AgentResult<TradingAccountSummary | null>> {
  return recoveryAction(async (user) => {
    await confirmTradingBackup(database(), user.id, raw);
    return tradingAccountSummary(database(), user.id);
  });
}
