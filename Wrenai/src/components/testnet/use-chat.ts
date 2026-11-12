"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ChatController } from "@/components/chat/chat-controller";
import { useToastState } from "@/components/ui/toast";
import type { ChatTurn, ConversationSummary } from "@/shared/chat";
import { shortChatTitle } from "@/shared/chat-title";
import type { ResearchTool } from "@/shared/research";
import { testnetAgentToolSchema } from "@/shared/testnet-agents";
import {
  loadTestnetChats,
  loadTestnetMessages,
  streamTestnetChat,
  type TestnetChatMessage,
} from "./chat-api";

export function useTestnetChat(
  ownerId: string,
  onChanged: () => Promise<unknown>,
): { controller: ChatController; messages: readonly TestnetChatMessage[] } {
  const params = useSearchParams(),
    cache = useQueryClient();
  const [id, setId] = useState(() => {
    const parsed = z.uuid().safeParse(params.get("conversation"));
    return parsed.success ? parsed.data : crypto.randomUUID();
  });
  const [draft, setDraft] = useState(""),
    [tool, setTool] = useState<ResearchTool | null>(() => {
      const parsed = testnetAgentToolSchema.safeParse(params.get("tool"));
      return parsed.success ? parsed.data : null;
    });
  const [pending, setPending] = useState<ChatTurn | null>(null),
    [preview, setPreview] = useState(""),
    [status, setStatus] = useState(""),
    [error, setError] = useToastState("error");
  const [busy, setBusy] = useState(false),
    [started, setStarted] = useState(false);
  const active = useRef<AbortController | null>(null),
    inputRef = useRef<HTMLTextAreaElement | null>(null);
  const historyKey = ["testnet-chats", ownerId],
    messageKey = ["testnet-messages", ownerId, id];
  const history = useQuery({
    queryKey: historyKey,
    queryFn: ({ signal }) => loadTestnetChats(signal),
    staleTime: 15000,
  });
  const query = useQuery({
    queryKey: messageKey,
    queryFn: ({ signal }) => loadTestnetMessages(id, signal),
    enabled: !busy && (started || history.data?.some((c) => c.id === id) === true),
    staleTime: 15000,
  });
  const messages = query.data ?? [];
  const turns: ChatTurn[] = messages
    .filter((m) => m.role === "user")
    .map((m, index) => ({
      id: m.requestId,
      sequence: index + 1,
      message: m.text,
      includeContext: true,
      state: messages.some((a) => a.role === "assistant" && a.requestId === m.requestId)
        ? "complete"
        : "failed",
      reply: null,
      createdAt: m.createdAt,
    }));
  if (pending && !turns.some((t) => t.id === pending.id)) {
    turns.push(pending);
  } else if (pending) {
    const index = turns.findIndex((t) => t.id === pending.id);
    turns[index] = pending;
  }
  const setHistory: Dispatch<SetStateAction<readonly ConversationSummary[]>> = useCallback(
    (value) => {
      cache.setQueryData<readonly ConversationSummary[]>(["testnet-chats", ownerId], (old) =>
        typeof value === "function" ? value(old ?? []) : value,
      );
    },
    [cache, ownerId],
  );
  const change = useCallback((next: string): void => {
    if (active.current) {
      setError("Stop or finish this reply before switching chats.");
      return;
    }
    setId(next);
    setDraft("");
    setPending(null);
    setPreview("");
    setError(null);
    setStarted(false);
    const url = new URL(window.location.href);
    url.searchParams.set("conversation", next);
    window.history.pushState(null, "", url);
  }, []);
  useEffect(() => {
    const back = (): void => {
      if (active.current) {
        return;
      }
      const next = z.uuid().safeParse(new URL(window.location.href).searchParams.get("conversation"));
      setId(next.success ? next.data : crypto.randomUUID());
      setPending(null);
      setDraft("");
      setPreview("");
    };
    window.addEventListener("popstate", back);
    return () => {
      active.current?.abort();
      window.removeEventListener("popstate", back);
    };
  }, []);
  async function send(message: string, requestId = crypto.randomUUID()): Promise<void> {
    if (active.current || !message.trim()) {
      return;
    }
    if (message.trim().length > 3000) {
      setError("Keep testnet messages under 3,000 characters.");
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setStarted(true);
    setDraft("");
    setError(null);
    setPreview("");
    setStatus("Preparing reply…");
    const turn: ChatTurn = {
      id: requestId,
      sequence: turns.find((t) => t.id === requestId)?.sequence ?? turns.length + 1,
      message,
      includeContext: true,
      state: "pending",
      reply: null,
      createdAt: Date.now(),
    };
    setPending(turn);
    setHistory((old) => [
      { id, title: old.find((c) => c.id === id)?.title ?? shortChatTitle(message), updatedAt: Date.now() },
      ...old.filter((c) => c.id !== id),
    ]);
    try {
      await streamTestnetChat({ conversationId: id, requestId, message }, controller.signal, (event) => {
        if (event.type === "delta") {
          setPreview((old) => old + event.text);
        }
        if (event.type === "status") {
          setStatus(event.message);
        }
        if (event.type === "done") {
          cache.setQueryData<readonly TestnetChatMessage[]>(messageKey, (old) => [
            ...(old ?? []).filter((m) => m.requestId !== requestId),
            {
              id: requestId,
              requestId,
              createdAt: turn.createdAt,
              role: "user",
              text: message,
              orderId: null,
            },
            {
              id: crypto.randomUUID(),
              requestId,
              createdAt: Date.now(),
              role: "assistant",
              text: event.text,
              orderId: event.orderId,
            },
          ]);
          setPending(null);
        }
      });
      await Promise.all([onChanged(), cache.invalidateQueries({ queryKey: historyKey })]);
    } catch (e) {
      setPending({ ...turn, state: controller.signal.aborted ? "cancelled" : "failed" });
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "Reply incomplete.");
      }
    } finally {
      active.current = null;
      setBusy(false);
      setStatus("");
    }
  }
  return {
    messages,
    controller: {
      conversationId: id,
      turns,
      history: history.data ?? [],
      setHistory,
      draft,
      setDraft,
      tool,
      setTool,
      inputRef,
      busy,
      sending: busy,
      stopping: false,
      checking: query.isFetching,
      loading: query.isLoading,
      hasEarlier: false,
      preview,
      status,
      error: error ?? query.error?.message ?? history.error?.message ?? null,
      setError,
      newChat: () => change(crypto.randomUUID()),
      select: change,
      forget: (removed) => {
        cache.removeQueries({ queryKey: ["testnet-messages", ownerId, removed] });
        if (removed === id) {
          active.current?.abort();
          active.current = null;
          setBusy(false);
          change(crypto.randomUUID());
        }
      },
      submit: () => {
        void send(draft.trim());
      },
      retry: (turn) => {
        void send(turn.message, turn.id);
      },
      stop: async () => {
        active.current?.abort();
      },
      check: async () => {
        await query.refetch();
      },
      earlier: async () => undefined,
    },
  };
}
