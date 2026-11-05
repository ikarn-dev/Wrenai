import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { tradingRead } from "@/server/manual-trading/trading-action";
import { readConnectedWalletValue } from "@/server/portfolio/valuation";
import { readWalletBalance } from "@/server/portfolio/wallet-balance";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return tradingRead(async (_userId, accountId) => {
    const view = z.enum(["balance", "value"]).parse(new URL(request.url).searchParams.get("view"));
    if (view === "balance") {
      const balance = await readWalletBalance(accountId, request.signal);
      if (balance.kind === "unavailable") {
        throw new ExecutionError("not_ready", "The NEAR balance could not be refreshed.");
      }
      return { yocto: balance.kind === "balance" ? balance.yocto.toString() : null, readAt: balance.readAt };
    }
    const value = await readConnectedWalletValue(accountId, request.signal);
    return {
      knownMicroUsd: value.knownMicroUsd.toString(),
      complete: value.complete,
      otherTokens: value.holdings.filter((holding) => holding.assetId !== "native:near").length,
    };
  });
}
