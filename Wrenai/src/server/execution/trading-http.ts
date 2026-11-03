import "server-only";
import { parse } from "lossless-json";
import { ExecutionError } from "./contracts";

export async function tradingResponseJson(
  response: Response,
  maxBytes: number,
  exactNumbers = false,
): Promise<unknown> {
  if (!response.ok || !response.body) {
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
