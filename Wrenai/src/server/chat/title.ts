import "server-only";
import { z } from "zod";
import { verifiedCompletion } from "@/server/ai/verified-completion";
import { SHORT_TITLE_WORDS, shortChatTitle } from "@/shared/chat-title";

const TITLE_TIMEOUT_MS = 12_000;
const MAX_TITLE = 48;

const SYSTEM = [
  `Write a title for this conversation, 2 to ${SHORT_TITLE_WORDS} words, in sentence case.`,
  "Name the topic, not the request: 'NEAR yield options', not 'Compare yields for me'.",
  "Reply with the title only: no quotes, no trailing punctuation, no emoji.",
].join(" ");

// Model output is untrusted (Docs/CODE_PRACTICES.md): it becomes display text only, after this cleanup and parse.
const titleSchema = z.string().min(2).max(MAX_TITLE);

function cleanTitle(raw: string): string {
  const firstLine = raw.split("\n")[0] ?? "";
  return firstLine
    .replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.!?:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TITLE)
    .trim();
}

/**
 * A short title for a new chat, from its first question and answer, written by the same attested model as the
 * chat. Returns null when the model fails or answers with something unusable; the caller keeps the first message
 * as the title then.
 */
export async function generateChatTitle(
  message: string,
  reply: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const completion = await verifiedCompletion({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Question: ${message.slice(0, 600)}\n\nAnswer: ${reply.slice(0, 1_200)}` },
    ],
    maxTokens: 24,
    verification: "chat_cached",
    signal: AbortSignal.any([AbortSignal.timeout(TITLE_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });
  const parsed = titleSchema.safeParse(cleanTitle(completion.content));
  return parsed.success ? shortChatTitle(parsed.data) : null;
}
