import "server-only";
import { ExecutionError } from "./contracts";

export async function tradingResponseJson(response: Response, maxBytes: number): Promise<unknown> {
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
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value;
}
