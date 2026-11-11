"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type SetStateAction, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { notifyQuoteFailure } from "@/components/trading/quote-feedback";
import { notify, useToastState } from "@/components/ui/toast";
import { stopChatReply } from "@/server/chat/actions";
import { isActiveAgentTool } from "@/shared/agent-scope";
import type { ChatEvent, ChatInput, ChatTurn, Conversation, ConversationSummary } from "@/shared/chat";
import { chatRoutingIssue } from "@/shared/chat-routing";
import { chatStatus } from "@/shared/chat-status";
import { shortChatTitle } from "@/shared/chat-title";
import type { ResearchTool } from "@/shared/research";
import { loadChatPage } from "./chat-api";
import type { ChatController } from "./chat-controller";
import { rejectOptimisticTurn } from "./reply-recovery";
import { ChatRequestRejected, consumeChatStream } from "./stream";
import { createStreamPreview, type StreamPreview } from "./stream-preview";

interface ActiveReply {
  readonly input: ChatInput;
  readonly controller: AbortController;
  readonly preview: StreamPreview;
  completed: boolean;
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
  const previousTool = initialConversation?.turns.at(-1)?.tool;
  const [tool, setTool] = useState<ResearchTool | null>(
    isActiveAgentTool(previousTool) ? previousTool : null,
  );
  const draftValue = useRef(initialPrompt);
  const drafts = useRef(new Map<string, string>());
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useToastState("warn");
  const active = useRef<ActiveReply | null>(null);
  const currentId = useRef(initialId);
  const mounted = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const known = history.some((item) => item.id === conversationId);
  const query = useQuery<Conversation>({
    queryKey: key(conversationId),
    queryFn: async ({ signal }) => {
      const page = await loadChatPage(conversationId, null, signal);
      const previous = cache.getQueryData<Conversation>(key(conversationId));
      const first = page.turns[0]?.sequence ?? 1;
      return {
        ...page,
        turns: [...(previous?.turns.filter((turn) => turn.sequence < first) ?? []), ...page.turns],
        hasEarlier: previous?.hasEarlier === false ? false : page.hasEarlier,
      };
    },
    enabled: known && !sending,
    ...(conversationId === initialId && initialConversation ? { initialData: initialConversation } : {}),
  });
  const turns = query.data?.turns ?? [];
  const last = turns.at(-1);
  const busy = sending || last?.state === "pending";
  // The committed values handlers read when they run. Callbacks read them here instead of closing over them, so
  // their identities stay fixed while a reply streams and memoized messages, history and composer stay put.
  const latest = useRef({ conversationId, turns, last, busy, tool, draft, stopping });
  useLayoutEffect(() => {
    latest.current = { conversationId, turns, last, busy, tool, draft, stopping };
  });

  const setDraft = useCallback((value: SetStateAction<string>): void => {
    const next = typeof value === "function" ? value(draftValue.current) : value;
    draftValue.current = next;
    drafts.current.set(currentId.current, next);
    setDraftValue(next);
  }, []);
  const change = useCallback(
    (id: string): void => {
      if (active.current) {
        setError("Stop or finish this reply before switching chats.");
        return;
      }
      drafts.current.set(currentId.current, draftValue.current);
      currentId.current = id;
      setId(id);
      setTool(null);
      setDraft(drafts.current.get(id) ?? "");
      setPreview("");
      setError(null);
    },
    [setDraft],
  );
  useEffect(() => {
    mounted.current = true;
    const navigate = (): void => {
      const id = new URL(window.location.href).searchParams.get("conversation");
      if (!active.current) {
        const target = id && /^[a-f0-9-]{36}$/i.test(id) ? id : crypto.randomUUID();
        currentId.current = target;
        setId(target);
        setTool(null);
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

  const replaceTurn = useCallback(
    (input: ChatInput, turn: ChatTurn): void => {
      cache.setQueryData<Conversation>(key(input.conversationId), (current) => ({
        id: input.conversationId,
        title: current?.title ?? shortChatTitle(input.message),
        updatedAt: Date.now(),
        hasEarlier: current?.hasEarlier ?? false,
        turns: [...(current?.turns ?? []).filter((item) => item.id !== turn.id), turn].sort(
          (a, b) => a.sequence - b.sequence,
        ),
      }));
    },
    [cache],
  );
  const saved = useCallback(
    (input: ChatInput, turn: ChatTurn): void => {
      replaceTurn(input, turn);
      setHistory((items) => [
        {
          id: input.conversationId,
          title:
            items.find((item) => item.id === input.conversationId)?.title ?? shortChatTitle(input.message),
          updatedAt: Date.now(),
        },
        ...items.filter((item) => item.id !== input.conversationId),
      ]);
      if (currentId.current === input.conversationId) {
        window.history.replaceState(null, "", `/chat?conversation=${input.conversationId}`);
      }
    },
    [replaceTurn],
  );
  const refresh = useCallback(
    async (id: string): Promise<Conversation> => {
      const page = await loadChatPage(id);
      if (currentId.current === id) {
        cache.setQueryData(key(id), page);
      }
      return page;
    },
    [cache],
  );
  const send = useCallback(
    async (input: ChatInput): Promise<void> => {
      if (active.current) {
        return;
      }
      const routingIssue = chatRoutingIssue(input.message, input.tool ?? null);
      if (routingIssue) {
        setError(routingIssue);
        return;
      }
      const attempt = {
        input,
        controller: new AbortController(),
        preview: createStreamPreview(setPreview),
        completed: false,
      };
      active.current = attempt;
      setSending(true);
      setError(null);
      setPreview("");
      setStatus(chatStatus("connecting"));
      // Picked once per reply, so the line stays put while text streams in.
      const streamingStatus = chatStatus("streaming");
      setDraft("");
      drafts.current.delete(input.conversationId);
      const previous = latest.current.turns.find((turn) => turn.id === input.requestId);
      const optimistic: ChatTurn = {
        id: input.requestId,
        sequence: previous?.sequence ?? (latest.current.last?.sequence ?? 0) + 1,
        message: input.message,
        includeContext: input.includeContext,
        ...(input.tool ? { tool: input.tool } : {}),
        state: "pending",
        reply: null,
        createdAt: Date.now(),
      };
      void cache.cancelQueries({ queryKey: key(input.conversationId), exact: true });
      replaceTurn(input, optimistic);
      const receive = (event: ChatEvent): void => {
        if (
          !mounted.current ||
          (active.current !== attempt && !(attempt.completed && event.type === "title"))
        ) {
          return;
        }
        switch (event.type) {
          case "delta":
            attempt.preview.append(event.text);
            setStatus(streamingStatus);
            break;
          case "reset":
            attempt.preview.reset();
            break;
          case "status":
            setStatus(event.message);
            break;
          case "turn":
            saved(input, event.turn);
            setStatus(chatStatus("preparing"));
            break;
          case "verified":
            setStatus("Verified · saving…");
            break;
          case "done":
            if (event.walletSwap) {
              cache.setQueryData(["wallet-swap", event.walletSwap.id], event.walletSwap);
              if (event.walletSwap.state === "quoted") {
                notify("success", "Quote ready.");
              }
            }
            if (event.quoteError) {
              notifyQuoteFailure(event.quoteError);
            }
            saved(input, event.turn);
            attempt.completed = true;
            attempt.preview.dispose();
            active.current = null;
            setSending(false);
            setStatus("");
            inputRef.current?.focus({ preventScroll: true });
            // Query subscribers may update after local state; the saved row replaces this preview in place.
            break;
          case "research":
            break; // Agent setup is offered only after the verified reply is durably saved.
          case "title":
            // The server named the new chat after its first reply; history shows it at once.
            setHistory((items) =>
              items.map((item) =>
                item.id === input.conversationId ? { ...item, title: event.title } : item,
              ),
            );
            break;
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
          signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(125_000)]),
          cache: "no-store",
        });
        await consumeChatStream(response, receive);
      } catch (error) {
        if (mounted.current && active.current === attempt && !attempt.completed) {
          attempt.preview.reset();
          setError(error instanceof Error ? error.message : "The reply could not be completed.");
          if (error instanceof ChatRequestRejected) {
            cache.setQueryData<Conversation>(key(input.conversationId), (current) =>
              rejectOptimisticTurn(current, input.requestId, previous),
            );
            if (!draftValue.current) {
              setDraft(input.message);
            }
            return;
          }
          try {
            const conversation = await refresh(input.conversationId);
            if (!mounted.current || active.current !== attempt) {
              return;
            }
            const recovered = conversation.turns.find((turn) => turn.id === input.requestId);
            if (recovered?.state === "complete") {
              saved(input, recovered);
              setError(null);
            } else if (recovered?.state === "pending") {
              setError("The connection was interrupted. Check response to see whether it finished.");
            } else if (!recovered) {
              replaceTurn(input, { ...optimistic, state: "failed" });
            }
          } catch {
            if (mounted.current && active.current === attempt) {
              replaceTurn(input, { ...optimistic, state: "failed" });
              setError("Couldn’t check the saved reply. Retry this message to recover its result.");
            }
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
    },
    [cache, refresh, replaceTurn, saved, setDraft],
  );
  const inputFor = useCallback((turn: ChatTurn): ChatInput => {
    const { conversationId, turns } = latest.current;
    return {
      conversationId,
      requestId: turn.id,
      previousTurnId: turns.find((item) => item.sequence === turn.sequence - 1)?.id ?? null,
      message: turn.message,
      includeContext: turn.includeContext,
      tool: turn.tool ?? null,
    };
  }, []);
  const stop = useCallback(async (): Promise<void> => {
    const { last, stopping } = latest.current;
    const input = active.current?.input ?? (last ? inputFor(last) : null);
    if (!input || stopping) {
      return;
    }
    setStopping(true);
    try {
      const result = await stopChatReply(input);
      if (currentId.current !== input.conversationId) {
        return;
      }
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
  }, [inputFor, saved]);
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
      const page = await loadChatPage(conversationId, turns[0].sequence);
      cache.setQueryData<Conversation>(key(conversationId), (current) =>
        current
          ? {
              ...current,
              hasEarlier: page.hasEarlier,
              turns: [...page.turns, ...current.turns],
            }
          : undefined,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Earlier messages could not be loaded.");
    } finally {
      setChecking(false);
    }
  }
  const select = useCallback(
    (id: string): void => {
      if (latest.current.busy) {
        setError("Stop or finish this reply before switching chats.");
        return;
      }
      change(id);
      window.history.pushState(null, "", `/chat?conversation=${id}`);
    },
    [change],
  );
  const newChat = useCallback((): void => {
    if (latest.current.busy) {
      setError("Stop or finish this reply before starting another chat.");
      return;
    }
    change(crypto.randomUUID());
    window.history.pushState(null, "", "/chat");
    inputRef.current?.focus();
  }, [change]);
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
      setTool(null);
      setDraft("");
      setPreview("");
      setError(null);
      window.history.replaceState(null, "", "/chat");
    }
    cache.removeQueries({ queryKey: key(id) });
    drafts.current.delete(id);
  }
  const submit = useCallback((): void => {
    const { busy, draft, conversationId, last, tool } = latest.current;
    if (!busy && draft.trim()) {
      void send({
        conversationId,
        requestId: crypto.randomUUID(),
        previousTurnId: last?.id ?? null,
        message: draft.trim(),
        includeContext: true,
        tool,
      });
    }
  }, [send]);
  const retry = useCallback(
    (turn: ChatTurn): void => {
      const { busy, last, tool } = latest.current;
      if (!busy && turn.id === last?.id) {
        void send(
          turn.state === "cancelled" || tool !== (turn.tool ?? null)
            ? {
                ...inputFor(turn),
                requestId: crypto.randomUUID(),
                previousTurnId: turn.id,
                includeContext: true,
                tool,
              }
            : inputFor(turn),
        );
      }
    },
    [inputFor, send],
  );
  return {
    conversationId,
    turns,
    history,
    setHistory,
    draft,
    setDraft,
    tool,
    setTool,
    inputRef,
    busy,
    sending,
    stopping,
    checking,
    loading: query.isLoading,
    hasEarlier: query.data?.hasEarlier ?? false,
    preview,
    status: status || (last?.state === "pending" && !sending ? "Waiting for saved reply…" : ""),
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
