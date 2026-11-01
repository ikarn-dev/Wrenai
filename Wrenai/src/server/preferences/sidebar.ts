import "server-only";
import { cookies } from "next/headers";
import { serverEnv } from "@/server/env";

// A display preference, not a secret: the server reads it to render the sidebar at the right width on first paint,
// so a reload never flashes the wide sidebar before it collapses.
const SIDEBAR_COOKIE = "wrenai_sidebar";
const ONE_YEAR_S = 365 * 24 * 60 * 60;

/** True when the user collapsed the sidebar to icons. */
export async function readSidebarCollapsed(): Promise<boolean> {
  return (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";
}

/** Call only from a Server Action. */
export async function writeSidebarCollapsed(collapsed: boolean): Promise<void> {
  (await cookies()).set(SIDEBAR_COOKIE, collapsed ? "collapsed" : "expanded", {
    httpOnly: true,
    secure: serverEnv().secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR_S,
  });
}
