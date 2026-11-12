import "server-only";
import { z } from "zod";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { instructionRouteTokens, instructionTradeAssets } from "@/server/execution/asset-review";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { NearRpcError } from "@/server/near/rpc";
import { MarketUnavailable } from "@/server/research/market-http";
import type { AgentResult, StrategyDraft } from "@/shared/agents";
import { AgentError, agentFailure } from "./errors";

/** The signed-in owner, rate-limited per kind of request. Stop is never rate-limited. */
export async function agentUser(kind: "parse" | "manage" | "stop"): Promise<SessionUser> {
  const user = await currentUser();
  if (user === null) {
    throw new AgentError("signed_out", "Sign in again to manage agents.");
  }
  if (kind !== "stop") {
    // Parses start on their own once setup inputs settle (components/agents/use-early-check.ts), so a user who edits
    // a few times in a minute needs more than the old four; still bounded per minute.
    const decision = await consumeRateLimit(`agents:${kind}:${user.id}`, kind === "parse" ? 10 : 30, 60_000);
    if (decision !== "allowed") {
      throw new AgentError(
        decision === "limited" ? "rate_limited" : "unavailable",
        decision === "limited"
          ? "Too many requests. Wait a minute and try again."
          : "Request protection is unavailable. Try again shortly.",
      );
    }
  }
  return user;
}

/** Runs an agent request and maps expected failures to a stable code instead of throwing. */
export async function agentAction<T>(run: () => Promise<T>): Promise<AgentResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof AgentError) {
      return agentFailure(error);
    }
    if (error instanceof ExecutionError) {
      return agentFailure(new AgentError("not_ready", error.message));
    }
    if (error instanceof MarketUnavailable || error instanceof NearRpcError) {
      return agentFailure(
        new AgentError(
          "unavailable",
          "Live market or NEAR data is temporarily unavailable. Try again shortly.",
        ),
      );
    }
    if (error instanceof z.ZodError) {
      return agentFailure(
        new AgentError("invalid_input", error.issues[0]?.message ?? "Check the form and try again."),
      );
    }
    throw error;
  }
}

/** The draft with its exact token metadata for review, when that metadata can be read now. */
export async function withAssets(draft: StrategyDraft): Promise<StrategyDraft> {
  if ("format" in draft.strategy) {
    try {
      const tokens = await instructionRouteTokens(draft.strategy);
      return { ...draft, assets: instructionTradeAssets(draft.strategy, tokens) };
    } catch (error) {
      if (
        !(
          error instanceof MarketUnavailable ||
          error instanceof z.ZodError ||
          error instanceof ExecutionError
        )
      ) {
        throw error;
      }
    }
  }
  return draft;
}
