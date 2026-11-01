import "server-only";
import type { AttestationReceipt } from "@/server/ai/attestation-receipt";
import { type ToolChatMessage, verifiedChatStream } from "@/server/ai/verified-chat-stream";
import { InferenceError } from "@/server/ai/verified-completion";
import { RESEARCH_DEFINITIONS, runResearchTool } from "@/server/research/dispatcher";
import type { ChatEvent } from "@/shared/chat";
import { chatRoutingIssue, needsLiveResearch } from "@/shared/chat-routing";
import { chatStatus } from "@/shared/chat-status";
import { RESEARCH_TOOLS, type ResearchReport, type ResearchTool } from "@/shared/research";
import { isResearchClarification, parseResearchCalls } from "./research-calls";

export async function researchAnswer(
  initial: readonly ToolChatMessage[],
  signal: AbortSignal,
  emit: (event: ChatEvent) => void,
  selectedTool: ResearchTool | null = null,
): Promise<{ content: string; receipt: AttestationReceipt; reports: ResearchReport[] }> {
  const messages = [...initial];
  const reports: ResearchReport[] = [];
  const reads = new Map<string, Promise<ResearchReport>>();
  const reported = new Set<string>();
  const latest = initial.findLast((message) => message.role === "user")?.content ?? "";
  const routingIssue = chatRoutingIssue(latest, selectedTool);
  if (routingIssue) {
    throw new InferenceError("invalid_input", routingIssue);
  }
  const tools = selectedTool
    ? RESEARCH_DEFINITIONS.filter((definition) => definition.function.name === `research_${selectedTool}`)
    : RESEARCH_DEFINITIONS;
  // Two bounded research rounds, at most three public reads each; never expose execution tools.
  for (let round = 0; round <= 2; round += 1) {
    signal.throwIfAborted();
    emit({ type: "status", message: chatStatus(round === 0 ? "thinking" : "writing") });
    const completion = await verifiedChatStream({
      messages,
      tools,
      signal,
      allowTools: round < 2,
      onDelta: (text) => emit({ type: "delta", text }),
      onVerification: () => emit({ type: "status", message: chatStatus("verifying") }),
    });
    if (!completion.calls.length) {
      if (
        needsLiveResearch(latest, selectedTool) &&
        !reports.some((report) => report.status !== "unavailable" && report.items.length > 0) &&
        !isResearchClarification(completion.content)
      ) {
        throw new InferenceError(
          "unavailable",
          "No current results were retrieved for this request. Try again or choose Auto.",
        );
      }
      return { content: completion.content, receipt: completion.receipt, reports };
    }
    if (
      round === 2 ||
      completion.calls.length > 3 ||
      new Set(completion.calls.map((call) => call.id)).size !== completion.calls.length ||
      completion.calls.some(
        (call) => !call.id || !tools.some((definition) => definition.function.name === call.function.name),
      )
    ) {
      throw new InferenceError(
        "invalid_input",
        "The research request exceeded its limits. Ask a narrower question.",
      );
    }
    const planned = parseResearchCalls(completion.calls);
    // Tool calls are verified before dispatch. Intermediate narration is not the final answer.
    emit({ type: "reset" });
    emit({ type: "status", message: chatStatus("research") });
    messages.push({
      role: "assistant",
      content: completion.content || null,
      tool_calls: [...completion.calls],
    });
    const results = await Promise.all(
      planned.map(async (request) => {
        let pending = reads.get(request.key);
        if (!pending) {
          pending = runResearchTool(request.call.function.name, request.arguments, signal);
          reads.set(request.key, pending);
        }
        return { request, report: await pending };
      }),
    );
    signal.throwIfAborted();
    for (const { request, report } of results) {
      if (!reported.has(request.key)) {
        reported.add(request.key);
        reports.push(report);
      }
      messages.push({ role: "tool", tool_call_id: request.call.id, content: JSON.stringify(report) });
    }
    if (!reports.some((report) => report.status !== "unavailable" && report.items.length > 0)) {
      const missing = [...new Set(planned.map(({ tool }) => RESEARCH_TOOLS[tool].label))].join(", ");
      throw new InferenceError(
        "unavailable",
        `No usable live results were returned for ${missing}. Try again shortly.`,
      );
    }
    emit({ type: "research", reports });
    emit({ type: "status", message: chatStatus("writing") });
  }
  throw new InferenceError("unavailable", "The research answer could not be completed.");
}
