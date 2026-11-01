import "server-only";
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import {
  ExplorerFeedPending,
  type PublicSwapFeed,
  publicFeedSchema,
  publicSwapSchema,
} from "./explorer-contracts";
import { marketJson } from "./market-http";

/** Shared public data only. Postgres remains the authority for which leader events have been acted on. */
export async function publicLeaderFeed(): Promise<PublicSwapFeed> {
  const config = z
    .object({
      ONECLICK_EXPLORER_JWT: z.string().trim().min(1).max(8000),
      UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }),
      UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
    })
    .safeParse(process.env);
  if (!config.success) {
    throw new ExecutionError(
      "not_ready",
      "Copy Trading needs its Explorer credential and shared Redis cache.",
    );
  }
  const redis = new Redis({
    url: config.data.UPSTASH_REDIS_REST_URL,
    token: config.data.UPSTASH_REDIS_REST_TOKEN,
    retry: false,
    signal: () => AbortSignal.timeout(3000),
  });
  const identity = createHash("sha256").update(config.data.ONECLICK_EXPLORER_JWT).digest("hex");
  const key = `wrenai:explorer:near:v1:${identity}`;
  try {
    const raw = await redis.get<unknown>(key);
    if (raw !== null) {
      const cached = publicFeedSchema.parse(raw);
      if (Date.now() - cached.capturedAt < 5000 && cached.capturedAt <= Date.now()) {
        return cached;
      }
    }
    // One shared request window across scaled functions, not one request per follower or leader.
    const budget = await consumeRateLimit("1click-explorer:public-near-feed", 1, 5000);
    if (budget === "limited") {
      throw new ExplorerFeedPending();
    }
    if (budget !== "allowed") {
      throw new ExecutionError("not_ready", "The shared public activity request budget is unavailable.");
    }
    const response = await marketJson(
      "1Click Explorer",
      "https://explorer.near-intents.org/api/v0/transactions?numberOfTransactions=1000&fromChainId=near",
      { headers: { Authorization: `Bearer ${config.data.ONECLICK_EXPLORER_JWT}` } },
    );
    const feed = publicFeedSchema.parse({
      capturedAt: response.capturedAt,
      swaps: z.array(publicSwapSchema).max(1000).parse(response.value),
    });
    await redis.set(key, feed, { px: 5000 });
    return feed;
  } catch (error) {
    if (error instanceof ExecutionError) {
      throw error;
    }
    throw new ExecutionError("not_ready", "The public leader feed could not be refreshed or validated.");
  }
}
