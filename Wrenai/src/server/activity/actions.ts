"use server";

import { currentUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { type ActivityResult, activityRequestSchema } from "@/shared/activity";
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
  const rate = await consumeRateLimit(`activity:read:${user.id}`, 30, 60_000);
  if (rate !== "allowed") {
    return {
      ok: false,
      code: rate === "limited" ? "rate_limited" : "unavailable",
      message: "Activity cannot be refreshed right now. Try again shortly.",
    };
  }
  try {
    return {
      ok: true,
      value: await readActivityPage(database(), user, input.data.filter, input.data.cursor),
    };
  } catch {
    return { ok: false, code: "unavailable", message: "Activity could not be loaded. Try refreshing." };
  }
}
