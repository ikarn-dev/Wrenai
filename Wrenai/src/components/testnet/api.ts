import { z } from "zod";

/** A testnet request the server refused, with its HTTP status: 400 means the request itself needs changing. */
export class TestnetApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TestnetApiError";
  }
}
const envelope = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
/** POSTs a command, or GETs the snapshot (or another read view, such as `?view=performance&id=…`). */
export async function testnetApi(body?: unknown, search = "", signal?: AbortSignal): Promise<unknown> {
  const r = await fetch(`/api/testnet${search}`, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const unavailable =
    r.status === 404
      ? "The testnet API was not found. Reload the app after updating it."
      : "Could not load testnet. Try again shortly.";
  if (!r.headers.get("content-type")?.includes("application/json")) {
    throw new Error(unavailable);
  }
  let data: unknown;
  try {
    data = await r.json();
  } catch {
    throw new Error(unavailable);
  }
  const parsed = envelope.safeParse(data);
  if (!parsed.success) {
    throw new Error(unavailable);
  }
  if (!parsed.data.ok) {
    throw new TestnetApiError(r.status, parsed.data.message);
  }
  if (!r.ok) {
    throw new Error(unavailable);
  }
  return parsed.data.data;
}
