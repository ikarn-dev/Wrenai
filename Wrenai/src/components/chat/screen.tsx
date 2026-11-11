"use client";

import { Ban, Eye, History, Info, Lock, Plus, X } from "lucide-react";
import dynamic from "next/dynamic";
import { Dialog, ScrollArea, Tooltip } from "radix-ui";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { LaunchContext } from "@/components/agents/deploy-launch";
import { notify, useToastState } from "@/components/ui/toast";
import { removeConversation } from "@/server/chat/actions";
import type { CreateAgentRequest } from "@/shared/agent-create-request";
import { type Conversation, type ConversationSummary, MAX_CHAT_TURNS } from "@/shared/chat";
import { chatStatus } from "@/shared/chat-status";
import { AgentOfferPrompt, latestAgentOffer } from "./agent-offer";
import { loadChatHistory } from "./chat-api";
import { ChatComposer } from "./composer";
import { DeleteChatDialog } from "./delete-chat-dialog";
import { ChatEmptyState } from "./empty-state";
import { ChatHistory } from "./history";
import { ChatHistoryPanel } from "./history-panel";
import { JarvisLoading, JarvisMark } from "./jarvis-mark";
import { ChatMessage } from "./message";
import { useChat } from "./use-chat";

const CreateAgentDialog = dynamic(() =>
  import("@/components/agents/create-agent-dialog").then((module) => module.CreateAgentDialog),
);

const INFO_LINES = [
  { icon: Eye, text: "Sees your wallet and agents" },
  { icon: Ban, text: "Trade previews need your confirmation" },
  // "Stored", not just "encrypted": true as written (encrypted at rest, Spec §10) without implying no one can read it.
  { icon: Lock, text: "Chats stored encrypted" },
] as const;

interface ChatScreenProps {
  readonly initialId: string;
  readonly initialPrompt?: string;
  readonly conversation: Conversation | null;
  readonly history: readonly ConversationSummary[];
  readonly launch: LaunchContext;
}

export function ChatScreen({
  initialId,
  initialPrompt = "",
  conversation,
  history,
  launch,
}: ChatScreenProps): ReactElement {
  const chat = useChat(initialId, conversation, history, initialPrompt);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [agentSetup, setAgentSetup] = useState<{
    readonly pack: CreateAgentRequest["pack"];
    readonly open: boolean;
  } | null>(null);
  const [deletion, setDeletion] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [refreshing, startTransition] = useTransition();
  const historyRead = useRef<AbortController | null>(null);
  const [, setManagementError] = useToastState("error");
  const [showStatus, setShowStatus] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  // Picked once per mount so the line doesn't change on every render.
  const [stoppingStatus] = useState(() => chatStatus("stopping"));
  const [atBottom, setAtBottom] = useState(true);
  const following = useRef(true);
  const replyInProgress = useRef(chat.busy);
  const observedConversation = useRef(chat.conversationId);
  const previousScrollTop = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const threadContent = useRef<HTMLDivElement>(null);
  const last = chat.turns.at(-1);
  const empty = chat.turns.length === 0 && !chat.loading;

  useLayoutEffect(() => {
    replyInProgress.current = chat.busy;
  }, [chat.busy]);

  useEffect(() => {
    if (!chat.busy) {
      return;
    }
    const timer = setTimeout(() => setShowStatus(true), 300);
    return () => {
      clearTimeout(timer);
      setShowStatus(false);
    };
  }, [chat.busy]);

  useEffect(() => {
    if (chat.loading) {
      return;
    }
    const content = threadContent.current;
    if (!content) {
      return;
    }
    if (observedConversation.current !== chat.conversationId) {
      observedConversation.current = chat.conversationId;
      following.current = true;
      previousScrollTop.current = 0;
      setAtBottom(true);
    }
    const follow = (): void => {
      if (following.current) {
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "instant" });
      }
    };
    const observer = new ResizeObserver(() => {
      if (replyInProgress.current) {
        follow();
      } else if (scroller.current) {
        // Completed reply controls grow below the answer without pulling it out of the reader's viewport.
        const element = scroller.current;
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 4;
        following.current = nearBottom;
        setAtBottom(nearBottom);
      }
    });
    observer.observe(content);
    follow();
    return () => observer.disconnect();
  }, [chat.conversationId, chat.loading]);

  const setFollowing = useCallback((value: boolean): void => {
    following.current = value;
    setAtBottom(value);
  }, []);

  // Read when Refresh runs, so the callback (and the memoized history list) doesn't change with every saved reply.
  const historyNow = useRef(chat.history);
  useLayoutEffect(() => {
    historyNow.current = chat.history;
  }, [chat.history]);

  const refreshHistory = useCallback((): void => {
    historyRead.current?.abort();
    const request = new AbortController();
    historyRead.current = request;
    const before = new Map(historyNow.current.map((item) => [item.id, item]));
    startTransition(async () => {
      try {
        const result = await loadChatHistory(request.signal);
        if (!request.signal.aborted) {
          chat.setHistory((items) => {
            const updated = items.filter((item) => before.get(item.id) !== item);
            const ids = new Set(updated.map((item) => item.id));
            return [...updated, ...result.filter((item) => !ids.has(item.id))];
          });
        }
      } catch {
        if (!request.signal.aborted) {
          chat.setError("Chat history could not be refreshed. Try again.");
        }
      }
    });
  }, [chat.setHistory, chat.setError]);

  async function deleteChat(): Promise<void> {
    if (!deletion || deleting) {
      return;
    }
    const id = deletion.id;
    setManagementError(null);
    setDeleting(id);
    setDeletion(null);
    try {
      const result = await removeConversation(id);
      if (!result.ok && result.code !== "not_found") {
        setManagementError(result.message);
        return;
      }
      historyRead.current?.abort();
      chat.setHistory((items) => items.filter((item) => item.id !== id));
      chat.forget(id);
      notify("success", "Chat deleted.");
    } catch {
      setManagementError("The deletion could not be confirmed. Refresh history to check.");
    } finally {
      setDeleting(null);
    }
  }

  const newChat = useCallback((): void => {
    following.current = true;
    setAtBottom(true);
    chat.newChat();
  }, [chat.newChat]);

  const chooseDeletion = useCallback(
    (item: ConversationSummary): void => {
      if (deleting) {
        return;
      }
      setManagementError(null);
      setDeletion(item);
    },
    [deleting],
  );
  const closeHistory = useCallback((): void => setHistoryOpen(false), []);
  const cancelDeletion = useCallback((): void => setDeletion(null), []);
  const confirmDeletion = (): void => void deleteChat();
  const collapseHistory = useCallback((): void => setHistoryCollapsed(true), []);
  const toggleHistory = useCallback((): void => setHistoryCollapsed((value) => !value), []);
  const { submit, stop, inputRef } = chat;
  const sendDraft = useCallback((): void => {
    setFollowing(true);
    submit();
  }, [setFollowing, submit]);
  const stopReply = useCallback((): void => void stop(), [stop]);
  const openSetup = useCallback(
    (pack: CreateAgentRequest["pack"]): void => setAgentSetup({ pack, open: true }),
    [],
  );
  const jumpToLatest = useCallback((): void => {
    setFollowing(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "instant" });
  }, [setFollowing]);
  // Built only when what it shows changes, so streaming frames and keystrokes don't rebuild the composer's props.
  const offerVisible = !chat.busy && !chat.loading;
  const canJump = !atBottom && chat.turns.length > 0;
  const agentOffer = useMemo(
    () => (
      <AgentOfferPrompt
        offer={latestAgentOffer(chat.conversationId, last)}
        visible={offerVisible}
        inputRef={inputRef}
        onCreate={openSetup}
        jumpToLatest={canJump ? jumpToLatest : null}
      />
    ),
    [chat.conversationId, last, offerVisible, inputRef, openSetup, canJump, jumpToLatest],
  );

  const historyProps = {
    items: deleting ? chat.history.filter((item) => item.id !== deleting) : chat.history,
    onSelect: chat.select,
    currentId: chat.conversationId,
    refreshing,
    onNew: newChat,
    onRefresh: refreshHistory,
    onDelete: chooseDeletion,
  };

  return (
    <section
      aria-label="Jarvis chat"
      className="flex h-[calc(100dvh-12rem-env(safe-area-inset-bottom))] min-h-96 min-w-0 gap-6 lg:h-[calc(100dvh-9rem)] xl:gap-8"
    >
      {/* History is a card like the Portfolio cards; the thread sits on the page beside it, no divider line. */}
      <ChatHistoryPanel collapsed={historyCollapsed} onToggle={toggleHistory}>
        <ChatHistory {...historyProps} onCollapse={collapseHistory} />
      </ChatHistoryPanel>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <span role="status" className="sr-only">
          {chat.busy
            ? ""
            : last?.state === "complete"
              ? "Reply ready."
              : last?.state === "cancelled"
                ? "Reply stopped."
                : last?.state === "failed"
                  ? "A reply wasn’t completed."
                  : ""}
        </span>
        <header className="flex min-h-12 shrink-0 items-center gap-2.5 pb-2">
          <JarvisMark size={24} />
          <h1 className="text-h3">Jarvis</h1>
          <div className="ml-auto flex items-center gap-1">
            {/* Opens on hover and on keyboard focus; nothing to click. */}
            <Tooltip.Provider delayDuration={150}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    type="button"
                    aria-label="About Jarvis"
                    className="inline-flex size-9 cursor-default items-center justify-center rounded-sm text-fg-subtle transition-colors duration-200 ease-ios hover:text-fg-strong pointer-coarse:size-11"
                  >
                    <Info size={16} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    align="end"
                    sideOffset={8}
                    collisionPadding={12}
                    className="z-50 card-shine rounded-md px-3 py-2.5 text-caption text-fg-muted shadow-float"
                  >
                    {/* Three facts, one line each: the panel sizes to the longest line, so nothing wraps into an
                        orphan, and each row leads with an icon on its text's line. The storage line follows
                        Spec §10: encrypted at rest, read in plaintext by our backend. */}
                    <ul className="flex flex-col gap-1.5">
                      {INFO_LINES.map(({ icon: Icon, text }) => (
                        <li key={text} className="flex items-center gap-2 whitespace-nowrap">
                          <Icon
                            size={12}
                            strokeWidth={1.75}
                            absoluteStrokeWidth
                            aria-hidden="true"
                            className="shrink-0 text-fg-subtle"
                          />
                          {text}
                        </li>
                      ))}
                    </ul>
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
            <Dialog.Root open={historyOpen} onOpenChange={setHistoryOpen}>
              <Dialog.Trigger asChild>
                <button
                  type="button"
                  aria-label="Open chat history"
                  className="inline-flex size-11 cursor-pointer items-center justify-center rounded-sm text-fg-muted hover:bg-surface-2 xl:hidden"
                >
                  <History size={18} aria-hidden="true" />
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-40 bg-bg/80" />
                <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-full max-w-sm flex-col gap-5 border-r border-line bg-surface-1 p-card pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
                  <div className="flex items-center justify-between">
                    <Dialog.Title className="text-h3">Chat history</Dialog.Title>
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        aria-label="Close chat history"
                        className="inline-flex size-11 cursor-pointer items-center justify-center rounded-sm text-fg-muted hover:bg-surface-2"
                      >
                        <X size={18} aria-hidden="true" />
                      </button>
                    </Dialog.Close>
                  </div>
                  <Dialog.Description className="sr-only">
                    Open or delete a saved conversation, or start a new chat.
                  </Dialog.Description>
                  <div className="min-h-0 flex-1">
                    <ChatHistory {...historyProps} onNavigate={closeHistory} />
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <button
              type="button"
              aria-label="New chat"
              title="New chat"
              onClick={newChat}
              className="inline-flex size-11 cursor-pointer items-center justify-center rounded-sm text-fg-muted hover:bg-surface-2 xl:hidden"
            >
              <Plus size={19} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div
          className={`relative flex min-h-0 flex-1 flex-col ${empty ? "justify-center pb-12 sm:pb-20" : ""}`}
        >
          <ScrollArea.Root className={empty ? "min-h-0 shrink" : "min-h-0 flex-1"}>
            <ScrollArea.Viewport
              ref={scroller}
              onScroll={(event) => {
                const element = event.currentTarget;
                const movedUp = element.scrollTop < previousScrollTop.current;
                previousScrollTop.current = element.scrollTop;
                setFollowing(!movedUp && element.scrollHeight - element.scrollTop - element.clientHeight < 4);
              }}
              onWheel={(event) => {
                if (event.deltaY < 0 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                  setFollowing(false);
                }
              }}
              className={`${empty ? "max-h-full" : "h-full"} w-full overscroll-y-contain`}
              disableImplicitContentElement
              data-lenis-prevent
              tabIndex={0}
              aria-label="Conversation messages"
              role="region"
            >
              <ScrollArea.Content
                ref={threadContent}
                style={{ display: "block", minWidth: 0, width: "100%" }}
              >
                {chat.loading ? <JarvisLoading /> : null}
                {chat.hasEarlier ? (
                  <button
                    type="button"
                    disabled={chat.checking}
                    onClick={() => void chat.earlier()}
                    className="min-h-11 rounded-sm px-3 text-small text-accent-text"
                  >
                    {chat.checking ? "Loading…" : "Load earlier messages"}
                  </button>
                ) : null}
                {chat.turns.length ? (
                  <div className="mx-auto max-w-reading space-y-8 py-5 pr-2 sm:space-y-10 sm:py-6">
                    {chat.turns.map((turn) => (
                      <ChatMessage
                        key={turn.id}
                        turn={turn}
                        last={turn.id === last?.id}
                        busy={turn.id === last?.id && chat.busy}
                        onRetry={chat.retry}
                        pendingReply={
                          turn.id === last?.id && chat.busy
                            ? {
                                content: chat.preview,
                                status: chat.stopping
                                  ? stoppingStatus
                                  : chat.preview || showStatus
                                    ? chat.status
                                    : "",
                                checking: chat.checking,
                                onCheck: chat.sending ? null : () => void chat.check(),
                              }
                            : null
                        }
                      />
                    ))}
                  </div>
                ) : empty ? (
                  <ChatEmptyState
                    onPrompt={(prompt) => {
                      chat.setDraft(prompt);
                      chat.inputRef.current?.focus();
                    }}
                  />
                ) : null}
              </ScrollArea.Content>
            </ScrollArea.Viewport>
            {/* Radix only lets the viewport scroll while a scrollbar is mounted, so it stays mounted but hidden:
                the thread scrolls by wheel, touch and keyboard with no visible bar. */}
            <ScrollArea.Scrollbar orientation="vertical" className="hidden" />
          </ScrollArea.Root>
          {(last?.sequence ?? 0) >= MAX_CHAT_TURNS && !chat.busy ? (
            <p className="mx-auto max-w-reading py-2 text-small text-fg-muted">
              You’ve reached this chat’s message limit. Start a new chat to continue.
            </p>
          ) : null}
          <div className="relative shrink-0">
            <ChatComposer
              value={chat.draft}
              busy={chat.busy}
              stopping={chat.stopping}
              disabled={(last?.sequence ?? 0) >= MAX_CHAT_TURNS && !chat.busy}
              inputRef={chat.inputRef}
              onChange={chat.setDraft}
              onSend={sendDraft}
              onStop={stopReply}
              tool={chat.tool}
              onToolChange={chat.setTool}
              agentOffer={agentOffer}
            />
          </div>
        </div>
      </div>
      {agentSetup ? (
        <CreateAgentDialog
          request={agentSetup.open ? { pack: agentSetup.pack, brief: "" } : null}
          launch={launch}
          onClose={() => {
            setAgentSetup((current) => (current ? { ...current, open: false } : null));
            chat.inputRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      <DeleteChatDialog chat={deletion} onCancel={cancelDeletion} onConfirm={confirmDeletion} />
    </section>
  );
}
