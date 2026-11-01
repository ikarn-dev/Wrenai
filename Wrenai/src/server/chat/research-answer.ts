import "server-only";
import type { AttestationReceipt } from "@/server/ai/attestation-receipt";
import { type ToolChatMessage, verifiedChatStream } from "@/server/ai/verified-chat-stream";
import { InferenceError } from "@/server/ai/verified-completion";
import { RESEARCH_DEFINITIONS, runResearchTool } from "@/server/research/dispatcher";
import type { ChatEvent } from "@/shared/chat";
import type { ResearchReport } from "@/shared/research";

export async function researchAnswer(
  initial: readonly ToolChatMessage[],
  signal: AbortSignal,
  emit: (event: ChatEvent) => void,
): Promise<{ content: string; receipt: AttestationReceipt; reports: ResearchReport[] }> {
  const messages = [...initial];
  const reports: ResearchReport[] = [];
  // Two bounded research rounds, at most three public reads each; never expose execution tools.
  for (let round = 0; round <= 2; round += 1) {
    signal.throwIfAborted();
    const completion = await verifiedChatStream({
      messages,
      tools: RESEARCH_DEFINITIONS,
      signal,
      allowTools: round < 2,
      onDelta: (text) => emit({ type: "delta", text }),
    });
    if (!completion.calls.length) {
      return { content: completion.content, receipt: completion.receipt, reports };
    }
    if (round === 2 || completion.calls.length > 3 || completion.calls.some((call) => !call.id)) {
      throw new InferenceError(
        "invalid_input",
        "The research request exceeded its limits. Ask a narrower question.",
      );
    }
    // Tool calls are verified before dispatch. Intermediate narration is not the final answer.
    emit({ type: "reset" });
    emit({ type: "status", message: "Checking live sources…" });
    messages.push({
      role: "assistant",
      content: completion.content || null,
      tool_calls: [...completion.calls],
    });
    const results = await Promise.all(
      completion.calls.map(async (call) => ({
        call,
        report: await runResearchTool(call.function.name, call.function.arguments, signal),
      })),
    );
    signal.throwIfAborted();
    for (const { call, report } of results) {
      reports.push(report);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(report) });
    }
    emit({ type: "research", reports });
    emit({ type: "status", message: "Writing answer · verification pending" });
  }
  throw new InferenceError("unavailable", "The research answer could not be completed.");
}
