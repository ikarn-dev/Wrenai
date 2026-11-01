import "server-only";
import { createHash } from "node:crypto";
import { InferenceClient, NO_ALIASING_HEADER } from "@nearai/inference-sdk/node";

const CHAT_EVIDENCE_TTL_MS = 60_000;
const MAX_CHAT_CLIENTS = 5;
const chatClients = new Map<string, InferenceClient>();

/** A warm-instance optimization only. The SDK still verifies each response against its selected model signer. */
export function inferenceClient(apiKey: string, cachedChat: boolean): InferenceClient {
  const id = createHash("sha256").update(apiKey).digest("hex");
  const cached = cachedChat ? chatClients.get(id) : undefined;
  if (cached) {
    chatClients.delete(id);
    chatClients.set(id, cached);
    return cached;
  }
  const client = new InferenceClient({
    apiKey,
    e2ee: true,
    attestationCacheTimeToLiveMs: cachedChat ? CHAT_EVIDENCE_TTL_MS : 0,
    responseCacheTimeToLiveMs: CHAT_EVIDENCE_TTL_MS,
    headers: { [NO_ALIASING_HEADER]: "true" },
  });
  if (cachedChat) {
    while (chatClients.size >= MAX_CHAT_CLIENTS) {
      const oldest = chatClients.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      chatClients.delete(oldest);
    }
    // SDK 0.2.0 expires evidence from verification time (hits don't extend it) and evicts response bytes.
    // Keep its reusable transport and shared in-flight checks instead of discarding the whole client.
    chatClients.set(id, client);
  }
  return client;
}
