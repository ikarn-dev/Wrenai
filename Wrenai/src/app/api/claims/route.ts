import { z } from "zod";
import { readClaims, refreshPrivateClaims } from "@/server/claims/pending";
import { database } from "@/server/db/client";
import { tradingRead } from "@/server/manual-trading/trading-action";
import type { ClaimsView } from "@/shared/claims";

export const runtime = "nodejs";

/** `?view=refresh` re-reads the private balance; the default view answers from recorded state at once. */
export async function GET(request: Request): Promise<Response> {
  return tradingRead<ClaimsView | { refreshed: boolean }>((userId, accountId) => {
    const view = z
      .enum(["list", "refresh"])
      .catch("list")
      .parse(new URL(request.url).searchParams.get("view"));
    return view === "refresh"
      ? refreshPrivateClaims(database(), userId)
      : readClaims(database(), userId, accountId, request.signal);
  });
}
