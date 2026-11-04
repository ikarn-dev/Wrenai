import "server-only";
import { parse } from "lossless-json";
import { z } from "zod";
import { nearAccountSchema } from "@/shared/agent-budget";
import { cachedSquint, cacheSquint, coolDownSquint, squintCooldown } from "./cache";
import {
  type SquintCoin,
  type SquintReport,
  SquintUnavailable,
  squintCoinsSchema,
  squintReportSchema,
  squintSearchSchema,
} from "./contracts";
import { consumeSquintQuota } from "./quota";

const BASE = "https://api.nearsquint.tech/v1";
interface PendingRead {
  readonly promise: Promise<unknown>;
  readonly controller: AbortController;
  readers: number;
}
const pending = new Map<string, PendingRead>();
const MAX_BODY = 2_000_000;
function retryAfterSeconds(value: string | null): number {
  if (value && /^\d{1,6}$/.test(value)) {
    return Math.min(604800, Math.max(60, Number(value)));
  }
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? Math.min(604800, Math.max(60, Math.ceil((time - Date.now()) / 1000))) : 60;
}
async function responseText(response: Response): Promise<string> {
  if (!response.body) {
    throw new SquintUnavailable("unavailable", "The risk provider returned no data.");
  }
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel();
        throw new SquintUnavailable("unavailable", "The risk report exceeded its size limit.");
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString("utf8");
}
async function providerRead(path: string, scan: boolean, signal?: AbortSignal): Promise<unknown> {
  if (await squintCooldown()) {
    throw new SquintUnavailable("limited", "Risk scans are cooling down. Try again shortly.");
  }
  const verdict = await consumeSquintQuota(scan);
  if (verdict !== "allowed") {
    throw new SquintUnavailable(
      verdict === "limited" ? "limited" : "unavailable",
      "The shared risk-scan budget is unavailable. No unmetered request was sent.",
    );
  }
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "wrenai/0.1" },
      signal: AbortSignal.any([AbortSignal.timeout(scan ? 32000 : 8000), ...(signal ? [signal] : [])]),
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 429) {
      await coolDownSquint(retryAfterSeconds(response.headers.get("retry-after")));
      throw new SquintUnavailable(
        "limited",
        "The risk provider rate limit was reached. Scans will resume after its cooldown.",
      );
    }
    if (response.status === 404) {
      throw new SquintUnavailable("not_found", "This exact token is not covered by the risk provider.");
    }
    if (!response.ok) {
      throw new SquintUnavailable(
        "unavailable",
        "The risk provider is unavailable. No safety result is assumed.",
      );
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new SquintUnavailable("unavailable", "The risk provider did not return JSON.");
    }
    const text = await responseText(response);
    return parse(text, null, (number: string) => number);
  } catch (error) {
    if (error instanceof SquintUnavailable) {
      throw error;
    }
    throw new SquintUnavailable("unavailable", "The risk scan could not complete. Try again shortly.");
  }
}
async function awaitRead(entry: PendingRead, signal?: AbortSignal): Promise<unknown> {
  entry.readers += 1;
  let abort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    if (!signal) {
      return await entry.promise;
    }
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([entry.promise, interrupted]);
  } finally {
    if (abort) {
      signal?.removeEventListener("abort", abort);
    }
    entry.readers -= 1;
    if (entry.readers === 0) {
      entry.controller.abort();
    }
  }
}
async function read<T>(path: string, scan: boolean, shape: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const cached = await cachedSquint(path);
  signal?.throwIfAborted();
  if (cached) {
    try {
      return shape.parse(parse(cached, null, (number: string) => number));
    } catch {
      throw new SquintUnavailable("unavailable", "The cached risk report could not be verified.");
    }
  }
  const running = pending.get(path);
  if (running) {
    return shape.parse(await awaitRead(running, signal));
  }
  if (pending.size >= 8) {
    throw new SquintUnavailable("pending", "Risk scans are busy. Try again shortly.");
  }
  const controller = new AbortController();
  const result = providerRead(path, scan, controller.signal)
    .then(async (value) => {
      shape.parse(value);
      // Keep lossless source decimals. Cache reads never replace the original checked_at.
      await cacheSquint(path, JSON.stringify(value), scan ? 30 : 15);
      return value;
    })
    .finally(() => pending.delete(path));
  const entry = { promise: result, controller, readers: 0 };
  pending.set(path, entry);
  return shape.parse(await awaitRead(entry, signal));
}
export async function squintCoins(signal?: AbortSignal): Promise<readonly SquintCoin[]> {
  const result = await read("/coins?sort=age&dir=desc&limit=100&offset=0", false, squintCoinsSchema, signal);
  return result.coins.toSorted(
    (a, b) => (b.created_at ? Date.parse(b.created_at) : 0) - (a.created_at ? Date.parse(a.created_at) : 0),
  );
}
export async function squintReport(token: string, signal?: AbortSignal): Promise<SquintReport> {
  const exact = nearAccountSchema.parse(token),
    report = await read(
      `/tokens/${encodeURIComponent(exact)}`,
      true,
      squintReportSchema.refine(
        (value) => value.token === exact && Date.parse(value.checked_at) <= Date.now() + 1000,
      ),
      signal,
    );
  if (report.token !== exact || Date.parse(report.checked_at) > Date.now() + 1000) {
    throw new SquintUnavailable(
      "unavailable",
      "The report has a different token identity or a future observation time.",
    );
  }
  return report;
}
/** Never accept Squint's automatic most-holder ticker resolution as an exact token choice. */
export async function squintToken(query: string, signal?: AbortSignal): Promise<string> {
  const normalized = z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._:@-]+$/)
    .parse(query);
  const contract = normalized.startsWith("nep141:") ? normalized.slice(7) : normalized;
  if (normalized.startsWith("nep141:") || contract.includes(".") || /^[a-f0-9]{64}$/.test(contract)) {
    return nearAccountSchema.parse(contract);
  }
  const result = await read(
    `/search?q=${encodeURIComponent(normalized)}&limit=25`,
    false,
    squintSearchSchema,
    signal,
  );
  const matches = result.results.filter((token) => token.symbol.toUpperCase() === normalized.toUpperCase());
  if (matches.length !== 1 || !matches[0]) {
    throw new SquintUnavailable(
      matches.length ? "ambiguous" : "not_found",
      matches.length
        ? "Several contracts use that ticker. Specify the exact token contract."
        : "No exact token match was found. Specify its contract.",
    );
  }
  return matches[0].token;
}
