import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
export default async function ConversationPage({
  params,
}: {
  readonly params: Promise<{ readonly conversationId: string }>;
}) {
  await requireUser();
  const id = z.uuid().safeParse((await params).conversationId);
  if (!id.success) {
    notFound();
  }
  redirect(`/chat?conversation=${id.data}`);
}
