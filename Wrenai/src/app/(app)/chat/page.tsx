import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { z } from "zod";
import { ChatScreen } from "@/components/chat/screen";
import { requireUser } from "@/server/auth/session";
import { ChatError } from "@/server/chat/errors";
import { listConversations, readConversationPage } from "@/server/chat/queries";
import { database } from "@/server/db/client";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { activeAgentToolSchema } from "@/shared/agent-scope";

export const metadata: Metadata = { title: "Chat" };

export default async function ChatPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly conversation?: string;
    readonly tool?: string;
    readonly prompt?: string;
  }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const parsed = z.uuid().safeParse(params.conversation);
  const [conversation, history] = await Promise.all([
    parsed.success
      ? readConversationPage(database(), user.id, parsed.data, null).catch((error: unknown) => {
          if (error instanceof ChatError && error.code === "not_found") {
            return null;
          }
          throw error;
        })
      : Promise.resolve(null),
    listConversations(database(), user.id),
  ]);
  const tool = activeAgentToolSchema.safeParse(params.tool);
  return (
    <ChatScreen
      initialId={conversation?.id ?? randomUUID()}
      initialPrompt={
        !conversation
          ? z
              .string()
              .trim()
              .max(2000)
              .catch("")
              .parse(params.prompt ?? (tool.success ? AGENT_CATALOG[tool.data].prompt : ""))
          : ""
      }
      conversation={conversation}
      history={history}
    />
  );
}
