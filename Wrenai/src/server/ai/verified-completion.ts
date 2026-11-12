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
  /**
   * Hidden reasoning budget. By default the approved models spent 200–600 reasoning tokens and 10–25 s on short
   * outputs; "low" keeps a brief pass and "off" skips it (measured November 6, 2026). Responses stay attested
   * and signature-verified either way.
   */
  readonly reasoning?: "default" | "low" | "off";
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
  const params = {
    model,
    stream: false as const,
    temperature: 0,
    max_tokens: request.maxTokens,
    messages: [...request.messages],
    ...(request.json ? { response_format: { type: "json_object" as const } } : {}),
    ...(request.reasoning === "off"
      ? { reasoning_effort: "none" as const }
      : request.reasoning === "low"
        ? { reasoning_effort: "low" as const }
        : {}),
  };
  const completion = await client.chat.completions.create(params, {
    timeout: INFERENCE_TIMEOUT_MS,
    maxRetries: 0,
    signal,
  });
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

/** Every configured key for one model was rate limited or rejected: the next approved model may answer. */
class ModelUnavailable extends InferenceError {
  constructor() {
    super("unavailable", "The attested models are unavailable or rate limited. Try later.");
  }
}

async function attemptModel(
  model: (typeof APPROVED_MODELS)[number],
  request: CompletionRequest,
  signal: AbortSignal,
): Promise<VerifiedCompletion> {
  for (const key of keys()) {
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
  throw new ModelUnavailable();
}

/**
 * How long one model may run before the next approved model is asked as well. A slow attempt keeps running; the
 * first verified answer wins and the others are aborted. Measured answers usually arrive in 5–15 s; slow ones used to
 * hold a request for over a minute or time out.
 */
export const HEDGE_AFTER_MS = 20_000;

/**
 * The approved models in their set order, hedged against slowness. A model whose keys are all exhausted hands over
 * to the next at once. A failed verification or receipt lookup ends everything without starting another answer,
 * though an attempt already running for latency may still win.
 */
function tryModels(request: CompletionRequest, signal: AbortSignal): Promise<VerifiedCompletion> {
  return new Promise<VerifiedCompletion>((resolve, reject) => {
    const attempts: AbortController[] = [];
    let next = 0,
      running = 0,
      settled = false,
      lastError: unknown = new ModelUnavailable(),
      timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      for (const attempt of attempts) {
        attempt.abort();
      }
      settle();
    };
    const launch = (): void => {
      const model = APPROVED_MODELS[next];
      if (settled || model === undefined || signal.aborted) {
        return;
      }
      next += 1;
      running += 1;
      const attempt = new AbortController();
      attempts.push(attempt);
      clearTimeout(timer);
      timer = setTimeout(launch, HEDGE_AFTER_MS);
      attemptModel(model, request, AbortSignal.any([signal, attempt.signal])).then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => {
          running -= 1;
          if (settled) {
            return;
          }
          if (error instanceof ModelUnavailable) {
            lastError = error;
            if (next < APPROVED_MODELS.length) {
              launch();
              return;
            }
          } else if (
            signal.aborted ||
            running === 0 ||
            (error instanceof InferenceError && error.code === "verification_failed")
          ) {
            // A rejected attestation or signature ends every attempt: no unverified or substitute answer.
            finish(() => reject(error));
            return;
          } else {
            // Another attempt is already answering; never start a new one because this one failed.
            lastError = error;
            clearTimeout(timer);
            return;
          }
          if (running === 0) {
            finish(() => reject(lastError));
          }
        },
      );
    };
    launch();
  });
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
