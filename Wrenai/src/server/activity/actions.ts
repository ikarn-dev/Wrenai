"use server";

import { currentUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { type ActivityResult, activityRequestSchema } from "@/shared/activity";
import { type ActivitySlot, loadActivityOnce, readActivityCache } from "./page-cache";
import { readActivityPage } from "./service";

export async function loadActivity(raw: unknown): Promise<ActivityResult> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in to view your activity." };
  }
  const input = activityRequestSchema.safeParse(raw);
  if (
    !input.success ||
    (input.data.cursor &&
      (input.data.cursor.ownerId !== user.id ||
        input.data.cursor.filter !== input.data.filter ||
        input.data.cursor.snapshotAt > Date.now()))
  ) {
    return { ok: false, code: "invalid_input", message: "Refresh activity to start a new view." };
  }
  const { filter, cursor, fresh } = input.data;
  const slot: ActivitySlot = { ownerId: user.id, filter, cursor };
  // The cache read has no side effects, so it runs alongside the rate-limit check instead of after it; its result
  // is used only once the request is allowed.
  const [rate, cached] = await Promise.all([
    consumeRateLimit(`activity:read:${user.id}`, 30, 60_000),
    fresh && cursor === null ? Promise.resolve(null) : readActivityCache(slot),
  ]);
  if (rate !== "allowed") {
    return {
      ok: false,
      code: rate === "limited" ? "rate_limited" : "unavailable",
      message:
        rate === "limited"
          ? "Too many activity requests. Wait a minute, then try again."
          : "Activity cannot be loaded right now. Try again shortly.",
    };
  }
  if (cached !== null) {
    return { ok: true, value: cached };
  }
  try {
    return {
      ok: true,
      value: await loadActivityOnce(slot, () => readActivityPage(database(), user, filter, cursor)),
    };
  } catch {
    return { ok: false, code: "unavailable", message: "Activity could not be loaded. Try refreshing." };
  }
}
