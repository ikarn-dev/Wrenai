"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { strategyDrafts } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { startAgentRuntime } from "@/server/engine/start";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { intentTokens } from "@/server/research/intents";
import { isActiveAgentTool, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import {
  type AgentResult,
  agentCommandSchema,
  parseStrategyInputSchema,
  type StrategyDraft,
  saveAgentSchema,
  saveAgentWithBudgetSchema,
} from "@/shared/agents";
import { parseTokenAmount } from "@/shared/token-units";
import { prepareStrategyDraft } from "./drafts";
import { AgentError, agentFailure } from "./errors";
import { commandAgent, readAgent, saveAgent, setGlobalStop } from "./mutations";
import { assertAgentReady } from "./readiness";
import { recoverCreatedAgent, saveAgentWithBudget } from "./simple-setup";
import { prepareAgentBudget } from "./token-budgets";

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
    const input = parseStrategyInputSchema.parse(raw);
    if (!isActiveAgentTool(input.pack)) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    if (input.budget) {
      const prepared = await prepareAgentBudget(database(), user.id, input.budget),
        holding = prepared.holding;
      const units = parseTokenAmount(input.budget.amount, holding.decimals).toString();
      const text = `${input.strategyText}\nSpending budget: ${input.budget.amount} ${holding.symbol}; exact wallet asset ${holding.assetId}; decimals ${holding.decimals}; smallest units ${units}. Native NEAR maps to nep141:wrap.near. This identifies the spending token only; do not invent the receiving token or other strategy conditions.`;
      return prepareStrategyDraft(user.id, parseStrategyInputSchema.parse({ ...input, strategyText: text }));
    }
    return prepareStrategyDraft(user.id, input);
  });
}

export async function saveAgentStrategy(raw: unknown): Promise<AgentResult<{ readonly agentId: string }>> {
  return agentAction(async () => {
    const user = await agentUser("manage");
    const input = saveAgentSchema.parse(raw);
    const [draft] = await database()
      .select({ pack: strategyDrafts.pack })
      .from(strategyDrafts)
      .where(and(eq(strategyDrafts.id, input.draftId), eq(strategyDrafts.userId, user.id)))
      .limit(1);
    if (!draft) {
      throw new AgentError("not_found", "The strategy review could not be found.");
    }
    if (draft && !isActiveAgentTool(draft.pack)) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    const tokens = (await intentTokens()).tokens;
    const agentId = await saveAgent(database(), user.id, input, undefined, tokens);
    refresh();
    return { agentId };
  });
}

export async function createAgentWithBudget(
  raw: unknown,
): Promise<AgentResult<{ readonly agentId: string }>> {
  return agentAction(async () => {
    const user = await agentUser("manage"),
      input = saveAgentWithBudgetSchema.parse(raw);
    const recovered = await recoverCreatedAgent(database(), user.id, input);
    if (recovered) {
      refresh();
      return { agentId: recovered };
    }
    const [draft] = await database()
      .select({ pack: strategyDrafts.pack })
      .from(strategyDrafts)
      .where(and(eq(strategyDrafts.userId, user.id), eq(strategyDrafts.id, input.draftId)))
      .limit(1);
    if (!draft) {
      throw new AgentError("not_found", "The strategy review could not be found.");
    }
    if (!isActiveAgentTool(draft.pack)) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    const tokens = (await intentTokens()).tokens;
    const agentId = await saveAgentWithBudget(database(), user.id, input, tokens);
    refresh();
    return { agentId };
  });
}

export async function manageAgent(raw: unknown): Promise<AgentResult<{ readonly agentId: string }>> {
  return agentAction(async () => {
    const user = await agentUser("manage");
    const input = agentCommandSchema.parse(raw);
    if (
      (input.command === "resume" || input.command === "clone") &&
      !isActiveAgentTool((await readAgent(database(), user.id, input.agentId)).pack)
    ) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    if (input.command === "resume") {
      await assertAgentReady(user, await readAgent(database(), user.id, input.agentId));
    }
    if (input.command === "clone") {
      throw new AgentError(
        "not_ready",
        "Create a new setup with its own token budget before duplicating this agent.",
      );
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
