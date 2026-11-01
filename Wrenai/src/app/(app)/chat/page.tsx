import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { z } from "zod";
import { ChatScreen } from "@/components/chat/screen";
import { requireUser } from "@/server/auth/session";
import { listConversations, readConversationPage } from "@/server/chat/queries";
import { database } from "@/server/db/client";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { researchToolSchema } from "@/shared/research";

export const metadata: Metadata = { title: "Chat" };

export default async function ChatPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly conversation?: string; readonly tool?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const parsed = z.uuid().safeParse(params.conversation);
  const id = parsed.success ? parsed.data : randomUUID();
  const [conversation, history] = await Promise.all([
    parsed.success ? readConversationPage(database(), user.id, id, null) : Promise.resolve(null),
    listConversations(database(), user.id),
  ]);
  const tool = researchToolSchema.safeParse(params.tool);
  return (
    <ChatScreen
      initialId={id}
      initialPrompt={!conversation && tool.success ? AGENT_CATALOG[tool.data].prompt : ""}
      conversation={conversation}
      history={history}
    />
  );
}
