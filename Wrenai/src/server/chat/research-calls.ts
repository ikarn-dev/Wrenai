import "server-only";
import type { ChatToolCall } from "@/server/ai/verified-chat-stream";
import { InferenceError } from "@/server/ai/verified-completion";
import { type ResearchTool, researchInputSchema, researchToolSchema } from "@/shared/research";
import { researchInputIssue } from "@/shared/research-input";

export interface ResearchCall {
  readonly call: ChatToolCall;
  readonly tool: ResearchTool;
  readonly arguments: string;
  readonly key: string;
}

/** Validate the whole batch before starting any reads, so malformed companion calls cost no requests. */
export function parseResearchCalls(calls: readonly ChatToolCall[]): readonly ResearchCall[] {
  return calls.map((call) => {
    let value: unknown;
    try {
      value = JSON.parse(call.function.arguments);
    } catch {
      throw new InferenceError(
        "invalid_input",
        "The research inputs could not be read. Rephrase your request.",
      );
    }
    const tool = researchToolSchema.safeParse(call.function.name.replace(/^research_/, ""));
    const input = researchInputSchema.safeParse(value);
    if (!tool.success || !input.success) {
      throw new InferenceError(
        "invalid_input",
        "Specify the public assets, account and amount unit needed for this request.",
      );
    }
    const issue = researchInputIssue(tool.data, input.data);
    if (issue) {
      throw new InferenceError("invalid_input", issue);
    }
    const args = JSON.stringify(input.data);
    return { call, tool: tool.data, arguments: args, key: `${tool.data}:${args}` };
  });
}

/** A missing-input question is useful without market data; unsupported market conclusions are not. */
export function isResearchClarification(content: string): boolean {
  const text = content.trim();
  return (
    text.length <= 240 &&
    !/[\n.!]/.test(text) &&
    (/^(?:which|what)\b[^?]*\b(?:market|asset|token|pair|account|recipient|amount|time horizon|tool)\b[^?]*\?$/i.test(
      text,
    ) ||
      /^how much\b[^?]*\?$/i.test(text))
  );
}
