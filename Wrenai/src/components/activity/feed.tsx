"use client";

import { ArrowRight, History, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import type { ActivityFilter, ActivityResult } from "@/shared/activity";
import { ActivityFilterMenu } from "./filter-menu";
import { ActivityPager } from "./pager";
import { ActivityRow } from "./row";
import { ActivitySkeletonRows } from "./skeleton";
import { ActivityTable } from "./table";
import { useActivityPages } from "./use-activity-pages";

const ICON = { "aria-hidden": true, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;
const QUIET_BUTTON =
  "inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-small text-fg-muted transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong disabled:cursor-default disabled:text-fg-disabled pointer-coarse:min-h-11";
const PREVIEW_ROWS = 6;

const EMPTY_TEXT: Readonly<Record<ActivityFilter, string>> = {
  all: "Wallet transactions and agent updates will appear here.",
  wallet: "Wallet transfers and transactions will appear here.",
  agents: "Agent updates and trades will appear here.",
};

interface ActivityFeedProps {
  readonly ownerId: string;
  readonly initial: ActivityResult;
  readonly full: boolean;
}

export function ActivityFeed({ ownerId, initial, full }: ActivityFeedProps): ReactElement {
  const activity = useActivityPages(ownerId, initial);
  const rows = activity.page?.items ?? [];
  const visible = full ? rows : rows.slice(0, PREVIEW_ROWS);
  const unavailable = activity.page?.unavailable ?? [];
  const first = activity.firstRow;
  return (
    <div className="min-w-0 overflow-hidden card-shine rounded-lg">
      <div className="flex items-center justify-between gap-3 px-card py-3">
        <ActivityFilterMenu value={activity.filter} onChange={activity.setFilter} />
        <button
          type="button"
          onClick={activity.refresh}
          disabled={activity.fetching}
          aria-label={activity.fetching ? "Loading activity" : "Refresh activity"}
          title="Refresh activity"
          className="group inline-flex size-8 shrink-0 cursor-pointer items-center justify-center card-shine rounded-full text-fg-muted transition-[color,scale] duration-300 ease-ios hover:text-fg-strong active:scale-92 disabled:cursor-default motion-reduce:active:scale-100 pointer-coarse:size-11"
        >
          <RefreshCw
            {...ICON}
            size={15}
            className={
              activity.fetching
                ? "motion-safe:animate-spin"
                : "transition-transform duration-500 ease-ios motion-safe:group-hover:rotate-180"
            }
          />
        </button>
      </div>
      {unavailable.length > 0 ? (
        <p
          role="status"
          className="flex items-center gap-2 border-t border-line-card bg-warn-soft px-card py-2.5 text-caption text-warn"
        >
          <TriangleAlert {...ICON} size={14} className="shrink-0" />
          {unavailable.join(", ")} unavailable. Refresh to retry.
        </p>
      ) : null}
      {activity.pending || visible.length > 0 ? (
        <ActivityTable label={full ? `Activity, page ${activity.pageIndex + 1}` : "Latest activity"}>
          {activity.pending ? (
            <ActivitySkeletonRows />
          ) : (
            visible.map((item) => <ActivityRow key={item.id} item={item} />)
          )}
        </ActivityTable>
      ) : activity.error === null ? (
        <div className="relative flex min-h-44 flex-col items-center justify-center gap-2 border-t border-line-card px-card py-8 text-center">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
          <History {...ICON} size={20} className="relative text-fg-subtle" />
          <p className="relative text-body text-fg-strong">
            {unavailable.length > 0 ? "No activity loaded" : "No activity yet"}
          </p>
          <p className="relative text-small text-fg-muted">
            {unavailable.length > 0 ? "Some sources could not be reached." : EMPTY_TEXT[activity.filter]}
          </p>
        </div>
      ) : null}
      {activity.error === null ? null : (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-2 border-t border-line-card px-card py-3 text-small text-warn"
        >
          <TriangleAlert {...ICON} size={14} className="shrink-0" />
          {activity.error}
          <button
            type="button"
            className={QUIET_BUTTON}
            onClick={activity.retry}
            disabled={activity.fetching}
          >
            Try again
          </button>
        </p>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line-card px-card py-2.5">
        <p className="text-caption text-fg-subtle">
          {full && rows.length > 0 ? (
            <>
              <span className="font-mono tabular-nums text-fg-muted">
                {first}–{first + rows.length - 1}
              </span>{" "}
              ·{" "}
            </>
          ) : null}
          {activity.filter === "agents" ? "Wrenai records" : "NearBlocks and Wrenai records"} · UTC
        </p>
        {full ? (
          activity.loadedPages > 1 || activity.hasMore ? (
            <ActivityPager
              current={activity.pageIndex}
              loaded={activity.loadedPages}
              hasMore={activity.hasMore}
              loadingMore={activity.loadingMore}
              onSelect={activity.showPage}
              onNext={() => void activity.nextPage()}
              onNextIntent={activity.prefetchNext}
            />
          ) : null
        ) : (
          <Link href="/activity" prefetch={false} className={QUIET_BUTTON}>
            View all activity
            <ArrowRight {...ICON} size={14} />
          </Link>
        )}
      </footer>
    </div>
  );
}
