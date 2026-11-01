import "server-only";
import { start } from "workflow/api";
import type { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import type { AppDatabase } from "@/server/db/client";
import type { agentCommandSchema } from "@/shared/agents";
import { runTradingAgent } from "@/workflows/trading";
import { prepareAgentRuntime } from "./runtime";

export async function startAgentRuntime(
  db: AppDatabase,
  userId: string,
  input: z.infer<typeof agentCommandSchema>,
): Promise<string> {
  const activationId = await prepareAgentRuntime(db, userId, input);
  try {
    await start(runTradingAgent, [activationId, 0]);
  } catch {
    throw new AgentError(
      "unavailable",
      "The trading workflow could not be queued. Retry to recover the same activation request.",
    );
  }
  return input.agentId;
}
