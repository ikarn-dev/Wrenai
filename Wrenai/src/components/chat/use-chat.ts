"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { loadChatPage, stopChatReply } from "@/server/chat/actions";
import type { ChatEvent, ChatInput, ChatTurn, Conversation, ConversationSummary } from "@/shared/chat";
import { consumeChatStream } from "./stream";
import { createStreamPreview, type StreamPreview } from "./stream-preview";

interface ActiveReply {
  readonly input: ChatInput;
  readonly controller: AbortController;
  readonly preview: StreamPreview;
}
interface ChatController {
  readonly conversationId: string;
  readonly turns: readonly ChatTurn[];
  readonly history: readonly ConversationSummary[];
  readonly setHistory: Dispatch<SetStateAction<readonly ConversationSummary[]>>;
  readonly draft: string;
  readonly setDraft: Dispatch<SetStateAction<string>>;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly busy: boolean;
  readonly sending: boolean;
  readonly stopping: boolean;
  readonly checking: boolean;
  readonly loading: boolean;
  readonly hasEarlier: boolean;
  readonly preview: string;
  readonly status: string;
  readonly error: string | null;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly newChat: () => void;
  readonly select: (id: string) => void;
  readonly forget: (id: string) => void;
  readonly submit: () => void;
  readonly retry: (turn: ChatTurn) => void;
  readonly stop: () => Promise<void>;
  readonly check: () => Promise<void>;
  readonly earlier: () => Promise<void>;
}
const key = (id: string): readonly string[] => ["chat", id];

export function useChat(
  initialId: string,
  initialConversation: Conversation | null,
  initialHistory: readonly ConversationSummary[],
  initialPrompt = "",
): ChatController {
  const cache = useQueryClient();
  const [conversationId, setId] = useState(initialId);
  const [history, setHistory] = useState(initialHistory);
  const [draft, setDraftValue] = useState(initialPrompt);
  const draftValue = useRef(initialPrompt);
  const drafts = useRef(new Map<string, string>());
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = useRef<ActiveReply | null>(null);
  const currentId = useRef(initialId);
  const mounted = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const known = history.some((item) => item.id === conversationId);
  const query = useQuery<Conversation>({
    queryKey: key(conversationId),
    queryFn: async () => {
      const result = await loadChatPage({ conversationId });
      if (!result.ok) {
        throw new Error(result.message);
      }
      const previous = cache.getQueryData<Conversation>(key(conversationId));
      const first = result.value.turns[0]?.sequence ?? 1;
      return {
        ...result.value,
        turns: [...(previous?.turns.filter((turn) => turn.sequence < first) ?? []), ...result.value.turns],
        hasEarlier: previous?.hasEarlier === false ? false : result.value.hasEarlier,
      };
    },
    enabled: known && !sending,
    ...(conversationId === initialId && initialConversation ? { initialData: initialConversation } : {}),
  });
  const turns = query.data?.turns ?? [];
  const last = turns.at(-1);
  const busy = sending || last?.state === "pending";

  const setDraft = useCallback((value: SetStateAction<string>): void => {
    const next = typeof value === "function" ? value(draftValue.current) : value;
    draftValue.current = next;
    drafts.current.set(currentId.current, next);
    setDraftValue(next);
  }, []);
  const change = useCallback((id: string): void => {
    if (active.current) {
      setError("Stop or finish this reply before switching chats.");
      return;
    }
    drafts.current.set(currentId.current, draftValue.current);
    currentId.current = id;
    setId(id);
    setDraft(drafts.current.get(id) ?? "");
    setPreview("");
    setError(null);
  }, [setDraft]);
  useEffect(() => {
    mounted.current = true;
    const navigate = (): void => {
      const id = new URL(window.location.href).searchParams.get("conversation");
      if (!active.current) {
        const target = id && /^[a-f0-9-]{36}$/i.test(id) ? id : crypto.randomUUID();
        currentId.current = target;
        setId(target);
        setDraft(drafts.current.get(target) ?? "");
        setPreview("");
        setError(null);
      }
    };
    window.addEventListener("popstate", navigate);
    return () => {
      mounted.current = false;
      if (active.current) {
        active.current.preview.dispose();
        void cache.invalidateQueries({ queryKey: key(currentId.current), refetchType: "none" });
      }
      window.removeEventListener("popstate", navigate);
    };
  }, [cache, setDraft]);

  const replaceTurn = useCallback((input: ChatInput, turn: ChatTurn): void => {
    cache.setQueryData<Conversation>(key(input.conversationId), (current) => ({
      id: input.conversationId,
      title: current?.title ?? input.message.slice(0, 72),
      updatedAt: Date.now(),
      hasEarlier: current?.hasEarlier ?? false,
      turns: [...(current?.turns ?? []).filter((item) => item.id !== turn.id), turn].sort(
        (a, b) => a.sequence - b.sequence,
      ),
    }));
  }, [cache]);
  const saved = useCallback((input: ChatInput, turn: ChatTurn): void => {
    replaceTurn(input, turn);
    setHistory((items) => [
      {
        id: input.conversationId,
        title: items.find((item) => item.id === input.conversationId)?.title ?? input.message.slice(0, 72),
        updatedAt: Date.now(),
      },
      ...items.filter((item) => item.id !== input.conversationId),
    ]);
    window.history.replaceState(null, "", `/chat?conversation=${input.conversationId}`);
  }, [replaceTurn]);
  const refresh = useCallback(async (id: string): Promise<void> => {
    const result = await loadChatPage({ conversationId: id });
    if (!result.ok) {
      throw new Error(result.message);
    }
    cache.setQueryData(key(id), result.value);
  }, [cache]);
  const send = useCallback(async (input: ChatInput): Promise<void> => {
    if (active.current) {
      return;
    }
    const attempt = { input, controller: new AbortController(), preview: createStreamPreview(setPreview) };
    active.current = attempt;
    setSending(true);
    setError(null);
    setPreview("");
    setStatus("Connecting…");
    setDraft("");
    drafts.current.delete(input.conversationId);
    replaceTurn(input, {
      id: input.requestId,
      sequence: turns.find((turn) => turn.id === input.requestId)?.sequence ?? (last?.sequence ?? 0) + 1,
      message: input.message,
      includeContext: input.includeContext,
      state: "pending",
      reply: null,
      createdAt: Date.now(),
    });
    const receive = (event: ChatEvent): void => {
      if (!mounted.current || active.current !== attempt) {
        return;
      }
      switch (event.type) {
        case "delta":
          attempt.preview.append(event.text);
          setStatus("Verification pending");
          break;
        case "reset":
          attempt.preview.reset();
          break;
        case "status":
          setStatus(event.message);
          break;
        case "turn":
          replaceTurn(input, event.turn);
          break;
        case "verified":
          setStatus("Verified · saving…");
          break;
        case "done":
          saved(input, event.turn);
          // Query subscribers may update after local state; the saved row replaces this preview in place.
          break;
        case "research":
          break; // Cards become actionable only after the verified reply is durably saved.
        case "error":
          setError(event.message);
          break;
      }
    };
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: attempt.controller.signal,
        cache: "no-store",
      });
      await consumeChatStream(response, receive);
    } catch (error) {
      if (mounted.current && active.current === attempt) {
        attempt.preview.reset();
        setError(error instanceof Error ? error.message : "The reply could not be completed.");
        try {
          await refresh(input.conversationId);
        } catch {
          setError("Couldn’t check saved history. Retry this same message to recover its result.");
        }
      }
    } finally {
      attempt.preview.dispose();
      if (active.current === attempt) {
        active.current = null;
        if (mounted.current) {
          setSending(false);
          setStatus("");
          inputRef.current?.focus({ preventScroll: true });
        }
      }
    }
  }, [last, refresh, replaceTurn, saved, setDraft, turns]);
  const inputFor = useCallback((turn: ChatTurn): ChatInput => {
    return {
      conversationId,
      requestId: turn.id,
      previousTurnId: turns.find((item) => item.sequence === turn.sequence - 1)?.id ?? null,
      message: turn.message,
      includeContext: turn.includeContext,
    };
  }, [conversationId, turns]);
  async function stop(): Promise<void> {
    const input = active.current?.input ?? (last ? inputFor(last) : null);
    if (!input || stopping) {
      return;
    }
    setStopping(true);
    try {
      const result = await stopChatReply(input);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      active.current?.controller.abort();
      active.current?.preview.dispose();
      active.current = null;
      setSending(false);
      setPreview("");
      saved(input, result.value);
    } catch {
      setError("Stopping could not be confirmed. Check the saved response.");
    } finally {
      setStopping(false);
    }
  }
  const check = useCallback(async (): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      await refresh(conversationId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn’t refresh this conversation.");
    } finally {
      setChecking(false);
    }
  }, [conversationId, refresh]);
  async function earlier(): Promise<void> {
    if (!turns[0] || checking) {
      return;
    }
    setChecking(true);
    try {
      const result = await loadChatPage({ conversationId, beforeSequence: turns[0].sequence });
      if (!result.ok) {
        throw new Error(result.message);
      }
      cache.setQueryData<Conversation>(key(conversationId), (current) =>
        current
          ? {
              ...current,
              hasEarlier: result.value.hasEarlier,
              turns: [...result.value.turns, ...current.turns],
            }
          : result.value,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Earlier messages could not be loaded.");
    } finally {
      setChecking(false);
    }
  }
  const select = useCallback((id: string): void => {
    if (busy) {
      setError("Stop or finish this reply before switching chats.");
      return;
    }
    change(id);
    window.history.pushState(null, "", `/chat?conversation=${id}`);
  }, [busy, change]);
  const newChat = useCallback((): void => {
    if (busy) {
      setError("Stop or finish this reply before starting another chat.");
      return;
    }
    change(crypto.randomUUID());
    window.history.pushState(null, "", "/chat");
    inputRef.current?.focus();
  }, [busy, change]);
  function forget(id: string): void {
    if (active.current?.input.conversationId === id) {
      active.current.controller.abort();
      active.current.preview.dispose();
      active.current = null;
      setSending(false);
    }
    if (currentId.current === id) {
      currentId.current = crypto.randomUUID();
      setId(currentId.current);
      setDraft("");
      setPreview("");
      setError(null);
      window.history.replaceState(null, "", "/chat");
    }
    cache.removeQueries({ queryKey: key(id) });
    drafts.current.delete(id);
  }
  function submit(): void {
    if (!busy && draft.trim()) {
      void send({
        conversationId,
        requestId: crypto.randomUUID(),
        previousTurnId: last?.id ?? null,
        message: draft.trim(),
        includeContext: true,
      });
    }
  }
  const retry = useCallback((turn: ChatTurn): void => {
    if (!busy && turn.id === last?.id) {
      void send(
        turn.state === "cancelled"
          ? {
              ...inputFor(turn),
              requestId: crypto.randomUUID(),
              previousTurnId: turn.id,
              includeContext: true,
            }
          : inputFor(turn),
      );
    }
  }, [busy, inputFor, last?.id, send]);
  return {
    conversationId,
    turns,
    history,
    setHistory,
    draft,
    setDraft,
    inputRef,
    busy,
    sending,
    stopping,
    checking,
    loading: query.isLoading,
    hasEarlier: query.data?.hasEarlier ?? false,
    preview,
    status,
    error: error ?? query.error?.message ?? null,
    setError,
    newChat,
    select,
    forget,
    submit,
    retry,
    stop,
    check,
    earlier,
  };
}
