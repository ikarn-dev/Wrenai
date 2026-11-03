import { ActivitySkeleton } from "@/components/activity/skeleton";

export default function ActivityLoading() {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <h1 className="font-display text-page-title">Activity</h1>
      <ActivitySkeleton />
    </div>
  );
}
