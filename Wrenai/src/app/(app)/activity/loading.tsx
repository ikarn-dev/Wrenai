import { ActivitySkeleton } from "@/components/activity/skeleton";

export default function ActivityLoading() {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-page-title">Activity</h1>
        <p className="text-small text-fg-muted">Your wallet and agents, in one timeline.</p>
      </header>
      <ActivitySkeleton />
    </div>
  );
}
