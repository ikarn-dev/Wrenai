import "server-only";
import { createHash } from "node:crypto";
import { InferenceClient, NO_ALIASING_HEADER } from "@nearai/inference-sdk/node";

const CHAT_EVIDENCE_TTL_MS = 60_000;
const MAX_CHAT_CLIENTS = 5;
const chatClients = new Map<string, { readonly client: InferenceClient; readonly expiresAt: number }>();

/** A warm-instance optimization only. The SDK still verifies each response against its selected model signer. */
export function inferenceClient(apiKey: string, cachedChat: boolean): InferenceClient {
  const now = Date.now();
  for (const [id, entry] of chatClients) {
    if (entry.expiresAt <= now) {
      chatClients.delete(id);
    }
  }
  const id = createHash("sha256").update(apiKey).digest("hex");
  const cached = cachedChat ? chatClients.get(id) : undefined;
  if (cached) {
    return cached.client;
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
    // Do not extend on reuse: client replacement puts an independent upper bound on evidence age.
    chatClients.set(id, { client, expiresAt: now + CHAT_EVIDENCE_TTL_MS });
  }
  return client;
}
