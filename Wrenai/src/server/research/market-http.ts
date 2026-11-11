import "server-only";
import { parse } from "lossless-json";

const MAX_BODY = 3_000_000;
// One entry per URL and body. Each caller states the oldest copy it accepts (cacheMs); an entry is kept for the
// longest age any caller asked for, so a display read with a long allowance never makes a trading read accept
// an older copy than its own limit.
const cache = new Map<
  string,
  {
    readonly value: unknown;
    readonly capturedAt: number;
    readonly expiresAt: number;
    readonly keepMs: number;
  }
>();
export class MarketUnavailable extends Error {
  constructor(readonly provider: string) {
    super(`${provider} data is unavailable.`);
    this.name = "MarketUnavailable";
  }
}
export interface MarketResponse {
  readonly value: unknown;
  readonly capturedAt: number;
}

/** Only fixed provider URLs reach this transport. Quotes and account reads use zero cache time. */
export async function marketJson(
  provider: string,
  url: string,
  options: {
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly cacheMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<MarketResponse> {
  const key = `${url}:${JSON.stringify(options.body ?? null)}`;
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(id);
    }
  }
  const maxAge = options.cacheMs ?? 0;
  const cached = maxAge > 0 ? cache.get(key) : undefined;
  if (cached && now - cached.capturedAt < maxAge) {
    return { value: cached.value, capturedAt: cached.capturedAt };
  }
  try {
    const response = await fetch(url, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        "User-Agent": "wrenai/0.1",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(options.signal ? [options.signal] : [])]),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok || response.body === null) {
      throw new MarketUnavailable(provider);
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
        if (size > MAX_BODY) {
          await reader.cancel();
          throw new MarketUnavailable(provider);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const value: unknown = parse(Buffer.concat(chunks).toString("utf8"), null, (number: string) => number);
    const capturedAt = Date.now();
    if (maxAge > 0) {
      const keepMs = Math.max(maxAge, cache.get(key)?.keepMs ?? 0);
      cache.delete(key);
      while (cache.size >= 12) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        cache.delete(oldest);
      }
      cache.set(key, { value, capturedAt, expiresAt: capturedAt + keepMs, keepMs });
    }
    return { value, capturedAt };
  } catch (error) {
    if (error instanceof MarketUnavailable) {
      throw error;
    }
    throw new MarketUnavailable(provider);
  }
}
