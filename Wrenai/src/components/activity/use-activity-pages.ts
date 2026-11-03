"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { loadActivity } from "@/server/activity/actions";
import type { ActivityCursor, ActivityFilter, ActivityPage, ActivityResult } from "@/shared/activity";

export interface ActivityPages {
  readonly filter: ActivityFilter;
  readonly setFilter: (filter: ActivityFilter) => void;
  readonly page: ActivityPage | null;
  readonly pageIndex: number;
  /** 1-based position of the shown page's first row across loaded pages. */
  readonly firstRow: number;
  readonly loadedPages: number;
  readonly hasMore: boolean;
  readonly pending: boolean;
  readonly fetching: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly showPage: (index: number) => void;
  readonly nextPage: () => Promise<void>;
  readonly prefetchNext: () => void;
  readonly retry: () => void;
  readonly refresh: () => void;
}

/**
 * Activity pages for one filter. Every loaded page stays in the query cache (staleTime Infinity, kept 5 minutes
 * after it is last shown), so switching pages or filters back never refetches; only Refresh asks the server
 * for a new snapshot, and only that first request skips the server's cache.
 */
export function useActivityPages(ownerId: string, initial: ActivityResult): ActivityPages {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [generation, setGeneration] = useState(0);
  // The page shown per filter and refresh, derived in render: a new view starts on its first page.
  const [shown, setShown] = useState<Readonly<Record<string, number>>>({});
  const view = `${filter}:${generation}`;
  const query = useInfiniteQuery({
    queryKey: ["activity", ownerId, initial.ok ? initial.value.snapshotAt : 0, filter, generation],
    initialPageParam: null,
    queryFn: async ({ pageParam }: { readonly pageParam: ActivityCursor | null }): Promise<ActivityPage> => {
      const result = await loadActivity({
        filter,
        cursor: pageParam,
        fresh: generation > 0 && pageParam === null,
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
    getNextPageParam: (page) => page.nextCursor,
    ...(initial.ok && filter === "all" && generation === 0
      ? { initialData: { pages: [initial.value], pageParams: [null] } }
      : {}),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const pages = query.data?.pages ?? [];
  const pageIndex = Math.min(shown[view] ?? 0, Math.max(pages.length - 1, 0));
  const showPage = (index: number): void => setShown((current) => ({ ...current, [view]: index }));
  // cancelRefetch: false joins a request already running (a hover prefetch, a double click) instead of
  // cancelling and repeating it, so each page is requested once.
  const fetchMore = () => query.fetchNextPage({ cancelRefetch: false });
  return {
    filter,
    setFilter,
    page: pages[pageIndex] ?? null,
    pageIndex,
    firstRow: pages.slice(0, pageIndex).reduce((count, page) => count + page.items.length, 0) + 1,
    loadedPages: pages.length,
    hasMore: query.hasNextPage,
    pending: query.isPending,
    fetching: query.isFetching,
    loadingMore: query.isFetchingNextPage,
    error: query.isError ? query.error.message : null,
    showPage,
    async nextPage() {
      if (pageIndex + 1 < pages.length) {
        showPage(pageIndex + 1);
        return;
      }
      if (!query.hasNextPage) {
        return;
      }
      const result = await fetchMore();
      if ((result.data?.pages.length ?? 0) > pageIndex + 1) {
        showPage(pageIndex + 1);
      }
    },
    prefetchNext() {
      if (pageIndex === pages.length - 1 && query.hasNextPage && !query.isError) {
        void fetchMore();
      }
    },
    retry() {
      if (pages.length > 0) {
        void fetchMore();
      } else {
        setGeneration((value) => value + 1);
      }
    },
    refresh() {
      if (!query.isFetching) {
        setGeneration((value) => value + 1);
      }
    },
  };
}
