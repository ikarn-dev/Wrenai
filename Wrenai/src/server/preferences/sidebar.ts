import "server-only";
import { cookies } from "next/headers";
import { SIDEBAR_COOKIE } from "@/shared/sidebar";

/**
 * True when the user collapsed the sidebar to icons. The browser writes this display preference itself (no server
 * request that could fail); the server only reads it to render the right width on first paint.
 */
export async function readSidebarCollapsed(): Promise<boolean> {
  return (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";
}
