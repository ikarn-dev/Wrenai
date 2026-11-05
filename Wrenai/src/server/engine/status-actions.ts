"use server";

import type { AgentRuntimeStatus } from "@/shared/agent-runtime";
import type { AgentResult } from "@/shared/agents";
import { recoverAgentRuntime } from "./status-access";

export async function recoverAgentOrders(raw: unknown): Promise<AgentResult<AgentRuntimeStatus>> {
  return recoverAgentRuntime(raw);
}
