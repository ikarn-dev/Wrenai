import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { squintRedis } from "./cache";

// A single atomic sliding window avoids a double burst at fixed-window boundaries.
// Both sorted sets share a Redis hash slot; server TIME is authoritative across Vercel regions.
const RESERVE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 60000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - 60000)
if redis.call('ZCARD', KEYS[1]) >= 110 then return 0 end
if redis.call('ZCOUNT', KEYS[1], '(' .. (now - 10000), '+inf') >= 18 then return 0 end
if ARGV[1] == '1' and redis.call('ZCARD', KEYS[2]) >= 18 then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[2])
redis.call('PEXPIRE', KEYS[1], 60000)
if ARGV[1] == '1' then
  redis.call('ZADD', KEYS[2], now, ARGV[2])
  redis.call('PEXPIRE', KEYS[2], 60000)
end
return 1
`;
export async function consumeSquintQuota(scan: boolean): Promise<"allowed" | "limited" | "unavailable"> {
  const redis = squintRedis();
  if (!redis) {
    return "unavailable";
  }
  try {
    const result = z
      .union([z.literal(0), z.literal(1)])
      .parse(
        await redis.eval(
          RESERVE,
          ["wrenai:{squint}:requests:v1", "wrenai:{squint}:scans:v1"],
          [scan ? "1" : "0", randomUUID()],
        ),
      );
    return result === 1 ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}
