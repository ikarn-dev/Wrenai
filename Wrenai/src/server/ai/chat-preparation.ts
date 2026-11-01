import "server-only";
import { nearAiKeys } from "@/server/env";
import { APPROVED_MODELS } from "@/shared/ai-models";
import { inferenceClient } from "./inference-client";
import { canRotateKey, InferenceError, inferenceFailure } from "./verified-completion";

/** Overlap the existing attestation check with context reads; inference still checks every reply signature. */
export async function prepareChatInference(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new InferenceError("cancelled", "Reply stopped.");
  }
  const key = nearAiKeys()[0];
  if (!key) {
    throw new InferenceError("unavailable", "NEAR AI chat is not configured.");
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new InferenceError("cancelled", "Reply stopped or exceeded its time limit."));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    await Promise.race([inferenceClient(key, true).verify(APPROVED_MODELS[0]), aborted]);
  } catch (error) {
    if (signal.aborted) {
      throw new InferenceError("cancelled", "Reply stopped.");
    }
    if (error instanceof InferenceError) {
      throw error;
    }
    if (!canRotateKey(error)) {
      throw inferenceFailure(error, "request");
    }
    // Only auth/rate/availability failures defer to the requester's existing key/model rotation.
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
