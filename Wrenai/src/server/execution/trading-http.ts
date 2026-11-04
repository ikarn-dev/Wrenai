import "server-only";
import { parse } from "lossless-json";
import { z } from "zod";
import { ExecutionError } from "./contracts";

const rejectionSchema = z.object({ message: z.union([z.string(), z.array(z.string())]) });

/**
 * Logs why a provider refused a request: the endpoint path, the HTTP status and the provider's own short
 * reason, server-side only (users see one stable line, Docs/LESSONS.md → third-party error text). Request
 * bodies, query strings and session headers are never logged; provider reasons describe the request shape.
 */
async function reportRejection(response: Response): Promise<void> {
  let reason = "no body";
  try {
    const text = (await response.text()).slice(0, 2_000);
    const parsed = rejectionSchema.safeParse(JSON.parse(text));
    reason = parsed.success ? [parsed.data.message].flat().join("; ").slice(0, 240) : "unrecognised body";
  } catch (error) {
    reason = error instanceof SyntaxError ? "non-JSON body" : "body unreadable";
  }
  const path = URL.canParse(response.url) ? new URL(response.url).pathname : "unknown path";
  process.emitWarning("A trading provider rejected a request.", {
    code: "WRENAI_PROVIDER_REJECTED",
    detail: `${path} ${response.status}: ${reason}`,
  });
}

export async function tradingResponseJson(
  response: Response,
  maxBytes: number,
  exactNumbers = false,
): Promise<unknown> {
  if (!response.ok || !response.body) {
    await reportRejection(response);
    throw new ExecutionError("not_ready", "The trading provider is unavailable or rejected the request.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ExecutionError("not_ready", "The trading response exceeded its size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const value: unknown = exactNumbers ? parse(text, null, (number: string) => number) : JSON.parse(text);
  return value;
}
