"use client";

import { MessageSquare, PanelLeftClose, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { memo, type ReactElement, useMemo, useState } from "react";
import type { ConversationSummary } from "@/shared/chat";

interface HistoryProps {
  readonly items: readonly ConversationSummary[];
  readonly currentId: string;
  readonly refreshing: boolean;
  readonly onNew: () => void;
  readonly onRefresh: () => void;
  readonly onDelete: (item: ConversationSummary) => void;
  readonly onSelect: (id: string) => void;
  readonly onNavigate?: () => void;
  /** Shows a collapse control in the header (the desktop card; the mobile sheet has its own close). */
  readonly onCollapse?: () => void;
}

export const ChatHistory = memo(function ChatHistory({
  items,
  currentId,
  refreshing,
  onNew,
  onRefresh,
  onDelete,
  onNavigate,
  onSelect,
  onCollapse,
}: HistoryProps): ReactElement {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return items.filter((item) => item.title.toLocaleLowerCase().includes(search));
  }, [items, query]);
  return (
    // Same anatomy and states as the app sidebar: a mono eyebrow header, then 36 px rows on a 2 px rhythm,
    // the open chat on the lit nav-active pill. No divider lines.
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex h-8 items-center gap-2 pl-2.5">
        <h2 className="mr-auto font-mono text-eyebrow uppercase text-fg-subtle">Chats</h2>
        <button
          type="button"
          aria-label="Refresh chat history"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
          className="group inline-flex size-8 cursor-pointer items-center justify-center rounded-xs text-fg-subtle transition-colors duration-200 ease-ios hover:text-fg-strong pointer-coarse:size-11"
        >
          <RefreshCw
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
            className={
              refreshing
                ? "motion-safe:animate-spin"
                : "transition-transform duration-500 ease-ios motion-safe:group-hover:rotate-180"
            }
          />
        </button>
        {onCollapse === undefined ? null : (
          <button
            type="button"
            aria-label="Hide chat history"
            title="Hide chats"
            onClick={onCollapse}
            className="-ml-1.5 inline-flex size-8 cursor-pointer items-center justify-center rounded-xs text-fg-subtle transition-colors duration-200 ease-ios hover:text-fg-strong pointer-coarse:size-11"
          >
            <PanelLeftClose size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          onNew();
          onNavigate?.();
        }}
        className="flex h-9 cursor-pointer items-center justify-center gap-2 card-shine rounded-lg-inset px-3 text-small font-medium text-fg-strong transition-[scale] duration-200 ease-ios active:scale-98 motion-reduce:active:scale-100 pointer-coarse:h-11"
      >
        <Plus
          size={15}
          strokeWidth={1.75}
          absoluteStrokeWidth
          aria-hidden="true"
          className="text-accent-text"
        />
        New chat
      </button>
      {items.length ? (
        <label className="flex h-9 items-center gap-2 rounded-lg-inset bg-sunken px-2.5 ring-1 ring-line-card ring-inset transition-shadow duration-200 ease-ios focus-within:ring-line-strong pointer-coarse:h-11">
          <Search
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            className="shrink-0 text-fg-subtle"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a chat"
            aria-label="Find a saved chat"
            className="w-full min-w-0 bg-transparent text-small text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none"
          />
        </label>
      ) : null}
      <nav
        aria-label="Saved conversations"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        data-lenis-prevent
      >
        {filtered.length ? (
          <ul className="flex flex-col gap-0.5">
            {filtered.map((item) => {
              const current = item.id === currentId;
              return (
                <li
                  key={item.id}
                  className={`group flex min-w-0 items-center rounded-lg-inset transition-colors duration-200 ease-ios ${current ? "nav-active text-fg-strong" : "text-fg-muted hover:text-fg-strong"}`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(item.id);
                      onNavigate?.();
                    }}
                    aria-current={current ? "page" : undefined}
                    className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg-inset px-2.5 text-small pointer-coarse:h-11"
                  >
                    <MessageSquare
                      size={14}
                      strokeWidth={1.75}
                      absoluteStrokeWidth
                      aria-hidden="true"
                      className="shrink-0"
                    />
                    <span className="truncate">{item.title}</span>
                  </button>
                  {/* Shown on the open chat, on hover and on focus, so idle rows stay quiet. */}
                  <button
                    type="button"
                    onClick={() => onDelete(item)}
                    aria-label={`Delete chat: ${item.title}`}
                    className={`mr-0.5 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-xs text-fg-subtle transition-[color,opacity] duration-200 ease-ios hover:text-loss focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100 ${current ? "opacity-100" : "opacity-0"}`}
                  >
                    <Trash2 size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-5 text-small leading-relaxed text-fg-subtle">
            {query.trim() ? "No chats match your search." : "No chats yet."}
          </p>
        )}
      </nav>
    </div>
  );
});
