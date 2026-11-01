import type { ReactElement } from "react";
import { loadActivity } from "@/server/activity/actions";
import { ActivityFeed } from "./feed";

export async function AccountActivity({
  ownerId,
  full = false,
}: {
  readonly ownerId: string;
  readonly full?: boolean;
}): Promise<ReactElement> {
  const initial = await loadActivity({ filter: "all", cursor: null });
  return (
    <ActivityFeed
      key={initial.ok ? initial.value.snapshotAt : "unavailable"}
      ownerId={ownerId}
      initial={initial}
      full={full}
    />
  );
}
