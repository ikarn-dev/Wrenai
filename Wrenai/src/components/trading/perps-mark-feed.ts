import { z } from "zod";

const envelope = z.object({ channel: z.literal("fastAssetCtxs"), data: z.string().max(96_000) });
const price = z
  .string()
  .regex(/^\d{1,24}(?:\.\d{1,18})?$/)
  .refine((value) => Number(value) > 0);
const changes = z.record(z.string(), z.unknown());
const context = z.object({ markPx: price });
const MAX_FRAME_BYTES = 512_000;
const MAIN_MARKET = /^[A-Za-z0-9_-]{1,40}$/;

/** The venue sends an initial snapshot followed by raw-deflate base64 deltas. */
export async function readPerpsMarkFrame(raw: unknown): Promise<ReadonlyMap<string, string> | null> {
  if (typeof raw !== "string" || raw.length > 100_000) {
    return null;
  }
  const frame = envelope.safeParse(JSON.parse(raw));
  if (!frame.success) {
    return null;
  }
  const bytes = Uint8Array.from(atob(frame.data.data), (character) => character.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_FRAME_BYTES) {
        await reader.cancel();
        throw new Error("Perps mark frame exceeds its size limit.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const marks = new Map<string, string>();
  for (const [market, update] of Object.entries(changes.parse(JSON.parse(text + decoder.decode())))) {
    if (MAIN_MARKET.test(market)) {
      const parsed = context.safeParse(update);
      if (parsed.success) {
        marks.set(market, parsed.data.markPx);
      }
    }
  }
  return marks;
}
