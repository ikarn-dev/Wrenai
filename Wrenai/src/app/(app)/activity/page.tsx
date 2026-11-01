import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountActivity } from "@/components/activity/account-activity";
import { ActivitySkeleton } from "@/components/activity/skeleton";
import { requireUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage() {
  const user = await requireUser();
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-page-title">Activity</h1>
        <p className="text-small text-fg-muted">Your wallet and agents, in one timeline.</p>
      </header>
      <Suspense fallback={<ActivitySkeleton />}>
        <AccountActivity ownerId={user.id} full />
      </Suspense>
    </div>
  );
}
