import "server-only";
import { z } from "zod";
import { nearAiKeys } from "@/server/env";
import { APPROVED_MODELS } from "@/shared/ai-models";
import type { AttestationReceipt } from "./attestation-receipt";
import { inferenceClient } from "./inference-client";
import {
  canRotateKey,
  InferenceError,
  inferenceFailure,
  verifyInferenceReceipt,
} from "./verified-completion";

export interface ChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}
export interface ChatToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly strict: boolean;
  };
}
export type ToolChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: ChatToolCall[] }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

const chunkSchema = z.object({
  id: z.string().min(1).max(200),
  choices: z
    .array(
      z.object({
        delta: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                index: z.number().int().min(0).max(2),
                id: z.string().max(200).nullable().optional(),
                type: z.literal("function").nullable().optional(),
                function: z
                  .object({
                    name: z.string().max(100).nullable().optional(),
                    arguments: z.string().nullable().optional(),
                  })
                  .nullable()
                  .optional(),
              }),
            )
            .max(3)
            .nullable()
            .optional(),
        }),
        finish_reason: z.enum(["stop", "length", "tool_calls", "content_filter", "function_call"]).nullable(),
      }),
    )
    .max(1),
});

interface StreamRequest {
  readonly messages: readonly ToolChatMessage[];
  readonly tools: readonly ChatToolDefinition[];
  readonly signal: AbortSignal;
  readonly allowTools: boolean;
  readonly json?: boolean;
  readonly maxTokens?: number;
  readonly onDelta: (text: string) => void;
  readonly onVerification?: () => void;
}
export interface VerifiedChatStream {
  readonly content: string;
  readonly calls: readonly ChatToolCall[];
  readonly receipt: AttestationReceipt;
}

async function attemptStream(
  apiKey: string,
  model: (typeof APPROVED_MODELS)[number],
  request: StreamRequest,
  received: () => void,
): Promise<VerifiedChatStream> {
  const client = inferenceClient(apiKey, true);
  const stream = await client.chat.completions.create(
    {
      model,
      stream: true,
      temperature: 0,
      max_tokens: request.maxTokens ?? 4_000,
      ...(request.json ? { response_format: { type: "json_object" as const } } : {}),
      messages: [...request.messages],
      ...(request.allowTools && request.tools.length
        ? { tools: [...request.tools], tool_choice: "auto" }
        : {}),
    },
    { signal: request.signal, timeout: 90_000, maxRetries: 0 },
  );
  let id: string | null = null;
  let content = "";
  let finish: string | null = null;
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const raw of stream) {
    request.signal.throwIfAborted();
    received();
    const chunk = chunkSchema.parse(raw);
    if (id !== null && id !== chunk.id) {
      throw new InferenceError("verification_failed", "The response identity changed during streaming.");
    }
    id = chunk.id;
    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }
    if (choice.delta.content) {
      content += choice.delta.content;
      if (content.length > 32_000) {
        stream.controller.abort();
        throw new InferenceError("invalid_input", "The answer is too long. Ask a smaller question.");
      }
      request.onDelta(choice.delta.content);
    }
    for (const delta of choice.delta.tool_calls ?? []) {
      const call = calls.get(delta.index) ?? { id: "", name: "", args: "" };
      call.id = delta.id ?? call.id;
      call.name += delta.function?.name ?? "";
      call.args += delta.function?.arguments ?? "";
      if (call.args.length > 8_000 || call.name.length > 100) {
        stream.controller.abort();
        throw new InferenceError("invalid_input", "The research request is too large.");
      }
      calls.set(delta.index, call);
    }
    finish = choice.finish_reason ?? finish;
  }
  if (!id || !["stop", "tool_calls"].includes(finish ?? "")) {
    throw new InferenceError("invalid_input", "The answer was interrupted. Try a shorter request.");
  }
  let onAbort: (() => void) | undefined;
  request.onVerification?.();
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new InferenceError("cancelled", "Reply stopped or exceeded its time limit."));
    if (request.signal.aborted) {
      onAbort();
    } else {
      request.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  let receipt: AttestationReceipt;
  try {
    receipt = await Promise.race([verifyInferenceReceipt(client, id, model), aborted]);
  } finally {
    if (onAbort) {
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  const toolCalls: ChatToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([_index, call]) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.args },
    }));
  if (
    (finish === "tool_calls" && !toolCalls.length) ||
    (finish === "stop" && (!content.trim() || toolCalls.length))
  ) {
    throw new InferenceError("invalid_input", "The model returned an incomplete research response.");
  }
  return { content, calls: toolCalls, receipt };
}

/** Chunks are explicitly provisional. The result is returned only after complete model-bound signature verification. */
export async function verifiedChatStream(request: StreamRequest): Promise<VerifiedChatStream> {
  let keys: readonly string[];
  try {
    keys = nearAiKeys();
  } catch {
    throw new InferenceError("unavailable", "NEAR AI chat is not configured.");
  }
  for (const model of APPROVED_MODELS) {
    for (const key of keys) {
      request.signal.throwIfAborted();
      let received = false;
      try {
        return await attemptStream(key, model, request, () => {
          received = true;
        });
      } catch (error) {
        if (request.signal.aborted) {
          throw new InferenceError("cancelled", "Reply stopped.");
        }
        if (error instanceof InferenceError) {
          throw error;
        }
        if (!received && canRotateKey(error)) {
          continue;
        }
        throw inferenceFailure(error, "request");
      }
    }
  }
  throw new InferenceError("unavailable", "The approved models are unavailable. Try again shortly.");
}
