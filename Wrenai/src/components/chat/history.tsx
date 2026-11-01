"use client";

import { MessageSquare, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
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
}: HistoryProps): ReactElement {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return items.filter((item) => item.title.toLocaleLowerCase().includes(search));
  }, [items, query]);
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-small font-medium text-fg-muted">Chats</h2>
        <button
          type="button"
          aria-label="Refresh chat history"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex size-10 cursor-pointer items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-2 hover:text-fg-strong disabled:cursor-progress pointer-coarse:size-11"
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          onNew();
          onNavigate?.();
        }}
        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm bg-surface-2 px-3 text-small text-fg hover:bg-surface-3"
      >
        <Plus size={16} aria-hidden="true" />
        New chat
      </button>
      {items.length ? (
        <label className="flex min-h-11 items-center gap-2 rounded-sm border border-line bg-surface-1 px-3 focus-within:border-line-strong">
          <Search size={15} className="shrink-0 text-fg-subtle" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a chat"
            aria-label="Find a saved chat"
            className="min-w-0 w-full bg-surface-1 text-small text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none"
          />
        </label>
      ) : null}
      <nav
        aria-label="Saved conversations"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        data-lenis-prevent
      >
        {filtered.length ? (
          <ul className="space-y-1">
            {filtered.map((item) => (
              <li
                key={item.id}
                className={`flex min-w-0 items-center rounded-sm ${item.id === currentId ? "bg-surface-2" : "hover:bg-surface-2"}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelect(item.id);
                    onNavigate?.();
                  }}
                  aria-current={item.id === currentId ? "page" : undefined}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-small text-fg-muted"
                >
                  <MessageSquare size={14} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">{item.title}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(item)}
                  aria-label={`Delete chat: ${item.title}`}
                  className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-subtle hover:text-loss pointer-coarse:size-11"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
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
