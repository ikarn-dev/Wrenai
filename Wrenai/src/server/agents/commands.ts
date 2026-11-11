import "server-only";
import { start } from "workflow/api";
import { z } from "zod";
import type { SessionUser } from "@/server/auth/session";
import { assertWalletPayoutToken } from "@/server/claims/payout-token";
import { database } from "@/server/db/client";
import { startAgentRuntime } from "@/server/engine/start";
import { ExecutionError } from "@/server/execution/contracts";
import { isActiveAgentTool, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import { type AgentCommandResult, type AgentResult, agentCommandSchema } from "@/shared/agents";
import { runAgentReturn } from "@/workflows/agent-return";
import { agentAction, agentUser } from "./action-result";
import { deleteIfNothingHeld } from "./agent-return";
import { AgentError } from "./errors";
import { commandAgent, readAgent, setGlobalStop } from "./mutations";
import { assertAgentReady } from "./readiness";

/** Start, pause, stop or delete an agent. Starting checks that it is funded, authorized and ready first. */
export async function runAgentCommand(raw: unknown): Promise<AgentResult<AgentCommandResult>> {
  return agentAction(async () => {
    const user = await agentUser("manage");
    const input = agentCommandSchema.parse(raw);
    if (input.command === "clone") {
      throw new AgentError(
        "not_ready",
        "Create a new setup with its own token budget before duplicating this agent.",
      );
    }
    if (input.command === "resume") {
      const agent = await readAgent(database(), user.id, input.agentId);
      if (!isActiveAgentTool(agent.pack)) {
        throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
      }
      if (agent.returningFunds || agent.deleting) {
        throw new AgentError("conflict", "This agent is deleted or its funds are being claimed.");
      }
      await assertAgentReady(user, agent);
      return { agentId: await startAgentRuntime(database(), user.id, input), deleted: false };
    }
    if (input.receiveAssetId !== undefined && input.receiveAssetId !== "held") {
      // Before the claim is recorded, so a token the wallet can't receive never strands the return.
      await assertWalletPayoutToken(user.accountId, input.receiveAssetId);
    }
    const agentId = await commandAgent(database(), user.id, input);
    if (input.command !== "delete" && input.command !== "claim") {
      return { agentId, deleted: false };
    }
    if (input.command === "delete" && (await deletedAtOnce(user, agentId))) {
      return { agentId, deleted: true };
    }
    // A durable workflow settles pending orders, then sends a claim's funds or finishes the delete.
    await start(runAgentReturn, [user.id, agentId, crypto.randomUUID(), 0]);
    return { agentId, deleted: false };
  });
}

/**
 * The fast path of Delete: deletes now when nothing is held, reserved or arriving. The delete is already
 * committed, so a provider or validation failure here must not stop the return workflow from starting; it is
 * not swallowed, because the workflow runs the same settlement step, retries it and records the reason on the
 * agent (advanceAgentReturn). Any other error still fails the request.
 */
async function deletedAtOnce(user: SessionUser, agentId: string): Promise<boolean> {
  try {
    return await deleteIfNothingHeld(database(), user, agentId);
  } catch (error) {
    if (error instanceof ExecutionError || error instanceof AgentError || error instanceof z.ZodError) {
      return false;
    }
    throw error;
  }
}

/** The kill switch: engaging is never rate-limited; clearing it leaves every agent paused. */
export async function setStop(raw: unknown): Promise<AgentResult<null>> {
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
    return null;
  });
}
