import "server-only";
import { createHash } from "node:crypto";
import {
  getSdkError,
  type InferenceClient,
  isVerificationError,
  type VerifiedCompletionResult,
} from "@nearai/inference-sdk/node";
import { z } from "zod";
import { nearAiKeys } from "@/server/env";
import { APPROVED_MODELS } from "@/shared/ai-models";
import type { AttestationReceipt } from "./attestation-receipt";
import { inferenceClient } from "./inference-client";

const INFERENCE_TIMEOUT_MS = 90_000;

export class InferenceError extends Error {
  constructor(
    readonly code: "unavailable" | "verification_failed" | "invalid_input" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "InferenceError";
  }
}

export interface InferenceMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface CompletionRequest {
  readonly messages: readonly InferenceMessage[];
  readonly maxTokens: number;
  readonly json?: boolean;
  readonly signal?: AbortSignal;
  readonly verification?: "fresh" | "chat_cached";
}

export interface VerifiedCompletion {
  readonly content: string;
  readonly receipt: AttestationReceipt;
}

function keys(): readonly string[] {
  try {
    return nearAiKeys();
  } catch {
    throw new InferenceError("unavailable", "NEAR_AI_API_KEY is missing. AI responses are unavailable.");
  }
}

async function completeWithClient(
  apiKey: string,
  model: (typeof APPROVED_MODELS)[number],
  request: CompletionRequest,
  signal: AbortSignal,
): Promise<VerifiedCompletion> {
  const client = inferenceClient(apiKey, request.verification === "chat_cached");
  const completion = await client.chat.completions.create(
    {
      model,
      stream: false,
      temperature: 0,
      max_tokens: request.maxTokens,
      messages: [...request.messages],
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
    },
    { timeout: INFERENCE_TIMEOUT_MS, maxRetries: 0, signal },
  );
  const receipt = await verifyInferenceReceipt(client, completion.id, model);
  const content = completion.choices[0]?.message.content;
  if (completion.choices[0]?.finish_reason !== "stop" || typeof content !== "string" || !content.trim()) {
    throw new InferenceError("invalid_input", "The model did not return a complete answer. Try again.");
  }
  return { content, receipt };
}

export async function verifyInferenceReceipt(
  client: InferenceClient,
  id: string,
  model: (typeof APPROVED_MODELS)[number],
): Promise<AttestationReceipt> {
  const verification = await verifyResponse(client, id);
  if (verification.signatureKind !== "provider_tee" || verification.id !== id) {
    throw new InferenceError("verification_failed", "The response was not signed by an attested model.");
  }
  const hash = z.string().regex(/^[a-f0-9]{64}$/i);
  const hashes = z
    .tuple([z.literal(model), hash, hash])
    .safeParse(verification.signature.signedText.split(":"));
  if (!hashes.success) {
    throw new InferenceError("verification_failed", "The model receipt does not match the requested model.");
  }
  const evidenceJson = JSON.stringify(verification, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return {
    model,
    completionId: id,
    signatureKind: verification.signatureKind,
    verifiedAt: Date.now(),
    requestHash: hashes.data[1],
    responseHash: hashes.data[2],
    evidenceHash: createHash("sha256").update(evidenceJson).digest("hex"),
    evidenceJson,
  };
}

export function inferenceFailure(error: unknown, phase: "request" | "signature"): InferenceError {
  const sdk = getSdkError(error);
  const code = sdk?.failure.code;
  const status = z.object({ status: z.number() }).safeParse(error);
  const transport =
    code === "api.http_status" ||
    code === "api.transport_failed" ||
    code === "api.completion_signature_unavailable";
  if (isVerificationError(sdk) || (phase === "signature" && !transport)) {
    return new InferenceError(
      "verification_failed",
      "The model attestation or response signature could not be verified. No verified answer was saved.",
    );
  }
  if (status.success && status.data.status === 400) {
    return new InferenceError("unavailable", "NEAR AI rejected the request. Please try a new message.");
  }
  return new InferenceError(
    "unavailable",
    phase === "signature"
      ? "The answer's verification service is unavailable. No verified answer was saved. Try again shortly."
      : "NEAR AI could not complete the request. Try again shortly.",
  );
}

async function verifyResponse(client: InferenceClient, id: string): Promise<VerifiedCompletionResult> {
  try {
    return await client.verifyResponse(id);
  } catch (error) {
    // A failed receipt lookup must not silently generate and charge for another answer.
    throw inferenceFailure(error, "signature");
  }
}

export function canRotateKey(error: unknown): boolean {
  const sdkError = getSdkError(error);
  const status = z.object({ status: z.number() }).safeParse(error);
  return (
    (sdkError?.failure.code === "api.http_status" &&
      [401, 429, 503].includes(sdkError.failure.details.status)) ||
    (status.success && [401, 429, 503].includes(status.data.status))
  );
}

async function tryModels(request: CompletionRequest, signal: AbortSignal): Promise<VerifiedCompletion> {
  const apiKeys = keys();
  for (const model of APPROVED_MODELS) {
    for (const key of apiKeys) {
      signal.throwIfAborted();
      try {
        return await completeWithClient(key, model, request, signal);
      } catch (error) {
        if (signal.aborted || error instanceof InferenceError) {
          throw error;
        }
        if (canRotateKey(error)) {
          continue;
        }
        throw inferenceFailure(error, "request");
      }
    }
  }
  throw new InferenceError("unavailable", "The attested models are unavailable or rate limited. Try later.");
}

/** Buffers the complete answer until its model-specific signature is verified. Never returns unverified text. */
export async function verifiedCompletion(request: CompletionRequest): Promise<VerifiedCompletion> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), INFERENCE_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout.signal, ...(request.signal ? [request.signal] : [])]);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        request.signal?.aborted
          ? new InferenceError("cancelled", "Response stopped.")
          : new InferenceError("unavailable", "Response verification timed out. Try again later."),
      );
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([aborted, tryModels(request, signal)]);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
