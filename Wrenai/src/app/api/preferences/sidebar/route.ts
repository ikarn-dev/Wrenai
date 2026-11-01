import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/server/auth/session";
import { serverEnv } from "@/server/env";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { writeSidebarCollapsed } from "@/server/preferences/sidebar";

const SAVES_PER_WINDOW = 30;
const WINDOW_MS = 60_000;
const bodySchema = z.strictObject({ collapsed: z.boolean() });

function fail(status: number, code: string): NextResponse {
  return NextResponse.json({ ok: false, code }, { status });
}

/**
 * Saves the sidebar width. A Route Handler, not a Server Action: setting a cookie in a Server Action makes Next
 * re-render the whole page (layout, NEAR reads, queries) on every toggle; here only the cookie changes.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Same-origin only; the session cookie is SameSite=Lax as well, so a cross-site POST arrives signed out.
  if (request.headers.get("origin") !== serverEnv().appOrigin) {
    return fail(403, "forbidden");
  }
  const user = await currentUser();
  if (user === null) {
    return fail(401, "signed_out");
  }
  const decision = await consumeRateLimit(`preferences:${user.id}`, SAVES_PER_WINDOW, WINDOW_MS);
  if (decision !== "allowed") {
    return fail(decision === "limited" ? 429 : 503, decision === "limited" ? "rate_limited" : "unavailable");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Not JSON: the request is malformed, which the parse below reports.
    body = null;
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, "invalid_request");
  }
  await writeSidebarCollapsed(parsed.data.collapsed);
  return new NextResponse(null, { status: 204 });
}
