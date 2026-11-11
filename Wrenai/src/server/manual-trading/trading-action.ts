import "server-only";
import { z } from "zod";
import { currentUser } from "@/server/auth/session";
import { serverEnv } from "@/server/env";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { reportUnexpectedError } from "@/server/http/unexpected-error";
import { NearRpcError } from "@/server/near/rpc";
import { MarketUnavailable } from "@/server/research/market-http";
import type { TradingResult } from "@/shared/manual-trading";

/** Signed in, rate-limited and mapped to a stable code: shared by the trading Server Actions and GET routes. */
export async function tradingAction<T>(
  run: (userId: string, accountId: string) => Promise<T>,
): Promise<TradingResult<T>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in before trading." };
  }
  const limit = await consumeRateLimit(`manual-trade:${user.id}`, 60, 60_000);
  if (limit !== "allowed") {
    return {
      ok: false,
      code: "rate_limited",
      message: "Too many trading requests. Wait a moment and retry.",
    };
  }
  try {
    return { ok: true, value: await run(user.id, user.accountId) };
  } catch (error) {
    if (error instanceof ExecutionError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        code: "invalid_input",
        message: error.issues[0]?.message ?? "Check the trade details.",
      };
    }
    if (error instanceof MarketUnavailable || error instanceof NearRpcError) {
      return {
        ok: false,
        code: "unavailable",
        message: "Live market or NEAR data is temporarily unavailable. Try again shortly.",
      };
    }
    reportUnexpectedError("trading", error);
    return {
      ok: false,
      code: "unavailable",
      message: "Trading is temporarily unavailable. Check the order status before retrying.",
    };
  }
}

function status(code: string): number {
  switch (code) {
    case "signed_out":
      return 401;
    case "invalid_input":
      return 400;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    default:
      return 503;
  }
}

/**
 * Reads the market pages poll go through GET routes, not Server Actions: Next dispatches Server Actions one at a
 * time per client, so polled reads would queue behind each other and hold navigation (Next 16 docs, Server
 * Actions → Sequential dispatch on the client).
 */
export async function tradingRead<T>(
  run: (userId: string, accountId: string) => Promise<T>,
): Promise<Response> {
  const result = await tradingAction(run);
  return Response.json(result, {
    status: result.ok ? 200 : status(result.code),
    headers: { "Cache-Control": "private, no-store" },
  });
}

const MAX_BODY_BYTES = 20_000;

/**
 * A same-origin JSON POST for a trading mutation. Route handlers, not Server Actions: a Server Action holds the
 * router while it runs, so the page behind a claim dialog showed "Rendering" for the whole quote.
 */
export async function tradingPost<T>(
  request: Request,
  run: (userId: string, accountId: string, body: unknown) => Promise<T>,
): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store" };
  const text = await request.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (
    request.headers.get("origin") !== serverEnv().appOrigin ||
    text.length > MAX_BODY_BYTES ||
    body === null
  ) {
    return Response.json(
      { ok: false, code: "invalid_input", message: "Open Wrenai and try again." },
      { status: 400, headers },
    );
  }
  const result = await tradingAction((userId, accountId) => run(userId, accountId, body));
  return Response.json(result, { status: result.ok ? 200 : status(result.code), headers });
}
