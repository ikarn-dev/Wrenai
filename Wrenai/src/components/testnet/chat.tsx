"use client";
import type { ReactElement } from "react";
import { CopyButton } from "@/components/chat/copy-button";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ChatScreenView } from "@/components/chat/screen";
import { testnetAgentToolSchema } from "@/shared/testnet-agents";
import { TestnetAgentSetup } from "./agent-setup";
import { deleteTestnetChat, loadTestnetChats } from "./chat-api";
import { useTestnetData } from "./data-provider";
import { TestnetOrderCard } from "./order-card";
import { useTestnetChat } from "./use-chat";

export function TestnetChat(): ReactElement | null {
  const { data, refresh } = useTestnetData();
  if (!data) {
    return null;
  }
  return <TestnetChatSession ownerId={data.owner.id} onChanged={refresh} />;
}
function TestnetChatSession({
  ownerId,
  onChanged,
}: {
  readonly ownerId: string;
  readonly onChanged: () => Promise<unknown>;
}): ReactElement | null {
  const { data } = useTestnetData();
  const { controller, messages } = useTestnetChat(ownerId, onChanged);
  if (!data) {
    return null;
  }
  const last = controller.turns.at(-1),
    answer = last ? messages.find((m) => m.role === "assistant" && m.requestId === last.id) : null;
  const offer =
    last?.state === "complete" && answer && !answer.orderId && controller.tool
      ? {
          conversationId: controller.conversationId,
          turnId: last.id,
          tool: controller.tool,
          key: `${controller.conversationId}:${last.id}:${controller.tool}`,
        }
      : null;
  return (
    <>
      <ChatScreenView
        chat={controller}
        launch={{
          ownerId,
          accountId: data.owner.accountId ?? "Guest",
          privateReady: false,
          publicReady: false,
          recoveryConfirmed: false,
        }}
        loadHistory={loadTestnetChats}
        removeChat={deleteTestnetChat}
        allowedTools={testnetAgentToolSchema.options}
        offer={offer}
        onOpenAgent={(tool) => {
          const url = new URL(window.location.href);
          url.searchParams.set("create", tool);
          window.history.pushState(null, "", url);
        }}
        renderReply={(turn) => {
          const message = messages.find((m) => m.role === "assistant" && m.requestId === turn.id);
          if (!message) {
            return null;
          }
          const order = data.orders.find((o) => o.id === message.orderId);
          return (
            <>
              <ChatMarkdown content={message.text} />
              {order ? <TestnetOrderCard order={order} owner={data.owner} onChanged={onChanged} /> : null}
              <CopyButton text={message.text} label="Copy reply" />
            </>
          );
        }}
      />
      <TestnetAgentSetup />
    </>
  );
}
