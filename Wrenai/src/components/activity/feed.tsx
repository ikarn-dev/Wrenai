"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowUpRight, History, RefreshCw } from "lucide-react";
import Link from "next/link";
import { type ReactElement, useState } from "react";
import { loadActivity } from "@/server/activity/actions";
import type { ActivityCursor, ActivityFilter, ActivityPage, ActivityResult } from "@/shared/activity";
import { ActivityRow } from "./row";
import { ActivitySkeleton } from "./skeleton";

const filters = [
  { id: "all", label: "All activity" },
  { id: "wallet", label: "Wallet" },
  { id: "agents", label: "Agents" },
] as const;
interface ActivityFeedProps {
  readonly ownerId: string;
  readonly initial: ActivityResult;
  readonly full: boolean;
}

export function ActivityFeed({ ownerId, initial, full }: ActivityFeedProps): ReactElement {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [refresh, setRefresh] = useState(0);
  const query = useInfiniteQuery({
    queryKey: ["activity", ownerId, initial.ok ? initial.value.snapshotAt : 0, filter, refresh],
    initialPageParam: null,
    queryFn: async ({ pageParam }: { readonly pageParam: ActivityCursor | null }): Promise<ActivityPage> => {
      const result = await loadActivity({ filter, cursor: pageParam });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
    getNextPageParam: (page) => page.nextCursor,
    ...(initial.ok && filter === "all" && refresh === 0
      ? { initialData: { pages: [initial.value], pageParams: [null] } }
      : {}),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const pages = query.data?.pages ?? [];
  const items = Array.from(
    new Map(pages.flatMap((page) => page.items).map((item) => [item.id, item])).values(),
  );
  const visible = full ? items : items.slice(0, 6);
  const unavailable = Array.from(new Set(pages.flatMap((page) => page.unavailable)));
  return (
    <div className="min-w-0 card-shine rounded-lg px-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-card py-3">
        <fieldset className="flex min-w-0 gap-1">
          <legend className="sr-only">Filter activity</legend>
          {filters.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
              className={`min-h-9 rounded-xs px-3 text-small transition-colors pointer-coarse:min-h-11 ${filter === option.id ? "bg-surface-2 text-fg-strong" : "text-fg-muted hover:bg-surface-2 hover:text-fg-strong"}`}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={query.isFetching}
          aria-label="Refresh activity"
          title="Refresh activity"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-strong disabled:opacity-50 pointer-coarse:size-11"
        >
          <RefreshCw
            size={16}
            strokeWidth={1.5}
            aria-hidden="true"
            className={query.isFetching ? "motion-safe:animate-spin" : ""}
          />
        </button>
      </div>
      {unavailable.length > 0 ? (
        <p role="status" className="border-b border-line-card py-3 text-caption text-warn">
          {unavailable.join(", ")} unavailable. Refresh to retry.
        </p>
      ) : null}
      {query.isPending ? (
        <div className="py-4">
          <ActivitySkeleton />
        </div>
      ) : visible.length > 0 ? (
        <ol aria-label="Activity timeline" className="divide-y divide-line-card">
          {visible.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </ol>
      ) : !query.isError ? (
        <div className="flex min-h-44 flex-col items-center justify-center gap-2 py-8 text-center">
          <History size={20} strokeWidth={1.5} aria-hidden="true" className="text-fg-subtle" />
          <p className="text-body text-fg-strong">
            {unavailable.length > 0 ? "No activity loaded" : "No activity yet"}
          </p>
          <p className="text-small text-fg-muted">
            {unavailable.length > 0
              ? "Some sources could not be reached."
              : filter === "wallet"
                ? "Wallet transfers and transactions will appear here."
                : filter === "agents"
                  ? "Agent updates and trades will appear here."
                  : "Wallet transactions and agent updates will appear here."}
          </p>
        </div>
      ) : null}
      {query.isError ? (
        <p role="alert" className="py-4 text-small text-warn">
          {query.error.message}{" "}
          <button
            type="button"
            className="min-h-9 underline underline-offset-4"
            onClick={() => {
              if (pages.length > 0) {
                void query.fetchNextPage();
              } else {
                setRefresh((value) => value + 1);
              }
            }}
          >
            Try again
          </button>
        </p>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line-card py-3">
        <p className="text-caption text-fg-subtle">
          {filter === "agents" ? "Wrenai records · UTC" : "NearBlocks + Wrenai records · UTC"}
        </p>
        {full ? (
          query.hasNextPage ? (
            <button
              type="button"
              disabled={query.isFetching}
              onClick={() => {
                void query.fetchNextPage();
              }}
              className="min-h-9 rounded-xs px-3 text-small text-fg-muted hover:bg-surface-2 hover:text-fg-strong disabled:opacity-50 pointer-coarse:min-h-11"
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          ) : null
        ) : (
          <Link
            href="/activity"
            prefetch={false}
            className="inline-flex min-h-9 items-center gap-1.5 text-small text-fg-muted hover:text-fg-strong pointer-coarse:min-h-11"
          >
            View all activity <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        )}
      </footer>
    </div>
  );
}
