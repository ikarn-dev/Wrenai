import "server-only";
import { z } from "zod";

const causeCode = z.object({ cause: z.object({ code: z.string().max(16) }) });
const ownCode = z.object({ code: z.string().max(40) });

/**
 * Logs an unexpected failure that users only see as one generic line. Names the error class and its code
 * (a Postgres SQLSTATE such as 42P01, missing table; a Node code such as ERR_INVALID_URL), never the message,
 * which can carry query parameters, URLs or provider payloads.
 */
export function reportUnexpectedError(
  scope: "trading" | "chat" | "chat-quote" | "agent-review",
  error: unknown,
): void {
  const name = error instanceof Error ? error.name : typeof error;
  const fromCause = causeCode.safeParse(error);
  const own = ownCode.safeParse(error);
  const code = fromCause.success ? fromCause.data.cause.code : own.success ? own.data.code : null;
  process.emitWarning(`An unexpected ${scope} failure was shown to the user as a generic error.`, {
    code: "WRENAI_UNEXPECTED_ERROR",
    detail: `${scope}: ${name}${code === null ? "" : ` (${code})`}`,
  });
}
