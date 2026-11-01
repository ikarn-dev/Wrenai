"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { startAgentRuntime } from "@/server/engine/start";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import {
  type AgentResult,
  agentCommandSchema,
  parseStrategyInputSchema,
  type StrategyDraft,
  saveAgentSchema,
} from "@/shared/agents";
import { prepareStrategyDraft } from "./drafts";
import { AgentError, agentFailure } from "./errors";
import { commandAgent, readAgent, saveAgent, setGlobalStop } from "./mutations";
import { assertAgentReady } from "./readiness";

async function agentUser(kind: "parse" | "manage" | "stop"): Promise<SessionUser> {
  const user = await currentUser();
  if (user === null) {
    throw new AgentError("signed_out", "Sign in again to manage agents.");
  }
  if (kind !== "stop") {
    const decision = await consumeRateLimit(`agents:${kind}:${user.id}`, kind === "parse" ? 4 : 30, 60_000);
    if (decision !== "allowed") {
      throw new AgentError(
        decision === "limited" ? "rate_limited" : "unavailable",
        decision === "limited"
          ? "Too many requests. Wait a minute and try again."
          : "Request protection is unavailable. Try again shortly.",
      );
    }
  }
  return user;
}

async function agentAction<T>(run: () => Promise<T>): Promise<AgentResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof AgentError) {
      return agentFailure(error);
    }
    if (error instanceof ExecutionError) {
      return agentFailure(new AgentError("not_ready", error.message));
    }
    if (error instanceof z.ZodError) {
      return agentFailure(
        new AgentError("invalid_input", error.issues[0]?.message ?? "Check the form and try again."),
      );
    }
    throw error;
  }
}

export async function parseAgentStrategy(raw: unknown): Promise<AgentResult<StrategyDraft>> {
  return agentAction(async () => {
    const user = await agentUser("parse");
    return prepareStrategyDraft(user.id, parseStrategyInputSchema.parse(raw));
  });
}

export async function saveAgentStrategy(raw: unknown): Promise<AgentResult<{ readonly agentId: string }>> {
  return agentAction(async () => {
    const user = await agentUser("manage");
    const agentId = await saveAgent(database(), user.id, saveAgentSchema.parse(raw));
    refresh();
    return { agentId };
  });
}

export async function manageAgent(raw: unknown): Promise<AgentResult<{ readonly agentId: string }>> {
  return agentAction(async () => {
    const user = await agentUser("manage");
    const input = agentCommandSchema.parse(raw);
    if (input.command === "resume") {
      await assertAgentReady(user, await readAgent(database(), user.id, input.agentId));
    }
    const agentId =
      input.command === "resume"
        ? await startAgentRuntime(database(), user.id, input)
        : await commandAgent(database(), user.id, input);
    refresh();
    return { agentId };
  });
}

export async function changeGlobalStop(raw: unknown): Promise<AgentResult<null>> {
  return agentAction(async () => {
    const input = z
      .strictObject({
        engaged: z.boolean(),
        requestId: z.uuid(),
        expectedRevision: z.number().int().nonnegative(),
      })
      .parse(raw);
    const user = await agentUser(input.engaged ? "stop" : "manage");
    await setGlobalStop(database(), user.id, input.engaged, input.requestId, input.expectedRevision);
    refresh();
    return null;
  });
}
