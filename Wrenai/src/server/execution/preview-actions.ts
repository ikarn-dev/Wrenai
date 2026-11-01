"use server";
import type { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentResult } from "@/shared/agents";
import {
  type AgentTradeAssets,
  agentAssetInputSchema,
  reviewAgentAssetsSchema,
  type TradeAsset,
  type TradePreview,
  tradePreviewInputSchema,
} from "@/shared/trade-preview";
import { readAgentTradeAssets, reviewAgentTradeAssets } from "./asset-review";
import {
  type BalanceChallenge,
  balanceSignatureSchema,
  completeBalanceSession,
  issueBalanceChallenge,
} from "./balance-session";
import { ExecutionError } from "./contracts";
import { createTradePreview, latestTradePreview } from "./preview";

async function previewAction<T>(
  kind: "read" | "quote" | "connect",
  run: (user: SessionUser) => Promise<T>,
): Promise<AgentResult<T>> {
  try {
    const user = await currentUser();
    if (!user) {
      throw new AgentError("signed_out", "Sign in to review agent trades.");
    }
    const rate = await consumeRateLimit(`execution:${kind}:${user.id}`, kind === "read" ? 30 : 6, 60_000);
    if (rate !== "allowed") {
      throw new AgentError(
        rate === "limited" ? "rate_limited" : "unavailable",
        rate === "limited"
          ? "Too many requests. Wait a minute and try again."
          : "Request protection is unavailable. Try again shortly.",
      );
    }
    return { ok: true, value: await run(user) };
  } catch (error) {
    if (error instanceof AgentError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof ExecutionError) {
      return {
        ok: false,
        code: error.code === "not_found" ? "not_found" : error.code === "conflict" ? "conflict" : "not_ready",
        message: error.message,
      };
    }
    return {
      ok: false,
      code: "unavailable",
      message: "The trade preview could not be completed. Check the connection and try again.",
    };
  }
}
function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new AgentError("invalid_input", result.error.issues[0]?.message ?? "Check the trade details.");
  }
  return result.data;
}
export async function loadAgentTradeAssets(raw: unknown): Promise<AgentResult<AgentTradeAssets>> {
  return previewAction("read", async (user) => {
    const value = input(agentAssetInputSchema, raw);
    return readAgentTradeAssets(database(), user.id, value.agentId, value.expectedRevision);
  });
}
export async function saveAgentTradeAssets(raw: unknown): Promise<AgentResult<readonly TradeAsset[]>> {
  return previewAction("read", (user) =>
    reviewAgentTradeAssets(database(), user.id, input(reviewAgentAssetsSchema, raw)),
  );
}
export async function previewAgentTrade(raw: unknown): Promise<AgentResult<TradePreview>> {
  return previewAction("quote", (user) =>
    createTradePreview(database(), user, input(tradePreviewInputSchema, raw)),
  );
}
export async function loadLatestTradePreview(raw: unknown): Promise<AgentResult<TradePreview | null>> {
  return previewAction("read", async (user) => {
    const value = input(agentAssetInputSchema, raw);
    return latestTradePreview(database(), user.id, value.agentId, value.expectedRevision);
  });
}
export async function requestPrivateBalanceConnection(): Promise<AgentResult<BalanceChallenge>> {
  return previewAction("connect", (user) => issueBalanceChallenge(database(), user));
}
export async function connectPrivateBalance(raw: unknown): Promise<AgentResult<null>> {
  return previewAction("connect", async (user) => {
    await completeBalanceSession(database(), user, input(balanceSignatureSchema, raw));
    return null;
  });
}
