import { z } from "zod";

const failureSchema = z.object({ ok: z.literal(false), message: z.string().max(400) });
const successSchema = z.object({ ok: z.literal(true), value: z.unknown() });
const UNREADABLE = "Trading data couldn't be loaded. Check your connection and refresh.";

async function body(path: string, signal: AbortSignal): Promise<unknown> {
  try {
    const response = await fetch(path, {
      signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    // A network failure or a non-JSON page (proxy error): the raw text means nothing to the user.
    throw new Error(UNREADABLE);
  }
}

/**
 * GET one of the trading read routes (src/app/api/trading) and parse its result. Polled reads use these instead of
 * Server Actions, which Next dispatches one at a time and which would hold navigation while they wait.
 */
export async function readTrading<S extends z.ZodType>(
  path: string,
  schema: S,
  signal: AbortSignal,
): Promise<z.output<S>> {
  const value = await body(path, signal);
  const failed = failureSchema.safeParse(value);
  if (failed.success) {
    throw new Error(failed.data.message);
  }
  const envelope = successSchema.safeParse(value);
  const parsed = envelope.success ? schema.safeParse(envelope.data.value) : null;
  if (!parsed?.success) {
    throw new Error(UNREADABLE);
  }
  return parsed.data;
}
