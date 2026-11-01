import "server-only";
import { z } from "zod";
import { type ChatInput, MAX_CHAT_MESSAGE } from "@/shared/chat";
import { researchToolSchema } from "@/shared/research";
import type { ChatCipher } from "./cipher";

// A disjoint ciphertext prefix and authenticated field keep legacy plaintext messages unambiguous.
const PREFIX = "m1:";
const recordSchema = z.strictObject({
  message: z.string().min(1).max(MAX_CHAT_MESSAGE),
  tool: researchToolSchema,
});
type MessageRecord = { readonly message: string; readonly tool?: z.infer<typeof researchToolSchema> };

export function sealMessage(cipher: ChatCipher, owner: string, input: ChatInput): string {
  if (!input.tool) {
    return cipher.seal(owner, input.conversationId, `${input.requestId}:user`, input.message);
  }
  return (
    PREFIX +
    cipher.seal(
      owner,
      input.conversationId,
      `${input.requestId}:user:m1`,
      JSON.stringify({ message: input.message, tool: input.tool }),
    )
  );
}

export function openMessage(
  cipher: ChatCipher,
  owner: string,
  conversationId: string,
  turnId: string,
  sealed: string,
): MessageRecord {
  if (!sealed.startsWith(PREFIX)) {
    return { message: cipher.open(owner, conversationId, `${turnId}:user`, sealed) };
  }
  return recordSchema.parse(
    JSON.parse(cipher.open(owner, conversationId, `${turnId}:user:m1`, sealed.slice(PREFIX.length))),
  );
}
