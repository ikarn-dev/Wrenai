"use client";

import { ArrowDown, History, Info, Plus, X } from "lucide-react";
import { AlertDialog, Dialog, Popover, ScrollArea } from "radix-ui";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/button";
import { loadChatHistory, removeConversation } from "@/server/chat/actions";
import { type Conversation, type ConversationSummary, MAX_CHAT_TURNS } from "@/shared/chat";
import { ChatComposer } from "./composer";
import { ChatEmptyState } from "./empty-state";
import { ChatHistory } from "./history";
import { JarvisMark } from "./jarvis-mark";
import { ChatMessage } from "./message";
import { useChat } from "./use-chat";

interface ChatScreenProps {
  readonly initialId: string;
  readonly initialPrompt?: string;
  readonly conversation: Conversation | null;
  readonly history: readonly ConversationSummary[];
}

export function ChatScreen({
  initialId,
  initialPrompt = "",
  conversation,
  history,
}: ChatScreenProps): ReactElement {
  const chat = useChat(initialId, conversation, history, initialPrompt);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deletion, setDeletion] = useState<ConversationSummary | null>(null);
  const [managing, startTransition] = useTransition();
  const [managementError, setManagementError] = useState<string | null>(null);
  const [showStatus, setShowStatus] = useState(false);
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

  function setFollowing(value: boolean): void {
    following.current = value;
    setAtBottom(value);
  }

  const refreshHistory = useCallback((): void => {
    startTransition(async () => {
      try {
        const result = await loadChatHistory();
        if (result.ok) {
          chat.setHistory(result.value);
        } else {
          chat.setError(result.message);
        }
      } catch {
        chat.setError("Chat history could not be refreshed. Try again.");
      }
    });
  }, [chat.setHistory, chat.setError]);

  function deleteChat(): void {
    if (!deletion) {
      return;
    }
    const id = deletion.id;
    setManagementError(null);
    startTransition(async () => {
      try {
        const result = await removeConversation(id);
        if (!result.ok) {
          setManagementError(result.message);
          return;
        }
        chat.setHistory((items) => items.filter((item) => item.id !== id));
        chat.forget(id);
        setDeletion(null);
      } catch {
        setManagementError("The deletion could not be confirmed. Refresh history to check.");
      }
    });
  }

  const newChat = useCallback((): void => {
    following.current = true;
    setAtBottom(true);
    chat.newChat();
  }, [chat.newChat]);

  const chooseDeletion = useCallback((item: ConversationSummary): void => {
    setManagementError(null);
    setDeletion(item);
  }, []);
  const closeHistory = useCallback((): void => setHistoryOpen(false), []);

  const historyProps = {
    items: chat.history,
    onSelect: chat.select,
    currentId: chat.conversationId,
    refreshing: managing,
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
      <aside className="hidden w-64 shrink-0 card-shine rounded-lg p-2 xl:block">
        <ChatHistory {...historyProps} />
      </aside>
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
          <div className="flex min-w-0 flex-col">
            <h1 className="text-h3">Jarvis</h1>
            <p className="text-caption text-fg-subtle">Read-only assistant</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Popover.Root>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label="About Jarvis"
                  title="About Jarvis"
                  className="inline-flex size-11 cursor-pointer items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-2 hover:text-fg-muted"
                >
                  <Info size={17} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  aria-label="About Jarvis"
                  align="end"
                  sideOffset={8}
                  className="z-50 max-w-72 rounded-md border border-line bg-surface-1 p-4 text-small leading-relaxed text-fg-muted"
                >
                  <p>
                    Wallet balance and agent status are included automatically. Chat provides information;
                    agent setup requires your review.
                  </p>
                  <p className="mt-3">
                    Chats are encrypted in storage. Wrenai’s backend processes them in plaintext.
                  </p>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
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
                {chat.loading ? (
                  <p role="status" className="py-6 text-small text-fg-subtle">
                    Loading conversation…
                  </p>
                ) : null}
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
                        conversationId={chat.conversationId}
                        turn={turn}
                        last={turn.id === last?.id}
                        busy={turn.id === last?.id && chat.busy}
                        onRetry={chat.retry}
                        pendingReply={
                          turn.id === last?.id && chat.busy
                            ? {
                                content: chat.preview,
                                status: chat.stopping
                                  ? "Stopping reply…"
                                  : chat.preview
                                    ? chat.status || "Verification pending"
                                    : showStatus
                                      ? chat.status || "A reply is in progress."
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
            <ScrollArea.Scrollbar orientation="vertical" className="flex w-1.5 touch-none select-none p-px">
              <ScrollArea.Thumb className="relative flex-1 rounded-full bg-line-strong" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
          {chat.error ? (
            <p role="alert" className="mx-auto w-full max-w-reading py-3 text-small text-warn">
              {chat.error}
            </p>
          ) : null}
          {(last?.sequence ?? 0) >= MAX_CHAT_TURNS && !chat.busy ? (
            <p className="mx-auto max-w-reading py-2 text-small text-fg-muted">
              You’ve reached this chat’s message limit. Start a new chat to continue.
            </p>
          ) : null}
          <div className="relative shrink-0">
            {!atBottom && chat.turns.length ? (
              <button
                type="button"
                aria-label="Jump to latest message"
                onClick={() => {
                  setFollowing(true);
                  scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "instant" });
                }}
                className="absolute bottom-full left-1/2 mb-3 inline-flex size-9 -translate-x-1/2 cursor-pointer items-center justify-center card-shine rounded-full text-fg-muted transition-colors duration-200 ease-ios hover:text-fg-strong pointer-coarse:size-11"
              >
                <ArrowDown size={18} aria-hidden="true" />
              </button>
            ) : null}
            <ChatComposer
              value={chat.draft}
              busy={chat.busy}
              stopping={chat.stopping}
              disabled={(last?.sequence ?? 0) >= MAX_CHAT_TURNS && !chat.busy}
              inputRef={chat.inputRef}
              onChange={chat.setDraft}
              onSend={() => {
                setFollowing(true);
                chat.submit();
              }}
              onStop={() => void chat.stop()}
            />
          </div>
        </div>
      </div>
      <AlertDialog.Root
        open={deletion !== null}
        onOpenChange={(open) => {
          if (!open && !managing) {
            setDeletion(null);
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-bg/80" />
          <AlertDialog.Content className="card-shine fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-1/2 flex-col gap-5 rounded-lg p-card">
            <AlertDialog.Title className="text-h2">Delete this chat?</AlertDialog.Title>
            <AlertDialog.Description className="text-body text-fg-muted">
              This deletes the saved text in “{deletion?.title}” and its messages. A pending reply cannot
              restore a deleted chat.
            </AlertDialog.Description>
            <div className="flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <Button disabled={managing}>Keep chat</Button>
              </AlertDialog.Cancel>
              <Button variant="destructive" disabled={managing} onClick={deleteChat}>
                {managing ? "Deleting…" : "Delete chat"}
              </Button>
            </div>
            {managementError ? (
              <p role="alert" className="text-small text-loss">
                {managementError}
              </p>
            ) : null}
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
