"use server";

import { z } from "zod";
import { currentUser } from "@/server/auth/session";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { writeSidebarCollapsed } from "./sidebar";

const SAVES_PER_WINDOW = 30;
const WINDOW_MS = 60_000;

const sidebarInputSchema = z.strictObject({ collapsed: z.boolean() });

export type PreferenceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "signed_out" | "rate_limited" | "unavailable" | "invalid_request" };

/** Remembers whether the sidebar is collapsed, so the next full load renders it that way. */
export async function rememberSidebar(input: unknown): Promise<PreferenceResult> {
  const user = await currentUser();
  if (user === null) {
    return { ok: false, code: "signed_out" };
  }
  const decision = await consumeRateLimit(`preferences:${user.id}`, SAVES_PER_WINDOW, WINDOW_MS);
  if (decision !== "allowed") {
    return { ok: false, code: decision === "limited" ? "rate_limited" : "unavailable" };
  }
  const parsed = sidebarInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "invalid_request" };
  }
  await writeSidebarCollapsed(parsed.data.collapsed);
  return { ok: true };
}
