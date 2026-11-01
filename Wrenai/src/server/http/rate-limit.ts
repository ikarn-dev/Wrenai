import "server-only";
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { headers } from "next/headers";
import { z } from "zod";

export type RateLimitDecision = "allowed" | "limited" | "unavailable";

// The count and expiry change atomically across every function instance. No financial state lives here.
const CONSUME_WINDOW = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[1]) then return 0 end
if count == 0 then
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[2])
else
  redis.call('INCR', KEYS[1])
end
return 1
`;

function client(): Redis | null {
  const config = z
    .object({
      UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }),
      UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
    })
    .safeParse(process.env);
  if (!config.success) {
    return null;
  }
  return new Redis({
    url: config.data.UPSTASH_REDIS_REST_URL,
    token: config.data.UPSTASH_REDIS_REST_TOKEN,
    retry: false,
    signal: () => AbortSignal.timeout(3_000),
  });
}

/** Infrastructure failure is explicit and fails closed; callers must not retry a protected action unmetered. */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitDecision> {
  const redis = client();
  if (redis === null) {
    return "unavailable";
  }
  try {
    const opaqueKey = createHash("sha256").update(key).digest("hex");
    const result = z
      .union([z.literal(0), z.literal(1)])
      .parse(await redis.eval(CONSUME_WINDOW, [`wrenai:rate:v1:${opaqueKey}`], [limit, windowMs]));
    return result === 1 ? "allowed" : "limited";
  } catch {
    // Provider responses can contain URLs and credentials; return a stable availability decision only.
    return "unavailable";
  }
}

/** Trust Vercel's overwritten forwarding header only on its runtime; other deployments share a strict bucket. */
export async function clientAddress(): Promise<string> {
  const { VERCEL } = process.env;
  if (VERCEL !== "1") {
    return "direct";
  }
  const forwarded = (await headers()).get("x-vercel-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "direct";
}
