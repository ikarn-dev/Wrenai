import type { AgentFailureCode, AgentResult } from "@/shared/agents";

export class AgentError extends Error {
  constructor(
    readonly code: AgentFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function agentFailure(error: AgentError): AgentResult<never> {
  return { ok: false, code: error.code, message: error.message };
}
