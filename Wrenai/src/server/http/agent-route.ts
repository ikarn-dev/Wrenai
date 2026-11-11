import "server-only";
import { serverEnv } from "@/server/env";
import type { AgentFailureCode, AgentResult } from "@/shared/agents";
import { reportUnexpectedError } from "./unexpected-error";

const MAX_BODY_BYTES = 20_000;
const PRIVATE = { "Cache-Control": "private, no-store" };

function status(code: AgentFailureCode): number {
  switch (code) {
    case "signed_out":
      return 401;
    case "invalid_input":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
    case "in_progress":
      return 409;
    case "rate_limited":
      return 429;
    default:
      return 503;
  }
}

export function agentFailureResponse(code: AgentFailureCode, message: string): Response {
  return Response.json({ ok: false, code, message }, { status: status(code), headers: PRIVATE });
}

/**
 * Same-origin JSON POST for long agent requests. Route handlers, not Server Actions: Next runs Server Actions one
 * at a time and holds the router while they run, which froze and re-rendered the page behind the create dialog.
 * Unexpected failures are logged by type only and return a stable code instead of an HTML error page.
 */
export async function agentPost<T>(
  request: Request,
  run: (body: unknown) => Promise<AgentResult<T>>,
): Promise<Response> {
  if (request.headers.get("origin") !== serverEnv().appOrigin) {
    return agentFailureResponse("invalid_input", "Open Wrenai to manage agents.");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return agentFailureResponse("invalid_input", "This request is too long. Shorten it and try again.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return agentFailureResponse("invalid_input", "The request could not be read. Try again.");
  }
  try {
    const result = await run(body);
    return Response.json(result, { status: result.ok ? 200 : status(result.code), headers: PRIVATE });
  } catch (error) {
    reportUnexpectedError("agent-review", error);
    return agentFailureResponse("unavailable", "Something went wrong. Nothing was saved. Try again.");
  }
}
